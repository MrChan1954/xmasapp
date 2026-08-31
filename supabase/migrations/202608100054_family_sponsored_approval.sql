-- ===========================================================================
-- MIGRATION 054 -- FAMILY-SPONSORED ACCOUNT APPROVAL
-- ===========================================================================
--
-- WHAT CHANGES, IN ONE SENTENCE
--
--   Accepting a family's invitation approves your Gift Planner account, because
--   the family that invited you is the one that vouched for you.
--
-- WHY THIS EXISTS
--
--   052 put a global approval gate above every Area, and it is right for the
--   front door: a stranger who signs up at `/sign-up` is nobody's
--   responsibility until a Gift Planner administrator says so. But it treats
--   every arrival as a stranger, and one kind of arrival is not:
--
--       Ben administers Tricketts. Ben invites his sister. His sister sets up
--       her account and accepts. And then she waits -- for a platform
--       administrator who has never met her, cannot verify anything about her,
--       and whose only real basis for a decision is that Ben already made one.
--
--   That is the wrong authority in the wrong place. It does not scale, and the
--   person it asks to decide knows least. So this migration moves the decision
--   to the two people who actually have standing:
--
--       FAMILY ADMIN INVITES  +  INVITEE ACCEPTS  =  approved account
--
--   Both halves are required and neither is new. `grant_area_access` already
--   proves the first: only an Area's own administrator may issue an invitation,
--   and only into their own Area. `accept_family_invitation` already proves the
--   second: only the owner of the confirmed address it is addressed to may take
--   it. 054 does not add an authority -- it stops discarding one that was
--   already established.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--
--   * PUBLIC SIGN-UP STILL WAITS. An account with no accepted invitation is
--     `pending` and a Gift Planner administrator decides it, exactly as before.
--   * REJECTED AND SUSPENDED ARE UNTOUCHABLE. 053 already refuses them before
--     anything is written, and this migration adds no path around that. An
--     invitation cannot launder a decision a human took about an account.
--   * NOBODY BECOMES A GLOBAL ADMINISTRATOR. `is_global_admin` is written
--     `false` on insert and left alone on update, and the CHECK constraint
--     `app_accounts_admin_must_be_approved` was never the thing standing in the
--     way anyway.
--   * SPONSORSHIP GRANTS ONE FAMILY, not the installation. The membership this
--     approves is the one seat that was accepted; every other Area still asks
--     `is_area_member` for itself.
--
-- WHY IT IS ONE ROUTINE AND NOT TWO CALLS
--
--   A runtime that claimed the seat and then approved the account would have a
--   state between the two: joined but not approved, and no way to tell that
--   apart from "joined while genuinely pending". Both writes live in one
--   plpgsql body, which is one transaction, so there is no such instant.
--
--   It also means the client cannot ask for approval. There is no parameter for
--   a user id, an Area, an inviter or a status anywhere in this contract -- the
--   caller is `auth.uid()`, the address comes from `auth.users`, and the Area
--   comes from the seat the invitation names. A browser can choose WHICH
--   invitation to accept, and nothing else.
--
-- THE SHAPE OF THE CHANGE
--
--   One routine is redefined. `accept_family_invitation` gains a block between
--   the membership write and its audit entry, and nothing else in the file
--   moves. No table, no column, no policy, no grant, no trigger.
--
-- ROLLBACK
--
--   `docs/Q21-054-ROLLBACK.sql` restores 053's body verbatim. It cannot undo
--   approvals already granted -- and should not: an account approved by
--   sponsorship is approved, and demoting people because a routine was reverted
--   would be a worse outcome than the routine. The rollback stops FUTURE
--   sponsorship and leaves the past alone, which is the honest thing a rollback
--   of this can do.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. ACCEPTING AN INVITATION, WHICH NOW ALSO SETTLES THE ACCOUNT
--
-- 053's body, with ONE block added and nothing else altered. The added block is
-- marked; everything around it is unchanged and is repeated here because
-- `create or replace function` replaces the whole body.
-- ---------------------------------------------------------------------------

create or replace function public.accept_family_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  account_status text;
  seat public.app_members%rowtype;
  family_name text;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select lower(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = caller
    and auth_user.email_confirmed_at is not null;

  if caller_email is null or caller_email = '' then
    raise exception 'Confirm your email address first' using errcode = '42501';
  end if;

  -- A missing row is `pending`, exactly as `my_account_status()` reports it.
  select coalesce(a.status, 'pending') into account_status
  from public.app_accounts a
  where a.user_id = caller;
  account_status := coalesce(account_status, 'pending');

  -- UNCHANGED, AND LOAD-BEARING FOR 054. Refusal comes BEFORE any write, so a
  -- rejected or suspended account cannot reach the sponsorship block below. An
  -- invitation may vouch for somebody nobody has decided about; it may not
  -- overturn a decision somebody made.
  if account_status in ('rejected', 'suspended') then
    raise exception 'This account cannot join a family' using errcode = '42501';
  end if;

  -- THE ID SELECTS. THE ADDRESS AUTHORIZES. Every conjunct below is part of the
  -- selection, so failing any of them lands on the one refusal sentence.
  select * into seat
  from public.app_members m
  where m.id = p_invitation_id
    and m.user_id is null
    and m.active = true
    and m.declined_at is null
    and lower(m.email) = caller_email
    and not exists (
      select 1 from public.app_members mine
      where mine.area_id = m.area_id
        and mine.user_id = caller
    );

  if seat.id is null then
    raise exception 'That invitation is not yours.' using errcode = '42501';
  end if;

  select a.name into family_name from public.areas a where a.id = seat.area_id;

  -- EXACTLY TWO COLUMNS. Not `role`, not `contributor_id`, not `person_id`, not
  -- `area_id`, not `active`, and nothing in any other table. This is the shape
  -- 042's barrier exemption permits, and the reason it is permitted.
  update public.app_members
  set user_id = caller,
      updated_at = now()
  where id = seat.id;

  -- =======================================================================
  -- MIGRATION 054 BEGINS. Everything above and below is 053's, unchanged.
  -- =======================================================================
  --
  -- THE SPONSORSHIP, AND THE THREE THINGS IT WILL NOT DO.
  --
  --   IT WILL NOT TOUCH AN APPROVED ACCOUNT. Already approved is already
  --   approved: re-stamping `decided_at` would overwrite a real administrator's
  --   decision with a machine's, and writing a second audit row would make the
  --   log say a decision was taken when none was.
  --
  --   IT WILL NOT REACH A REJECTED OR SUSPENDED ONE. Those raised above, before
  --   the seat was even selected.
  --
  --   IT WILL NOT GRANT ADMINISTRATION. `is_global_admin` is `false` on insert
  --   and untouched on update.
  --
  -- SO THIS RUNS FOR EXACTLY ONE CASE: an account that is `pending`, or that
  -- has no row at all -- which 052 defines as the same thing, and which is what
  -- every brand-new invited account is.
  --
  -- `decided_by` IS NULL, AND THAT IS THE HONEST VALUE. No human took this
  -- decision at this moment: the family administrator took it when they issued
  -- the invitation, and the invitee took it when they accepted. Naming either
  -- one as the deciding administrator would claim a global act neither
  -- performed -- the inviter is not a Gift Planner administrator, and the
  -- invitee must never appear to have approved themselves. The column comment
  -- already documents null as "no actor"; the provenance is written in full in
  -- the audit entry below, where it can say more than one uuid.
  if account_status = 'pending' then
    insert into public.app_accounts as a
      (user_id, status, is_global_admin, decided_at, decided_by, decision_note, updated_at)
    values
      (caller, 'approved', false, now(), null,
       'Approved by family invitation sponsorship', now())
    on conflict (user_id) do update
      set status        = 'approved',
          decided_at    = now(),
          decided_by    = null,
          decision_note = 'Approved by family invitation sponsorship',
          updated_at    = now()
      -- BELT AND BRACES AGAINST A RACE. `account_status` was read earlier in
      -- this transaction; if anything decided the account in between, this
      -- refuses to overwrite it. Only `pending` may be sponsored, and the row
      -- as it stands at write time is what decides.
      where a.status = 'pending';

    -- THE PROVENANCE, IN THE VOCABULARY THE LOG ALREADY HAS.
    --
    -- `decided` on `app_accounts` is precisely what `set_account_status` writes
    -- for a manual approval, and this IS an account decision -- so it belongs
    -- in the same shape, discoverable by the same query, rather than in a new
    -- word invented for it. What tells the two apart is `details.source`.
    --
    -- `area_id` IS NULL, and must be. `stamp_audit_area` (052 section 9)
    -- refuses to put an Area on an `app_accounts` row, because a global
    -- decision is not a family event and this entry is read through the global
    -- policy rather than any family's activity log. The sponsoring Area is
    -- therefore recorded in `details`, where it is attributable without
    -- pretending the row belongs to that family.
    --
    -- NOTHING SECRET. The seat id and the Area id are already known to both
    -- parties. No address, no link, no token, no password, no session.
    insert into public.audit_log (
      table_name, record_id, action, actor_user_id, actor_name,
      summary, subject, context, amount_pennies, details,
      area_id, celebrant_person_id, birthday_privacy_unknown
    ) values (
      'app_accounts', caller, 'decided', caller, null,
      'Global account set to approved',
      null, null, null,
      jsonb_build_object(
        'status', 'approved',
        'note', 'Approved by family invitation sponsorship',
        'source', 'family_invitation',
        'sponsor_area_id', seat.area_id,
        'sponsor_app_member_id', seat.id
      ),
      null, null, false
    );
  end if;
  -- =======================================================================
  -- MIGRATION 054 ENDS.
  -- =======================================================================

  -- `record_audit_event` does not fire for this: it reports an UPDATE only when
  -- it crosses the `active` boundary, and accepting does not. So the event is
  -- written here or it is not written at all.
  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_members', seat.id, 'added', caller, null,
    format('Joined %s', coalesce(family_name, 'the family')),
    null, null, null, '{}'::jsonb,
    seat.area_id, null, false
  );

  return seat.area_id;
end;
$$;

revoke all on function public.accept_family_invitation(uuid) from public, anon;
grant execute on function public.accept_family_invitation(uuid) to authenticated;

comment on function public.accept_family_invitation(uuid) is
  'Turns ONE named invitation into a membership, for the account whose own confirmed email '
  'address it is addressed to, AND approves that Gift Planner account when it was pending -- '
  'because an Area administrator issuing the invitation and the invitee accepting it are the '
  'two halves of a sponsorship. The id is a selector, never a credential. Never approves a '
  'rejected or suspended account, never re-decides an approved one, and never grants global '
  'administration. Public sign-up with no accepted invitation still waits for a Gift Planner '
  'administrator (054).';


-- ---------------------------------------------------------------------------
-- 2. WHAT MUST BE TRUE AFTERWARDS
--
-- Run at the end of the apply, in the same transaction, so a migration that
-- did not achieve what it claims fails loudly rather than reporting success.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := '{}';
  body text;
begin
  select pg_get_functiondef(oid) into body
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname = 'accept_family_invitation';

  if body is null then
    problems := problems || 'accept_family_invitation is missing'::text;
  else
    if body not like '%family_invitation%' then
      problems := problems || 'the sponsorship provenance is not recorded'::text;
    end if;
    if body not like '%app_accounts%' then
      problems := problems || 'accept_family_invitation does not settle the account'::text;
    end if;
    -- The refusal that keeps a decided account decided has to still be there.
    if body not like '%rejected%' or body not like '%suspended%' then
      problems := problems || 'the rejected/suspended refusal is gone'::text;
    end if;
    -- And it must not have grown a way to hand out administration.
    if body like '%is_global_admin = true%' then
      problems := problems || 'accept_family_invitation can grant global administration'::text;
    end if;
  end if;

  -- The routine stays SECURITY DEFINER with an empty search path, like every
  -- other routine 052 and 053 added.
  if not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'accept_family_invitation'
      and p.prosecdef
      -- Matched as text rather than by array containment: PostgreSQL stores the
      -- empty search path as the element `search_path=`, and quoting it exactly
      -- is a detail this check has no business depending on.
      and array_to_string(p.proconfig, ',') like 'search_path=%'
  ) then
    problems := problems || 'accept_family_invitation is not a pinned SECURITY DEFINER'::text;
  end if;

  -- 054 writes no rows of its own. Nobody should be approved by it yet.
  if exists (
    select 1 from public.app_accounts
    where decision_note = 'Approved by family invitation sponsorship'
  ) then
    problems := problems || 'sponsored approvals already exist -- 054 grants none itself'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'MIGRATION 054 DID NOT ACHIEVE ITS PURPOSE: %', array_to_string(problems, '; ');
  end if;
end;
$$;
