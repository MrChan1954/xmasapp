-- ===========================================================================
-- ROLLBACK FOR MIGRATION 053 -- FAMILY INVITATION CONSENT
-- ===========================================================================
--
-- READ ALL OF THIS BEFORE RUNNING ANY OF IT.
--
-- ###########################################################################
-- #                                                                         #
-- #  RUNNING THIS RESTORES THE SILENT AUTO-JOIN.                             #
-- #                                                                         #
-- #  `claim_app_member()` goes back to its 052 body: one UPDATE with no      #
-- #  `where id =`, called on EVERY sign-in and EVERY auth callback, which    #
-- #  claims every unclaimed invitation addressed to the caller's confirmed   #
-- #  address across EVERY family, with no consent step.                      #
-- #                                                                         #
-- #  So after this runs, anybody whose address has been typed into Family    #
-- #  Access becomes a member of that family the next time they sign in.      #
-- #  That is the defect 053 exists to fix. Rolling back is correct only if   #
-- #  053 itself has broken something worse.                                  #
-- #                                                                         #
-- #  DROPPING `declined_at` DESTROYS DECLINE HISTORY. Every invitation an    #
-- #  invitee refused becomes indistinguishable from one an administrator     #
-- #  revoked -- that ambiguity is precisely what the column was added to     #
-- #  remove, and no other column records it. The `audit_log` rows survive    #
-- #  (section 6 deletes none of them), so WHO declined and WHEN is still     #
-- #  readable there; what is lost is the current state of the seat.          #
-- #                                                                         #
-- #  TAKE THE BACKUP IN SECTION 0 FIRST. It costs one statement.             #
-- #                                                                         #
-- #  AND: any seat left `active = false, user_id is null, declined_at set`   #
-- #  will, after the column is dropped, read exactly like a revoked          #
-- #  invitation. An administrator re-inviting it is the correct repair.      #
-- #                                                                         #
-- ###########################################################################
--
-- WHAT THIS DOES NOT DO
--
--   It does not touch `supabase_migrations.schema_migrations`. If 053 has been
--   recorded as applied, it stays recorded: the migration history is a log of
--   what ran, not a description of the current schema.
--
--   It changes no family data. No person, membership, event, gift, purchase or
--   payment is created, altered or removed anywhere below. Memberships that
--   were ACCEPTED under 053 are left exactly as they are -- they are ordinary
--   claimed seats and 052's runtime reads them correctly.
--
--   It deletes no audit rows. `Joined <family>`, `Declined the invitation to
--   <family>` and `Invitation delivery recorded` all stay, because they record
--   things that really happened in a family.
--
-- ORDER MATTERS
--
--   The four new routines are dropped BEFORE the column they read, and the
--   redefinitions are restored BEFORE the drop, so no object is left pointing
--   at something that has gone.
--
-- REHEARSED, NOT ASSUMED
--   `scripts/family-invitations-rollback.test.mjs` runs this whole file against
--   a disposable PostgreSQL carrying 001-053, and then re-applies 053 on top of
--   the rolled-back database to prove the round trip.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. BACKUP FIRST. One statement, and the only recovery path for the decline
--    history section 5 destroys.
-- ---------------------------------------------------------------------------

create table if not exists public.app_members_053_backup as
select id, area_id, person_id, user_id, email, role, active, declined_at, created_at, updated_at
from public.app_members;


-- ---------------------------------------------------------------------------
-- 1. THE FOUR ROUTINES 053 ADDED
--
-- Dropped before the column they read.
-- ---------------------------------------------------------------------------

drop function if exists public.list_my_family_invitations();
drop function if exists public.accept_family_invitation(uuid);
drop function if exists public.decline_family_invitation(uuid);
drop function if exists public.record_invitation_delivery(uuid, text);


-- ---------------------------------------------------------------------------
-- 2. THE WRITE BARRIER, BACK TO 042
--
-- Migration 042's body, copied from
-- `supabase/migrations/202608100042_area_membership_lifecycle.sql`. The decline
-- exemption is gone; the claim exemption stays, because 042 is where it came
-- from and the restored `claim_app_member` needs it.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_foreign_area_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subject record;
  before_area uuid;
  after_area uuid;
begin
  if (select auth.uid()) is null then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'app_members' and tg_op = 'UPDATE' then
    if old.user_id is null
      and new.user_id = (select auth.uid())
      and new.area_id is not distinct from old.area_id
      and new.email is not null
      and lower(new.email) = lower((
        select auth_user.email from auth.users as auth_user
        where auth_user.id = (select auth.uid())
      ))
    then
      return new;
    end if;
  end if;

  if tg_op <> 'INSERT' then
    subject := old;
    before_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  if tg_op <> 'DELETE' then
    subject := new;
    after_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  if after_area is not null and not exists (
    select 1 from public.app_members m where m.area_id = after_area
  ) then
    return coalesce(new, old);
  end if;

  if before_area is not null and not public.is_area_member(before_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  if after_area is not null and not public.is_area_member(after_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. THE AUTO-JOIN, BACK
--
-- Migration 052's body, copied from
-- `supabase/migrations/202608100052_global_account_approval.sql` section 9d.
-- This is the statement in the warning at the top of this file.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_app_member();

create or replace function public.claim_app_member()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  claimed integer;
begin
  if caller is null then
    return false;
  end if;

  select lower(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = caller
    and auth_user.email_confirmed_at is not null;

  if caller_email is null or caller_email = '' then
    return false;
  end if;

  update public.app_members m
  set user_id = caller,
      updated_at = now()
  where lower(m.email) = caller_email
    and m.user_id is null
    and m.active = true
    and not exists (
      select 1
      from public.app_members mine
      where mine.area_id = m.area_id
        and mine.user_id = caller
    );

  get diagnostics claimed = row_count;
  return claimed > 0;
end;
$$;

revoke all on function public.claim_app_member() from public, anon;
grant execute on function public.claim_app_member() to authenticated;

comment on function public.claim_app_member() is
  'Attaches the caller to any invitation addressed to their CONFIRMED email address, in every '
  'Area, skipping any Area they are already in. Grants nothing by itself (052).';


-- ---------------------------------------------------------------------------
-- 4. THE ADMINISTRATOR'S ROUTINES, BACK TO 052
--
-- `grant_area_access` loses `declined_at = null`; `list_area_access` loses the
-- `declined_at` column and must be dropped first, because `create or replace`
-- cannot narrow a return type either.
-- ---------------------------------------------------------------------------

create or replace function public.grant_area_access(p_person_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_area uuid;
  normalised text;
  seat public.app_members%rowtype;
  linked_email text;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  target_area := public.area_of_person(p_person_id);
  if target_area is null then
    raise exception 'No such person' using errcode = 'P0002';
  end if;

  perform public.require_acting_area(target_area);

  if not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can give access'
      using errcode = '42501';
  end if;

  normalised := lower(btrim(coalesce(p_email, '')));
  if normalised = '' then
    raise exception 'An email address is needed' using errcode = '22023';
  end if;
  if length(normalised) < 3
     or length(normalised) > 254
     or normalised ~ '[[:space:][:cntrl:]]'
     or normalised !~ '^[^@]+@[^@]+\.[^@]+$' then
    raise exception 'That is not an email address we can invite' using errcode = '22023';
  end if;

  select * into seat
  from public.app_members m
  where m.person_id = p_person_id and m.area_id = target_area;

  if seat.id is not null and seat.role = 'admin' then
    raise exception 'The family administrator''s access is changed by handing over the family, not here'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.app_members m
    where m.area_id = target_area
      and lower(m.email) = normalised
      and (seat.id is null or m.id <> seat.id)
  ) then
    raise exception 'Somebody else in this family already uses that email address'
      using errcode = '23505';
  end if;

  if seat.id is null then
    insert into public.app_members (area_id, person_id, email, role, active)
    values (target_area, p_person_id, normalised, 'member', true);
    return;
  end if;

  if seat.user_id is null then
    update public.app_members
    set email = normalised, active = true, updated_at = now()
    where id = seat.id;
    return;
  end if;

  select lower(u.email) into linked_email
  from auth.users u
  where u.id = seat.user_id
    and u.email_confirmed_at is not null;

  if linked_email is null then
    raise exception 'The account holding this seat has no confirmed email address'
      using errcode = '42501';
  end if;

  if linked_email <> normalised then
    raise exception 'That seat already belongs to a different account. Remove its access first.'
      using errcode = '42501';
  end if;

  update public.app_members
  set email = normalised, active = true, updated_at = now()
  where id = seat.id;
end;
$$;

revoke all on function public.grant_area_access(uuid, text) from public, anon;
grant execute on function public.grant_area_access(uuid, text) to authenticated;

comment on function public.grant_area_access(uuid, text) is
  'Invites or restores one family member''s access, in the acting Area only, as that Area''s '
  'administrator. NEVER writes user_id: only claim_app_member attaches a login. Refuses the '
  'administrator''s own seat and any email that belongs to a different account (052).';


drop function if exists public.list_area_access();

create or replace function public.list_area_access()
returns table (
  person_id uuid,
  person_name text,
  app_member_id uuid,
  email text,
  role text,
  active boolean,
  claimed boolean,
  account_status text,
  email_confirmed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  acting uuid := public.acting_area();
begin
  if acting is null then
    raise exception 'Say which family you are working in.' using errcode = '42501';
  end if;

  if not public.is_area_admin(acting) then
    raise exception 'Only this family''s administrator can see who has access'
      using errcode = '42501';
  end if;

  return query
    select
      p.id,
      p.name,
      m.id,
      m.email,
      m.role,
      coalesce(m.active, false),
      (m.user_id is not null),
      case when m.user_id is null then null else coalesce(a.status, 'pending')::text end,
      case when m.user_id is null then null else (u.email_confirmed_at is not null) end
    from public.people p
    left join public.app_members m on m.person_id = p.id and m.area_id = acting
    left join auth.users u on u.id = m.user_id
    left join public.app_accounts a on a.user_id = m.user_id
    where p.area_id = acting
    order by p.name, p.id;
end;
$$;

revoke all on function public.list_area_access() from public, anon;
grant execute on function public.list_area_access() to authenticated;

comment on function public.list_area_access() is
  'Who can reach the ACTING Area, for that Area''s administrator only. No Area parameter and '
  'no email parameter, so it cannot be pointed at another family or used to probe whether an '
  'address has an account (052).';


-- ---------------------------------------------------------------------------
-- 5. THE COLUMN, THE CONSTRAINT AND THE INDEX
--
-- DESTRUCTIVE OF DECLINE HISTORY. Section 0's backup is the recovery path.
-- ---------------------------------------------------------------------------

drop index if exists public.app_members_open_invitation_idx;

alter table public.app_members
  drop constraint if exists app_members_declined_is_unclaimed;

alter table public.app_members
  drop column if exists declined_at;


-- ---------------------------------------------------------------------------
-- 6. WHAT IS DELIBERATELY LEFT ALONE
--
--   * every `audit_log` row 053's routines wrote -- they record real events;
--   * every membership accepted through `accept_family_invitation` -- those are
--     ordinary claimed seats and 052's runtime reads them correctly;
--   * `supabase_migrations.schema_migrations`;
--   * `public.app_members_053_backup`, which is left in place on purpose. Drop
--     it by hand once the decline history is no longer wanted.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 7. VERIFY. One SELECT, read the first column.
-- ---------------------------------------------------------------------------

select * from (
  select
    case when not exists (
      select 1 from pg_attribute
      where attrelid = 'public.app_members'::regclass and attname = 'declined_at' and not attisdropped
    ) then 'PASS' else 'FAIL' end as result,
    'declined_at is gone' as check_name

  union all
  select
    case when not exists (
      select 1 from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('list_my_family_invitations', 'accept_family_invitation',
                      'decline_family_invitation', 'record_invitation_delivery')
    ) then 'PASS' else 'FAIL' end,
    'all four 053 routines are gone'

  union all
  select
    case when not exists (
      select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'app_members_open_invitation_idx'
    ) then 'PASS' else 'FAIL' end,
    'the partial invitation index is gone'

  union all
  select
    case when exists (
      select 1 from pg_proc where proname = 'claim_app_member'
      and pronamespace = 'public'::regnamespace
      and pg_get_functiondef(oid) like '%update public.app_members%'
    ) then 'PASS' else 'FAIL' end,
    'claim_app_member claims again (this is the auto-join returning)'

  union all
  select
    case when not exists (
      select 1 from pg_proc where proname = 'refuse_foreign_area_write'
      and pronamespace = 'public'::regnamespace
      and pg_get_functiondef(oid) like '%declined_at%'
    ) then 'PASS' else 'FAIL' end,
    'the barrier no longer carries the decline branch'

  union all
  select
    case when (select count(*) from pg_proc where proname = 'list_area_access'
               and pronamespace = 'public'::regnamespace) = 1
    then 'PASS' else 'FAIL' end,
    'list_area_access exists exactly once'

  union all
  select
    case when (select count(*) from public.app_members)
              = (select count(*) from public.app_members_053_backup)
    then 'PASS' else 'FAIL' end,
    'no membership row was created or destroyed by the rollback'

  union all
  select 'INFO',
    'decline history preserved in public.app_members_053_backup: '
    || (select count(*)::text from public.app_members_053_backup where declined_at is not null)
    || ' declined invitation(s)'
) checks
order by case result when 'FAIL' then 0 when 'REVIEW' then 1 else 2 end, check_name;
