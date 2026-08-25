-- Leaving a family, and joining one you were actually invited to.
--
-- TWO THINGS THE MEMBERSHIP MODEL STILL COULD NOT DO.
--
--   1. NOBODY COULD LEAVE. `app_members` has SELECT policies and no others, so
--      every membership write goes through a SECURITY DEFINER routine or the
--      service role -- and there was no routine for "I am done with this
--      family". The only way out was to ask the administrator to disable you,
--      which is a different thing said by a different person.
--
--   2. `claim_app_member` COULD LOCK ITSELF OUT. It claims every pending
--      invitation matching the caller's email, in one statement, across every
--      Area. Migration 035 made one login unique PER AREA, so if any of those
--      invitations is for a family the login is ALREADY in, the statement
--      violates that index -- and takes every other family's perfectly good
--      invitation down with it. One stale duplicate invite could stop somebody
--      joining a different household entirely.
--
-- WHAT LEAVING MEANS HERE
--   Deactivation, never deletion. A membership carries who somebody is in that
--   family, and their person carries their birthday, their gifts, their share of
--   the money and years of history. Removing app access is a statement about a
--   LOGIN. Nothing about the person, their history or the family's money is
--   touched, and the row survives so that reactivating restores the same
--   membership rather than inventing a second one.
--
-- WHO MAY NOT LEAVE
--   The administrator, while they are still the administrator. Migration 041
--   made handing over possible, so this is now a real instruction rather than a
--   dead end: hand over first, then go.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It deletes nothing, ever. The only column it writes is `active`, plus the
--     `user_id` a claim fills in.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and touches Christmas 2026 in no way at all.
--   * It does not change who is a contributor. Leaving the app is not leaving
--     the family's money -- `people.is_family_contributor` is untouched.
--
-- MIGRATIONS 001-041 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.transfer_area_admin(uuid, uuid)') is null then
    raise exception 'Migration 041 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Leaving
--
-- The caller can only ever act on THEIR OWN membership: the row is found by
-- `user_id = auth.uid()`, so there is no id to pass and nothing to tamper with.
-- One Area is named, and one Area is affected.
-- ---------------------------------------------------------------------------

create or replace function public.leave_area(p_area_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  mine public.app_members;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select * into mine
  from public.app_members m
  where m.area_id = p_area_id
    and m.user_id = caller
    and m.active = true;

  if not found then
    -- "No such family" and "you are not in it" are the same answer, so nobody
    -- can use this to find out which families exist.
    raise exception 'You are not a member of that family' using errcode = '42501';
  end if;

  -- THE ADMINISTRATOR CANNOT WALK OUT.
  --
  -- Migration 033's guard would refuse the write anyway; saying so here means
  -- the person gets an instruction they can act on instead of a constraint
  -- violation. Migration 041 is what makes that instruction possible.
  if mine.role = 'admin' then
    raise exception 'Hand this family over to somebody else before you leave it'
      using errcode = '42501';
  end if;

  -- Deactivated, not deleted. `audit_app_members` fires on `active` and records
  -- it; the person, their history and the family's money are untouched.
  update public.app_members
  set active = false, updated_at = now()
  where id = mine.id;
end;
$$;

revoke all on function public.leave_area(uuid) from public, anon;
grant execute on function public.leave_area(uuid) to authenticated;

comment on function public.leave_area(uuid) is
  'Gives up your own access to one family. Deactivates, never deletes: the person, their history and the family''s money are untouched. The administrator must hand over first.';

-- ---------------------------------------------------------------------------
-- 2. The write barrier lets somebody become a member
--
-- FOUND BY BISECTING THE MIGRATION CHAIN, not by reading it: `claim_app_member`
-- works through migration 036 and fails from 037 onwards with "That belongs to
-- another Area". The barrier asks whether the caller is a member of the row's
-- Area -- and the whole point of a claim is that they are not one YET.
--
-- So every invitation that goes through the claim path has been broken since
-- Phase 5 shipped. Nothing in the application creates such an invitation today
-- (Family Access makes the Auth account and links it in one go, so `user_id` is
-- never null), which is why nobody noticed -- but `auth/callback` and
-- `account-setup` both call it on every sign-in, and it is the documented way
-- an invited email joins.
--
-- Migration 037's function is reproduced below byte for byte, with one branch
-- added. Migration 037 is applied and is NOT edited.
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
  -- Nobody behind the request: a migration, the notification dispatcher, the
  -- reminder job, or the application's own admin client. None of them has a
  -- membership to check, and all of them are already trusted with the whole
  -- database.
  if (select auth.uid()) is null then
    return coalesce(new, old);
  end if;

  /*
   * AND ONE MORE CALLER WITH NO MEMBERSHIP TO CHECK: SOMEBODY BECOMING A MEMBER.
   *
   * `claim_app_member` attaches a login to an invitation that is waiting for it.
   * At the instant it runs, the row has no `user_id` -- so the caller is not yet
   * a member of that Area, so this barrier refused the very write that would
   * make them one. It has done so since migration 037 shipped: every invitation
   * that relies on the claim path has been failing with "That belongs to another
   * Area", and the sign-in that follows reports no access.
   *
   * The exemption is as narrow as the case:
   *   * `app_members` only, and only an UPDATE;
   *   * only a row that had NO login at all -- an invitation, never a membership;
   *   * only setting it to the CALLER'S OWN id, so nobody can claim for anybody;
   *   * only when the row is addressed to the caller's own email address;
   *   * and the Area may not change, so this can move nothing between families.
   *
   * Everything else about the row -- its Area, its person, its role -- is left
   * to the guards that already check them: 035 refuses a person from another
   * Area, and the role is never written here at all.
   */
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

  -- AN AREA WITH NOBODY IN IT BELONGS TO NOBODY. The first membership has to
  -- be written by someone who is not yet a member -- that is what create_area
  -- below does, and there is no order of statements that avoids it. So an Area
  -- with no members at all is open, and closes the instant one exists.
  --
  -- IT CANNOT REOPEN. Migration 035 refuses to let an Area lose its last active
  -- administrator, by demotion, deactivation, deletion or transfer, so the
  -- membership count can never fall back to zero. The two guards hold each
  -- other up.
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
-- 3. Claiming an invitation, without one bad row spoiling the rest
--
-- Every line of migration 010's version is here. What is added is the last
-- condition: an invitation to a family this login is ALREADY in is not claimed,
-- because it is not a second membership -- it is a duplicate, and 035's
-- `app_members_user_per_area_idx` would refuse the whole statement rather than
-- that one row.
--
-- IT STILL GRANTS NOTHING BY ITSELF. It fills in `user_id` on a row somebody
-- else already created, addressed to this login's own email address. It never
-- sets a role, never creates a membership, and never touches an inactive one.
-- ---------------------------------------------------------------------------

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

revoke all on function public.claim_app_member() from public, anon;
grant execute on function public.claim_app_member() to authenticated;

comment on function public.claim_app_member() is
  'Attaches this login to any invitation addressed to its own email, in any family it is not already in. Sets no role and creates no membership.';

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
begin
  foreach fn in array array['public.leave_area(uuid)', 'public.claim_app_member()'] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    elsif has_function_privilege('anon', fn, 'execute') then
      problems := problems || format('%s is callable by anon', fn)::text;
    elsif not has_function_privilege('authenticated', fn, 'execute') then
      problems := problems || format('%s is not callable by a member', fn)::text;
    end if;
  end loop;

  foreach fn in array array['leave_area', 'claim_app_member'] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace and prosecdef
        and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) s where s like 'search_path=%')
    ) then
      problems := problems || format('%s is not definer, or not search_path-pinned', fn)::text;
    end if;
  end loop;

  -- LEAVING IS DEACTIVATION. A delete would take the person's link to their own
  -- history with it.
  if exists (
    select 1 from pg_proc
    where proname = 'leave_area' and pronamespace = 'public'::regnamespace
      and prosrc ilike '%delete from%'
  ) then
    problems := problems || 'leave_area deletes a membership instead of deactivating it'::text;
  end if;

  -- AND IT ACTS ONLY ON THE CALLER'S OWN ROW.
  if not exists (
    select 1 from pg_proc
    where proname = 'leave_area' and pronamespace = 'public'::regnamespace
      and prosrc like '%m.user_id = caller%'
      and prosrc like '%role = ''admin''%'
  ) then
    problems := problems || 'leave_area does not find the caller''s own membership, or lets the administrator go'::text;
  end if;

  -- THE CLAIM SKIPS A FAMILY THE LOGIN IS ALREADY IN.
  if not exists (
    select 1 from pg_proc
    where proname = 'claim_app_member' and pronamespace = 'public'::regnamespace
      and prosrc like '%mine.area_id = m.area_id%'
  ) then
    problems := problems || 'claim_app_member can still be defeated by one duplicate invitation'::text;
  end if;

  -- AND IT STILL SETS NO ROLE.
  if exists (
    select 1 from pg_proc
    where proname = 'claim_app_member' and pronamespace = 'public'::regnamespace
      and prosrc like '%role =%'
  ) then
    problems := problems || 'claim_app_member writes a role'::text;
  end if;

  -- THE BARRIER LETS A CLAIM THROUGH, and only a claim.
  if not exists (
    select 1 from pg_proc
    where proname = 'refuse_foreign_area_write' and pronamespace = 'public'::regnamespace
      and prosrc like '%old.user_id is null%'
      and prosrc like '%new.user_id = (select auth.uid())%'
      and prosrc like '%new.area_id is not distinct from old.area_id%'
  ) then
    problems := problems || 'the write barrier still refuses somebody becoming a member'::text;
  end if;

  -- AND IT IS STILL A BARRIER. Every table it guarded, it still guards.
  if not exists (
    select 1 from pg_proc
    where proname = 'refuse_foreign_area_write' and pronamespace = 'public'::regnamespace
      and prosrc like '%That belongs to another Area%'
      and prosrc like '%is_area_member(before_area)%'
      and prosrc like '%is_area_member(after_area)%'
  ) then
    problems := problems || 'the write barrier no longer refuses a foreign write'::text;
  end if;

  if to_regprocedure('public.transfer_area_admin(uuid, uuid)') is null then
    problems := problems || 'migration 041''s handover has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 042 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Somebody can leave a family, and an invitation to one family cannot be spoiled by another.';
end;
$$;
