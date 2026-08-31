-- ===========================================================================
-- ROLLBACK FOR MIGRATION 052 -- GLOBAL ACCOUNT APPROVAL
-- ===========================================================================
--
-- READ ALL OF THIS BEFORE RUNNING ANY OF IT.
--
-- ###########################################################################
-- #                                                                         #
-- #  RUNNING THIS REOPENS THE FRONT DOOR.                                    #
-- #                                                                         #
-- #  1. `create_area` goes back to accepting ANY signed-in account. If       #
-- #     public sign-up is enabled, anybody on the internet can create a      #
-- #     family and make themselves its administrator.                        #
-- #                                                                         #
-- #  2. `claim_app_member` goes back to believing an UNCONFIRMED email.      #
-- #     Signing up as somebody else's address is then enough to walk into    #
-- #     the family that invited them.                                        #
-- #                                                                         #
-- #  SO: BEFORE running this, `/sign-up` must be unreachable and Supabase    #
-- #  Auth sign-up must be disabled again. A rollback with public sign-up     #
-- #  still live is strictly worse than the problem it is undoing.            #
-- #                                                                         #
-- #  3. DROPPING `app_accounts` DESTROYS EVERY APPROVAL DECISION. Who was    #
-- #     approved, who was rejected, who was suspended, who decided and why.  #
-- #     None of it is recoverable from the audit log, because the audit rows #
-- #     name a user id and a status, not the table's whole state -- and      #
-- #     section 6 deletes those rows too.                                    #
-- #                                                                         #
-- #     TAKE THE BACKUP IN SECTION 0 FIRST. It costs one statement.          #
-- #                                                                         #
-- ###########################################################################
--
-- WHAT THIS DOES NOT DO
--
--   It does not touch `supabase_migrations.schema_migrations`. If 052 has been
--   recorded as applied, it stays recorded: the migration history is a log of
--   what ran, not a description of the current schema, and editing it to tell a
--   different story is how a database and its repository stop agreeing.
--
--   It changes no family data. No person, membership, event, gift, purchase or
--   payment is created, altered or removed anywhere below. The only rows it
--   deletes are `app_accounts` (with the table) and the global `app_accounts`
--   entries in `audit_log`, which belong to no family.
--
-- REHEARSED, NOT ASSUMED
--
--   `scripts/global-approval-rollback.test.mjs` runs this file against a real
--   PostgreSQL carrying 001-052 and then asserts that the schema is
--   indistinguishable from one carrying 001-051: same routine bodies, same
--   policies, same constraint, same grants. It also asserts that 052 applies
--   again cleanly afterwards.
--
-- ORDER MATTERS, AND IT IS THE REVERSE OF 052
--
--   The policies are dropped BEFORE the functions they name, and the nine
--   routines are put back BEFORE `is_globally_approved` is dropped -- otherwise
--   `drop ... restrict` refuses, correctly, because something still depends on
--   it. If a statement below fails with "cannot drop ... because other objects
--   depend on it", something outside this file started using 052's routines.
--   STOP AND FIND OUT WHAT. Do not reach for CASCADE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. BEFORE THE DESTRUCTIVE PART -- take the decisions with you
--
-- Optional only in the sense that nothing enforces it. Run it.
-- ---------------------------------------------------------------------------

-- create table if not exists public.app_accounts_rollback_backup as
--   select *, now() as backed_up_at from public.app_accounts;
--
-- Read it back afterwards with:
--   select * from public.app_accounts_rollback_backup order by created_at;
--
-- And when the decisions are safely elsewhere:
--   drop table public.app_accounts_rollback_backup;


-- ---------------------------------------------------------------------------
-- 1. THE POLICIES, back to their 051 form
--
-- First, because they name the two functions section 5 drops.
-- ---------------------------------------------------------------------------

drop policy if exists "global admins read global account decisions" on public.audit_log;

drop policy if exists "active members may read own membership" on public.app_members;
create policy "active members may read own membership"
  on public.app_members
  for select
  using (user_id = (select auth.uid()) and active = true);


-- ---------------------------------------------------------------------------
-- 2. THE NINE REDEFINED ROUTINES, back to their 051 bodies
--
-- Byte for byte what `pg_get_functiondef` returned on a 001-051 database, with
-- only the dollar-quoting normalised. Nothing is "roughly restored" here.
-- ---------------------------------------------------------------------------

create or replace function public.is_active_app_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members
    where user_id = (select auth.uid())
      and active = true
  );
$$;

create or replace function public.is_area_member(p_area_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
  );
$$;

create or replace function public.is_area_admin(p_area_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
      and m.role = 'admin'
  );
$$;

create or replace function public.is_own_app_member(p_app_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    where m.id = p_app_member_id
      and m.user_id = (select auth.uid())
      and m.active = true
  );
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.acting_area() is not null then public.is_area_admin(public.acting_area())
    else exists (
      select 1
      from public.app_members m
      where m.user_id = (select auth.uid())
        and m.active = true
        and m.role = 'admin'
        and (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
    )
  end;
$$;

create or replace function public.is_area_contributor_member(p_area_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    join public.people p on p.id = m.person_id
    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
      -- The person really is in the Area the membership claims. 035's guard
      -- makes this true for every row it has seen; asserting it here means a
      -- row that predates the guard cannot borrow a permission with it.
      and p.area_id = p_area_id
      and p.is_family_contributor
  );
$$;

create or replace function public.create_area(p_name text, p_person_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  new_area uuid;
  new_person uuid;
begin
  if caller is null then
    raise exception 'You must be signed in to create an Area' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'An Area needs a name' using errcode = '22023';
  end if;

  if p_person_name is null or length(trim(p_person_name)) = 0 then
    raise exception 'Tell us your name so the family knows who you are' using errcode = '22023';
  end if;

  select u.email into caller_email from auth.users u where u.id = caller;

  insert into public.areas (name) values (trim(p_name)) returning id into new_area;

  insert into public.people (name, area_id, is_family_contributor)
  values (trim(p_person_name), new_area, true)
  returning id into new_person;

  insert into public.app_members (user_id, email, person_id, role, active, area_id)
  values (caller, caller_email, new_person, 'admin', true, new_area);

  return new_area;
end;
$$;

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
  where auth_user.id = caller;

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

create or replace function public.stamp_audit_area()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_areas uuid[];
begin
  if new.area_id is not null then
    return new;
  end if;

  -- 1. The record itself. Exact, and the only one of the three that is derived
  --    from data rather than from what the caller said. Null after a DELETE,
  --    and null for `people_birthday`, which is not a table.
  new.area_id := public.area_of_record(new.table_name, new.record_id);
  if new.area_id is not null then
    return new;
  end if;

  -- 2. Where the writer said they were standing, which `claim_active_area` and
  --    `act_in_area` both refuse to set unless `is_area_member` passes. For a
  --    guarded routine this is the same Area `require_acting_area` has already
  --    demanded the record belong to, so the deletion and its audit entry
  --    cannot disagree.
  new.area_id := public.acting_area();
  if new.area_id is not null then
    return new;
  end if;

  -- 3. One membership, or none of our business. An actor in two is not guessed
  --    at -- unchanged from 037, and still the last word.
  if new.actor_user_id is not null then
    select array_agg(distinct m.area_id) into actor_areas
    from public.app_members m
    where m.user_id = new.actor_user_id and m.active = true;

    if array_length(actor_areas, 1) = 1 then
      new.area_id := actor_areas[1];
    end if;
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. THE GLOBAL AUDIT ROWS
--
-- Deleted BEFORE the action vocabulary is narrowed again, because 'decided',
-- 'granted' and 'revoked' would otherwise be values the CHECK cannot accept and
-- yet rows still hold. `audit_log` is append-only by design, so this is the one
-- deletion in this file and it is confined to rows that belong to no family:
-- `table_name = 'app_accounts'`, `area_id is null`.
--
-- If you want to keep them, take the copy first:
--   create table public.app_accounts_audit_backup as
--     select * from public.audit_log where table_name = 'app_accounts';
-- ---------------------------------------------------------------------------

delete from public.audit_log
where table_name = 'app_accounts'
  and area_id is null;


-- ---------------------------------------------------------------------------
-- 4. THE ACTION VOCABULARY, back to the four words 041 left
-- ---------------------------------------------------------------------------

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action in ('added', 'removed', 'restored', 'handover'));


-- ---------------------------------------------------------------------------
-- 5. THE TEN NEW ROUTINES
--
-- RESTRICT, never CASCADE. If one of these refuses to drop, something depends
-- on it that this file does not know about, and finding out what that is
-- matters more than finishing the rollback.
-- ---------------------------------------------------------------------------

drop function if exists public.list_area_access() restrict;
drop function if exists public.revoke_area_access(uuid, boolean) restrict;
drop function if exists public.grant_area_access(uuid, text) restrict;
drop function if exists public.revoke_global_admin(uuid) restrict;
drop function if exists public.grant_global_admin(uuid) restrict;
drop function if exists public.set_account_status(uuid, text, text) restrict;
drop function if exists public.list_accounts(text) restrict;
drop function if exists public.my_account_status() restrict;
drop function if exists public.is_global_admin() restrict;
drop function if exists public.is_globally_approved() restrict;


-- ---------------------------------------------------------------------------
-- 6. THE TABLE
--
-- ============ THIS IS THE DESTRUCTIVE STATEMENT. ============
-- Every approval, rejection, suspension and appointment goes with it.
-- Section 0's backup is the only thing that brings them back.
-- ---------------------------------------------------------------------------

drop table if exists public.app_accounts restrict;


-- ---------------------------------------------------------------------------
-- 7. END STATE
--
-- Refuses to report success unless the schema really is back where it was.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
begin
  if to_regclass('public.app_accounts') is not null then
    problems := problems || 'public.app_accounts still exists'::text;
  end if;

  foreach fn in array array[
    'public.is_globally_approved()',
    'public.is_global_admin()',
    'public.my_account_status()',
    'public.list_accounts(text)',
    'public.set_account_status(uuid, text, text)',
    'public.grant_global_admin(uuid)',
    'public.revoke_global_admin(uuid)',
    'public.grant_area_access(uuid, text)',
    'public.revoke_area_access(uuid, boolean)',
    'public.list_area_access()'
  ] loop
    if to_regprocedure(fn) is not null then
      problems := problems || format('%s still exists', fn)::text;
    end if;
  end loop;

  -- The seven no longer mention the gate.
  foreach fn in array array[
    'public.is_active_app_member()',
    'public.is_area_member(uuid)',
    'public.is_area_admin(uuid)',
    'public.is_own_app_member(uuid)',
    'public.is_app_admin()',
    'public.is_area_contributor_member(uuid)',
    'public.create_area(text, text)'
  ] loop
    if position('is_globally_approved' in pg_get_functiondef(fn::regprocedure)) > 0 then
      problems := problems || format('%s still calls is_globally_approved', fn)::text;
    end if;
  end loop;

  if position('email_confirmed_at' in pg_get_functiondef('public.claim_app_member()'::regprocedure)) > 0 then
    problems := problems || 'claim_app_member still requires a confirmed email'::text;
  end if;

  if position('app_accounts' in pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0 then
    problems := problems || 'stamp_audit_area still has 052''s early return'::text;
  end if;
  -- And 049's logic is still in it.
  if position('public.acting_area()' in pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) = 0 then
    problems := problems || 'stamp_audit_area lost migration 049''s acting-Area step'::text;
  end if;

  if exists (
    select 1 from pg_policy
    where polrelid = 'public.audit_log'::regclass
      and polname = 'global admins read global account decisions'
  ) then
    problems := problems || 'the global audit policy still exists'::text;
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.app_members'::regclass
      and polname = 'active members may read own membership'
      and position('is_globally_approved' in pg_get_expr(polqual, polrelid)) = 0
  ) then
    problems := problems || 'the app_members own-row policy was not restored'::text;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_log'::regclass
      and conname = 'audit_log_action_check'
      and position('decided' in pg_get_constraintdef(oid)) > 0
  ) then
    problems := problems || 'audit_log.action still allows 052''s three words'::text;
  end if;

  if exists (select 1 from public.audit_log where table_name = 'app_accounts') then
    problems := problems || 'global account audit rows remain'::text;
  end if;

  if array_length(problems, 1) is null then
    raise notice
      'ROLLBACK COMPLETE. 052 is undone. create_area now accepts any signed-in account and '
      'claim_app_member believes an unconfirmed email -- PUBLIC SIGN-UP MUST BE OFF.';
  else
    raise exception 'The 052 rollback did not reach its end state: %', array_to_string(problems, '; ');
  end if;
end;
$$;
