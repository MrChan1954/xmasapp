-- Handing over a family, without a moment where nobody runs it.
--
-- THE PROBLEM THIS FIXES, AND WHY IT IS NOT A SMALL ONE
--
--   Migration 035 gave every Area exactly one administrator, two ways at once:
--
--     app_members_single_admin_per_area_idx   at most one, checked per row
--     refuse_last_admin_removal (033/035)     at least one, checked per row
--
--   Both are immediate. Together they make handover IMPOSSIBLE, in every order:
--
--     promote the successor first  -> 23505, two administrators for an instant
--     demote the incumbent first   -> 23514, none for an instant
--     swap both in one statement   -> 23514, the index is not deferrable so
--                                     there is no instant at which it is legal
--     stand down (deactivate/delete) -> 23514
--
--   So an Area's administrator can never be changed. If that account is lost --
--   somebody leaves, an email dies, a person stops using the app -- the family
--   is unadministrable for good. Migration 035's own comment says handover
--   "arrives with the create_area RPC in 037". It never did.
--
-- THE FIX, IN ONE SENTENCE
--   Move "exactly one administrator" from a per-row check to a per-TRANSACTION
--   one, so a swap is legal at COMMIT even though neither half of it is legal
--   on its own.
--
-- WHY A DEFERRED CONSTRAINT TRIGGER AND NOT A DEFERRABLE UNIQUE CONSTRAINT
--   A unique index cannot be deferred, and a UNIQUE table constraint -- which
--   can be -- cannot carry the `where role = 'admin'` that makes this rule
--   partial. A constraint trigger can be deferred AND can ask any question, so
--   it is the only shape that fits.
--
-- WHAT THIS BUYS, AND WHAT IT DOES NOT
--   * There is still never a COMMITTED state with two administrators, or none.
--   * The window with two exists only inside one transaction, in one routine,
--     which no browser can drive halfway.
--   * Nothing here creates a global administrator, and nothing here lets one
--     Area touch another: `transfer_area_admin` reads the caller's own
--     membership row in the Area it was given and refuses everything else.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no row of family data. The only rows it
--     writes are the two role changes a caller asks for, and the audit entry
--     that records them.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and touches Christmas 2026 in no way at all.
--   * It does not let anybody leave an Area -- that is migration 042.
--
-- MIGRATIONS 001-040 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
--
-- The second check matters more than it looks. This migration installs a rule
-- that is enforced at COMMIT for every future write to `app_members`. If any
-- Area is already outside that rule, installing it would make that Area
-- unwritable for ever -- the opposite of the problem being fixed. So it refuses
-- to apply instead.
-- ---------------------------------------------------------------------------

do $$
declare
  offending record;
begin
  if to_regclass('public.birthday_wishlist_ideas') is null then
    raise exception 'Migration 040 has not been applied.';
  end if;
  if to_regproc('public.is_area_admin') is null then
    raise exception 'Migration 034 has not been applied.';
  end if;

  for offending in
    select m.area_id, count(*) filter (where m.role = 'admin' and m.active) as admins
    from public.app_members m
    group by m.area_id
    having count(*) filter (where m.role = 'admin' and m.active) <> 1
  loop
    raise exception
      'Area % has % active administrators, not 1. Fix that before installing a rule that requires it.',
      offending.area_id, offending.admins;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. A handover is a thing that happens, and the family should be able to see it
--
-- `audit_log.action` has allowed three words since migration 015: added,
-- removed, restored. A handover is none of them, and the trigger that audits
-- `app_members` ignores a pure role change altogether -- it only fires when
-- `active` flips -- so today the single most sensitive membership operation
-- there is would leave no trace whatever.
--
-- Widening a CHECK can invalidate no existing row: every value that was legal
-- still is.
-- ---------------------------------------------------------------------------

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action in ('added', 'removed', 'restored', 'handover'));

-- ---------------------------------------------------------------------------
-- 2. "Exactly one administrator" becomes a rule about the transaction
--
-- The check reads the whole Area rather than the row it fired for, because the
-- rule was always about the Area. Firing per row and asking about the Area is
-- what lets a two-row swap be judged once, at the end, on its result.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_area_without_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched uuid;
  admins integer;
begin
  -- NEW is unassigned on DELETE and OLD is unassigned on INSERT, so neither can
  -- be read unconditionally.
  if tg_op = 'DELETE' then
    touched := old.area_id;
  else
    touched := new.area_id;
  end if;

  if touched is null then
    return null;
  end if;

  select count(*) filter (where m.role = 'admin' and m.active)
  into admins
  from public.app_members m
  where m.area_id = touched;

  -- AN AREA WITH NOBODY IN IT IS NOT YET AN AREA. `create_area` writes the
  -- Area, the person and the first membership in one transaction, and 037's
  -- write barrier makes the same allowance for the same reason. An Area with no
  -- memberships at all is being built, not broken.
  if not exists (select 1 from public.app_members m where m.area_id = touched) then
    return null;
  end if;

  if admins <> 1 then
    raise exception 'A family must have exactly one administrator, and this one would have %', admins
      using errcode = '23514';
  end if;

  return null;
end;
$$;

comment on function public.refuse_area_without_one_admin() is
  'Deferred to COMMIT: an Area ends every transaction with exactly one active administrator. Deferred rather than immediate so a handover can swap two rows without an illegal moment in between.';

drop trigger if exists app_members_exactly_one_admin on public.app_members;
create constraint trigger app_members_exactly_one_admin
after insert or update or delete on public.app_members
deferrable initially deferred
for each row execute function public.refuse_area_without_one_admin();

-- AND ONLY NOW is the immediate rule removed. Created first, dropped second, so
-- there is no instant during this migration in which nothing enforces it.
drop index if exists public.app_members_single_admin_per_area_idx;

-- ---------------------------------------------------------------------------
-- 3. The handover itself
--
-- ONE ROUTINE, ONE TRANSACTION. A browser cannot drive this halfway: there is
-- no sequence of two requests to get wrong, no window in which the family has
-- two administrators or none that anybody outside this function can observe.
--
-- IT TRUSTS NOTHING IT IS TOLD except which Area and which membership, and it
-- checks both against the membership table before it believes either. It does
-- not read the acting Area, so it cannot be steered by a header.
-- ---------------------------------------------------------------------------

create or replace function public.transfer_area_admin(
  p_area_id uuid,
  p_new_admin_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  outgoing public.app_members;
  incoming public.app_members;
  incoming_name text;
  area_name text;
begin
  if caller is null then
    raise exception 'You must be signed in to hand over a family' using errcode = '42501';
  end if;

  -- 1. THE CALLER IS THIS AREA'S ADMINISTRATOR, read from the membership table
  --    rather than from anything that arrived with the request.
  --    `for update` LOCKS THE ADMINISTRATOR'S OWN ROW for the rest of the
  --    transaction. Two handovers started at the same moment would otherwise
  --    both read "I am the administrator", both promote a different successor,
  --    and arrive at the deferred check with two -- one of them failing with a
  --    constraint violation rather than an explanation. With the lock the second
  --    waits, re-reads, finds it is no longer the administrator, and is told so.
  select * into outgoing
  from public.app_members m
  where m.area_id = p_area_id
    and m.user_id = caller
    and m.active = true
    and m.role = 'admin'
  for update;

  if not found then
    raise exception 'Only this family''s admin can hand it over' using errcode = '42501';
  end if;

  -- 2. THE SUCCESSOR IS AN ACTIVE MEMBERSHIP OF THE SAME AREA, with a person.
  --
  --    One refusal covers "no such membership", "a membership in another
  --    family", "an inactive membership" and "a membership with nobody behind
  --    it". Telling them apart would let an administrator probe another
  --    family's membership ids for existence.
  select * into incoming
  from public.app_members m
  where m.id = p_new_admin_member_id
    and m.area_id = p_area_id
    and m.active = true
    and m.person_id is not null;

  if not found then
    raise exception 'That person cannot take over this family' using errcode = '42501';
  end if;

  if incoming.id = outgoing.id then
    raise exception 'You already run this family' using errcode = '23505';
  end if;

  -- 3. THE SWAP.
  --
  --    Promote first. The deferred trigger above is what makes the moment with
  --    two administrators legal; 033's guard is what makes a moment with none
  --    impossible, and it passes here because the successor is already one by
  --    the time the incumbent stands down. Both halves commit or neither does.
  update public.app_members set role = 'admin', updated_at = now() where id = incoming.id;
  update public.app_members set role = 'member', updated_at = now() where id = outgoing.id;

  -- 4. SAY SO, IN THE FAMILY'S OWN ACTIVITY LOG.
  --
  --    `audit_app_members` ignores a pure role change -- it fires on `active` --
  --    so without this the handover would be invisible. Names, never emails:
  --    the log is not the place for a login.
  select p.name into incoming_name from public.people p where p.id = incoming.person_id;
  select a.name into area_name from public.areas a where a.id = p_area_id;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, area_id
  ) values (
    'app_members', incoming.id, 'handover', caller, public.audit_actor_name(),
    'app_members handover',
    coalesce(incoming_name, 'a family member'),
    coalesce(area_name, 'this family'),
    p_area_id
  );
end;
$$;

revoke all on function public.transfer_area_admin(uuid, uuid) from public, anon;
grant execute on function public.transfer_area_admin(uuid, uuid) to authenticated;

comment on function public.transfer_area_admin(uuid, uuid) is
  'Hands one Area''s administration to another of its active members, atomically. Refuses anybody who is not that Area''s current administrator, and any successor outside it.';

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
begin
  if to_regclass('public.app_members_single_admin_per_area_idx') is not null then
    problems := problems || 'the immediate one-admin index is still there, so a handover is still impossible'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'app_members_exactly_one_admin' and not tgisinternal
      and tgrelid = 'public.app_members'::regclass
      and tgdeferrable and tginitdeferred
  ) then
    problems := problems || 'the one-admin rule is missing, or is not deferred to commit'::text;
  end if;

  -- 033's guard is what stops the swap being done in the wrong order. Losing it
  -- while the index is gone would leave nothing at all requiring an admin.
  if not exists (select 1 from pg_trigger where tgname = 'app_members_keep_an_admin' and not tgisinternal) then
    problems := problems || 'migration 033''s last-administrator guard has gone missing'::text;
  end if;

  if to_regprocedure('public.transfer_area_admin(uuid, uuid)') is null then
    problems := problems || 'transfer_area_admin is missing'::text;
  elsif has_function_privilege('anon', 'public.transfer_area_admin(uuid, uuid)', 'execute') then
    problems := problems || 'transfer_area_admin is callable by anon'::text;
  elsif not has_function_privilege('authenticated', 'public.transfer_area_admin(uuid, uuid)', 'execute') then
    problems := problems || 'transfer_area_admin is not callable by a member'::text;
  end if;

  -- Two callers at once serialise on the administrator's row rather than
  -- racing to the deferred check.
  if not exists (
    select 1 from pg_proc
    where proname = 'transfer_area_admin' and pronamespace = 'public'::regnamespace
      and prosrc like '%for update%'
  ) then
    problems := problems || 'transfer_area_admin does not lock the administrator''s row'::text;
  end if;

  if not exists (
    select 1 from pg_proc
    where proname = 'transfer_area_admin' and pronamespace = 'public'::regnamespace and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) s where s like 'search_path=%')
  ) then
    problems := problems || 'transfer_area_admin is not definer, or not search_path-pinned'::text;
  end if;

  -- IT MUST NOT BE STEERABLE BY A HEADER. Everything it checks comes from the
  -- membership table.
  if exists (
    select 1 from pg_proc
    where proname = 'transfer_area_admin' and pronamespace = 'public'::regnamespace
      and (prosrc like '%acting_area%' or prosrc like '%is_app_admin%')
  ) then
    problems := problems || 'transfer_area_admin depends on the acting Area'::text;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_log'::regclass and conname = 'audit_log_action_check'
      and pg_get_constraintdef(oid) like '%handover%'
  ) then
    problems := problems || 'the audit log cannot record a handover'::text;
  end if;

  -- And every Area still has exactly the one administrator it started with.
  -- Nothing in this file creates, moves or destroys a membership, so a
  -- different answer here would mean it did something it never claimed to.
  if exists (
    select 1 from public.app_members m
    group by m.area_id
    having count(*) filter (where m.role = 'admin' and m.active) <> 1
  ) then
    problems := problems || 'an Area ended this migration without exactly one administrator'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 041 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'A family can be handed over: exactly one administrator, checked at commit rather than per row.';
end;
$$;
