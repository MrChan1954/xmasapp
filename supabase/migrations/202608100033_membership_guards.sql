-- Two guards on membership, moved from the application into the database.
--
-- WHAT PHASE 4 FOUND, AND WHY THIS FILE IS SMALL
--
--   The four concepts this phase is about already have durable, separate
--   storage, and have had since migration 004:
--
--     PERSON       public.people
--     MEMBER       public.app_members  (user_id, email, active)
--     CONTRIBUTOR  public.people.is_family_contributor   (migration 030)
--     ADMIN        public.app_members.role = 'admin'
--
--   `app_members_one_membership_per_person_idx` already makes the person link
--   unique, `claim_app_member` already takes NOTHING from the browser -- it
--   matches the caller's own authenticated email and refuses a row that is
--   already claimed -- and the contributor pool is already read from `people`
--   rather than from who happens to have an account. None of that needed
--   changing, so none of it is here.
--
--   Two rules were enforced only in the API route that happens to perform
--   them today. A rule that lives in one caller is a rule the next caller does
--   not have.
--
--   1. THERE MUST ALWAYS BE AN ACTIVE ADMINISTRATOR.
--      `/api/admin/family-access` refuses to disable an admin account. Nothing
--      below it does. That route holds the service key, so it is already past
--      row level security -- and a family that loses its last administrator
--      cannot appoint another, because no path in this application promotes
--      anybody. The lockout would be permanent.
--
--   2. AN ACTIVE MEMBERSHIP MUST NAME ITS PERSON.
--      `app_members.person_id` is nullable, and an active membership without
--      one is a real hazard rather than an untidiness: `current_person_id()`
--      returns null for that account, so migration 031's birthday privacy has
--      nobody to hide a birthday from, and the People directory cannot tell
--      whose profile is whose.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes, renumbers or rewrites no row. Both additions are
--     triggers; existing rows are read, never written.
--   * It does NOT backfill a person link. Guessing who an unlinked account
--     belongs to is exactly the mistake worth avoiding -- section 3 reports
--     them instead, and section 4 leaves them alone.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and redefines none of the functions that write them.
--   * It adds no role, no column and no second source of truth for any of the
--     four concepts above.
--   * It touches Christmas 2026 in no way whatsoever.
--
-- MIGRATIONS 001-032 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.app_members') is null then
    raise exception 'Migration 004 has not been applied.';
  end if;
  if to_regproc('public.current_person_id') is null then
    raise exception 'Migration 031 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The family always has an administrator
--
-- Fires on the row LEAVING administration, by any route: deactivated, demoted,
-- or deleted. It counts the administrators that would remain, so it blocks only
-- the last one -- if a later migration ever allows two, handing over works
-- without this file changing.
--
-- NOTE THE LIMITATION IT CANNOT FIX. Migration 026's
-- `app_members_single_admin_idx` is a unique index on `role` where role =
-- 'admin', so this family can have AT MOST one administrator. Combined with
-- this guard the role becomes effectively permanent: it cannot be given away,
-- because a second admin cannot exist to receive it first. That is a real
-- constraint of the current single-family model and is called out in the Phase
-- 4 report rather than quietly worked around here -- Phase 5 replaces the
-- global administrator with an Area one, and that is where handover belongs.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_admin boolean;
  still_admin boolean;
  remaining integer;
begin
  was_admin := old.role = 'admin' and old.active;
  still_admin := tg_op = 'UPDATE' and new.role = 'admin' and new.active;

  -- Not an administrator before, or still one after: nothing to protect.
  if not was_admin or still_admin then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select count(*) into remaining
  from public.app_members
  where role = 'admin' and active and id <> old.id;

  if remaining = 0 then
    raise exception 'The family must keep at least one active administrator'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists app_members_keep_an_admin on public.app_members;
create trigger app_members_keep_an_admin
before update or delete on public.app_members
for each row execute function public.refuse_last_admin_removal();

comment on function public.refuse_last_admin_removal() is
  'Refuses the change that would leave the family with no active administrator. Deactivation, demotion and deletion alike.';

-- ---------------------------------------------------------------------------
-- 2. An active membership names its person
--
-- Applied to rows being CREATED or being MADE ACTIVE, and to nothing else.
--
-- WHY NOT A CHECK CONSTRAINT. A `not valid` CHECK would grandfather today's
-- rows but still fire on any later UPDATE of one -- including deactivating it,
-- which is the very thing an operator would want to do to an unlinked account.
-- The rule wanted is about what may be created or switched on, not about what
-- may be touched, and only a trigger can say that.
--
-- SO A LEGACY ROW CAN STILL BE TIDIED UP. An existing active membership with no
-- person link keeps working and can be deactivated; what it cannot do is be
-- reactivated while still unlinked, which is the right answer -- an account
-- nobody can identify should not be switched back on.
-- ---------------------------------------------------------------------------

create or replace function public.require_person_link_when_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.active or new.person_id is not null then
    return new;
  end if;

  -- Already active and already unlinked, and staying that way: a row that
  -- predates this rule, being edited for some other reason. Left alone.
  if tg_op = 'UPDATE' and old.active and old.person_id is null then
    return new;
  end if;

  raise exception 'An account must be linked to a family member before it is active'
    using errcode = '23502';
end;
$$;

drop trigger if exists app_members_require_person_link on public.app_members;
create trigger app_members_require_person_link
before insert or update on public.app_members
for each row execute function public.require_person_link_when_active();

comment on function public.require_person_link_when_active() is
  'An account being created or switched on must name the family member it belongs to. Without one, current_person_id() is null and birthday privacy has nobody to protect.';

-- ---------------------------------------------------------------------------
-- 3. What is already there, reported and not touched
--
-- A NOTICE, never an exception. A family that has such a row still needs this
-- migration to apply -- it is what stops another one being made -- and who an
-- unlinked account belongs to is a question for a person, not for a migration.
-- ---------------------------------------------------------------------------

do $$
declare
  unlinked integer;
begin
  select count(*) into unlinked
  from public.app_members
  where active and person_id is null;

  if unlinked > 0 then
    raise warning 'ATTENTION: % active account(s) are not linked to a family member. They keep working and are unchanged, but current_person_id() is null for them, so birthday privacy cannot protect those readers. Link each one to its person before relying on this migration.', unlinked;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  admins integer;
  name text;
begin
  foreach name in array array['refuse_last_admin_removal', 'require_person_link_when_active']
  loop
    if not exists (
      select 1 from pg_proc
      where proname = name and pronamespace = 'public'::regnamespace and prosecdef
        and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
    ) then
      problems := problems || format('%s is missing, not definer, or not search_path-pinned', name)::text;
    end if;
  end loop;

  foreach name in array array['app_members_keep_an_admin', 'app_members_require_person_link']
  loop
    if not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = 'app_members' and t.tgname = name and not t.tgisinternal
    ) then
      problems := problems || format('the %s trigger is missing', name)::text;
    end if;
  end loop;

  -- Nothing was demoted, deactivated or linked by this migration.
  select count(*) into admins from public.app_members where role = 'admin' and active;
  if admins > 1 then
    problems := problems || 'more than one active administrator exists, which migration 026''s index should prevent'::text;
  end if;

  -- The four concepts still live where they lived.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'is_family_contributor'
  ) then
    problems := problems || 'contributor eligibility has moved off people'::text;
  end if;
  if to_regproc('public.claim_app_member') is null then
    problems := problems || 'the invite claim function has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 033 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Membership guards installed: the family keeps an administrator, and an active account names its person. No account, person, purchase, payment or eligibility was changed.';
end;
$$;
