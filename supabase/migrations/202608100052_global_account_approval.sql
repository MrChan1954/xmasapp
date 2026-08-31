-- ===========================================================================
-- MIGRATION 052 -- GLOBAL ACCOUNT APPROVAL, AND THE ONBOARDING IT MAKES SAFE
-- ===========================================================================
--
-- WHAT CHANGES, IN ONE SENTENCE
--
--   Being able to sign in stops being the same thing as being allowed in.
--
-- WHY THIS EXISTS
--
--   Until now, the only way to get an account was for somebody to put an
--   invitation in `app_members` with your email on it. Sign-up was not public,
--   so "has an auth.users row" and "belongs here" were the same population, and
--   the database never had to tell them apart.
--
--   Public sign-up breaks that. The moment anybody on the internet can create
--   an `auth.users` row, every routine that asked only "are you signed in?"
--   is answering the wrong question. `create_area` was the worst of them: it
--   let ANY signed-in account create a family, name itself that family's
--   administrator, and start writing.
--
--   So this migration introduces a second gate, ABOVE the Area gates that
--   already exist:
--
--       auth.users            you can sign in
--         -> app_accounts     a human has approved you for Gift Planner
--            -> app_members   a family has invited you into it
--               -> role       what you may do inside that family
--
--   Nothing about Area isolation, acting-Area semantics, birthday privacy or
--   settlement authority changes. Those rules are untouched; they simply now
--   sit behind one more door.
--
-- FAIL-CLOSED IS THE WHOLE DESIGN
--
--   A missing `app_accounts` row means NOT APPROVED. There is no "unknown"
--   state that behaves like a member. `my_account_status()` reports a stable
--   `pending` for a signed-in account with no row, because that is exactly what
--   it is -- undecided -- and the answer must not depend on whether a row
--   happens to have been written yet.
--
--   Note the three refused states are NOT interchangeable in the catalogue,
--   even though they behave identically at the door:
--
--     * undecided / never reviewed -> usually NO row at all
--     * rejected                   -> a row, status = 'rejected'
--     * suspended                  -> a row, status = 'suspended'
--
-- THE BROWSER NEVER READS THIS TABLE
--
--   `app_accounts` has row level security on and ZERO policies, and neither
--   `anon` nor `authenticated` holds a single privilege on it. That is not
--   belt-and-braces: it is the design. A user's own status is available only
--   through `my_account_status()`, and the review queue only through
--   `list_accounts()`, both of which decide for themselves who may ask.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--
--   No global administrator is created. This migration finishes with zero of
--   them, and its own end-state block refuses to complete if that is not true.
--   The first one is appointed by a documented operator statement after the
--   census has been reviewed -- see `docs/Q19-PUBLIC-SIGNUP-APPROVAL.md`. There
--   is no bootstrap actor invented in `audit_log`, because there was no actor.
--
--   No account is approved by hand. The backfill approves exactly those logins
--   that already held an ACTIVE, CLAIMED membership AND a CONFIRMED email at
--   the moment of the upgrade. Everybody else stays undecided and is reviewed
--   by a person. There is not one hard-coded uuid in this file.
--
-- ROLLBACK
--
--   `docs/Q19-052-ROLLBACK.sql`. Read its header before running it: rolling
--   back reopens `create_area` to any signed-in account and `claim_app_member`
--   to an unconfirmed email, so `/sign-up` must not be publicly reachable if it
--   is used.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT
--
-- Prove the database is the one this file was written against. A migration
-- that half-applies to a schema it does not recognise is worse than one that
-- refuses, so this refuses. PGlite and PostgreSQL both run a bare .sql file as
-- one implicit transaction, so a RAISE here leaves nothing behind.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  gone text;
  areas_grants text[];
  wishlist_grants text[];
begin
  -- This file has already run.
  if to_regclass('public.app_accounts') is not null then
    problems := problems || 'public.app_accounts already exists -- 052 has already been applied'::text;
  end if;

  -- 045: the acting-Area guard the new Area-access routines call.
  if to_regprocedure('public.require_acting_area(uuid)') is null then
    problems := problems || 'migration 045 is missing: require_acting_area(uuid) does not exist'::text;
  end if;

  -- 048: the three internal helpers are still closed to both browser roles.
  foreach fn in array array[
    'public.area_of_record(text, uuid)',
    'public.area_of_written_row(text, jsonb)',
    'public.audit_actor_name()'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('migration 048 is missing: %s does not exist', fn)::text;
    else
      if has_function_privilege('anon', fn, 'execute') then
        problems := problems || format('migration 048 has been undone: %s is callable by anon', fn)::text;
      end if;
      if has_function_privilege('authenticated', fn, 'execute') then
        problems := problems || format('migration 048 has been undone: %s is callable by authenticated', fn)::text;
      end if;
    end if;
  end loop;

  -- 049: the audit stamp still derives an Area from where the writer stood.
  if to_regprocedure('public.stamp_audit_area()') is null then
    problems := problems || 'migration 049 is missing: stamp_audit_area() does not exist'::text;
  elsif position('public.acting_area()' in pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) = 0 then
    problems := problems || 'migration 049 has been undone: stamp_audit_area() no longer consults the acting Area'::text;
  end if;

  -- 050: the two columns every audit read is filtered on.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_log' and column_name = 'celebrant_person_id'
  ) then
    problems := problems || 'migration 050 is missing: audit_log.celebrant_person_id does not exist'::text;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_log' and column_name = 'birthday_privacy_unknown'
  ) then
    problems := problems || 'migration 050 is missing: audit_log.birthday_privacy_unknown does not exist'::text;
  end if;

  -- 051: the three superseded routines stayed dropped.
  foreach gone in array array[
    'public.is_family_contributor_member()',
    'public.save_christmas_recipient(uuid, uuid, text, integer)',
    'public.save_recipient_contributions(uuid, jsonb)'
  ] loop
    if to_regprocedure(gone) is not null then
      problems := problems || format('migration 051 has been undone: %s is back', gone)::text;
    end if;
  end loop;

  -- 051: and the two tables it narrowed are still narrow.
  select coalesce(array_agg(a.privilege_type order by a.privilege_type), array[]::text[])
    into areas_grants
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.areas'::regclass and a.grantee = 'authenticated'::regrole;

  if areas_grants is distinct from array['SELECT']::text[] then
    problems := problems || format(
      'migration 051 has been undone: authenticated holds %s on public.areas, expected {SELECT}',
      coalesce(array_to_string(areas_grants, ','), 'nothing'))::text;
  end if;

  select coalesce(array_agg(a.privilege_type order by a.privilege_type), array[]::text[])
    into wishlist_grants
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.birthday_wishlist_ideas'::regclass and a.grantee = 'authenticated'::regrole;

  if wishlist_grants is distinct from array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] then
    problems := problems || format(
      'migration 051 has been undone: authenticated holds %s on public.birthday_wishlist_ideas, '
      'expected {DELETE,INSERT,SELECT,UPDATE}',
      coalesce(array_to_string(wishlist_grants, ','), 'nothing'))::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 052 preflight failed, nothing applied: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Migration 052 preflight: 045, 048, 049, 050 and 051 are all in their expected end state.';
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. THE TABLE
--
-- One row per Gift Planner account. Not one per family membership: this is the
-- global decision, and it is deliberately upstream of every Area.
-- ---------------------------------------------------------------------------

create table public.app_accounts (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  status        text not null default 'pending',
  is_global_admin boolean not null default false,
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  decision_note text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint app_accounts_status_known
    check (status in ('pending', 'approved', 'rejected', 'suspended')),

  -- A global administrator who is not themselves approved would be an
  -- administrator the front door refuses, which is a state nothing should be
  -- able to reach -- including a status change that forgets to clear the flag.
  -- `set_account_status` clears it explicitly; this makes forgetting impossible.
  constraint app_accounts_admin_must_be_approved
    check (not is_global_admin or status = 'approved')
);

comment on table public.app_accounts is
  'Global Gift Planner approval, one row per auth.users account. Upstream of every Area: '
  'membership in a family authorises nothing while this says pending, rejected or suspended. '
  'A MISSING ROW MEANS NOT APPROVED. Never readable from a browser -- see my_account_status() '
  'and list_accounts() (052).';

comment on column public.app_accounts.status is
  'pending | approved | rejected | suspended. Only approved passes is_globally_approved().';
comment on column public.app_accounts.is_global_admin is
  'Gift Planner administration, which is NOT family administration and grants no Area access.';
comment on column public.app_accounts.decided_by is
  'The global administrator who made the decision. Null for the 052 backfill, which had no actor.';

-- The queue a global administrator actually reads is everything NOT approved,
-- and in a healthy installation that is the short list.
create index app_accounts_undecided_idx
  on public.app_accounts (status)
  where status <> 'approved';

alter table public.app_accounts enable row level security;

-- ZERO POLICIES, AND ZERO PRIVILEGES. Supabase's project default grants ALL on
-- every new table in `public` to anon and authenticated, so this is not
-- rhetorical -- without the revoke the table would arrive readable and
-- writable, with RLS the only thing between it and the internet. Both doors,
-- not one.
revoke all privileges on table public.app_accounts from public;
revoke all privileges on table public.app_accounts from anon;
revoke all privileges on table public.app_accounts from authenticated;


-- ---------------------------------------------------------------------------
-- 1b. THREE MORE WORDS THE ACTIVITY LOG IS ALLOWED TO SAY
--
-- `audit_log.action` has been a closed vocabulary since 015: added, removed,
-- restored, and -- since 041 widened it for exactly this reason -- handover. A
-- global account decision is none of those. Approving somebody is not "adding"
-- them to anything, and standing an administrator down is not "removing" a row.
--
-- WIDENING A CHECK CAN INVALIDATE NO EXISTING ROW: every value that was legal
-- still is. This is the same one-line change 041 made, for the same reason, and
-- the rollback restores the four-word list.
-- ---------------------------------------------------------------------------

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action in ('added', 'removed', 'restored', 'handover', 'decided', 'granted', 'revoked'));


-- ---------------------------------------------------------------------------
-- 2. THE TWO PREDICATES EVERYTHING ELSE IS BUILT ON
--
-- Both answer about the CALLER, never about a supplied id, so there is no
-- parameter to lie in. Both are false for a signed-out visitor, because
-- `auth.uid()` is null and no row matches null.
-- ---------------------------------------------------------------------------

create or replace function public.is_globally_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_accounts a
    where a.user_id = (select auth.uid())
      and a.status = 'approved'
  );
$$;

revoke all on function public.is_globally_approved() from public, anon;
grant execute on function public.is_globally_approved() to authenticated;

comment on function public.is_globally_approved() is
  'True only when the caller holds an approved global Gift Planner account. A missing '
  'app_accounts row is NOT approved. Named directly in the app_members own-row policy, so '
  'authenticated must keep EXECUTE (052).';

create or replace function public.is_global_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_accounts a
    where a.user_id = (select auth.uid())
      and a.status = 'approved'
      and a.is_global_admin = true
  );
$$;

revoke all on function public.is_global_admin() from public, anon;
grant execute on function public.is_global_admin() to authenticated;

comment on function public.is_global_admin() is
  'Gift Planner administration, which is not family administration and confers no Area access. '
  'Named directly in the global audit policy, so authenticated must keep EXECUTE (052).';


-- ---------------------------------------------------------------------------
-- 3. WHAT AN ACCOUNT MAY ASK ABOUT ITSELF
--
-- The sign-in flow has to be able to tell "approved", "waiting", "refused" and
-- "you have not confirmed your email" apart, and it must be able to do so
-- WITHOUT reading the table. This is that, and it is the only thing an
-- unapproved account may call successfully.
-- ---------------------------------------------------------------------------

create or replace function public.my_account_status()
returns table (status text, is_global_admin boolean, email_confirmed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(a.status, 'pending')::text,
    coalesce(a.is_global_admin, false),
    (u.email_confirmed_at is not null)
  from auth.users u
  left join public.app_accounts a on a.user_id = u.id
  where u.id = (select auth.uid());
$$;

revoke all on function public.my_account_status() from public, anon;
grant execute on function public.my_account_status() to authenticated;

comment on function public.my_account_status() is
  'The caller''s own global status, and nobody else''s. A signed-in account with no '
  'app_accounts row reports pending, because undecided is exactly what it is. Returns no '
  'row at all when nobody is signed in (052).';


-- ---------------------------------------------------------------------------
-- 4. THE GLOBAL REVIEW QUEUE
--
-- The only routine in this file that looks across the whole installation, and
-- the only one a family administrator can never reach.
-- ---------------------------------------------------------------------------

create or replace function public.list_accounts(p_status text default null)
returns table (
  user_id uuid,
  email text,
  email_confirmed boolean,
  status text,
  is_global_admin boolean,
  signed_up_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  decision_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_global_admin() then
    raise exception 'Only a Gift Planner administrator can review accounts'
      using errcode = '42501';
  end if;

  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception 'Unknown account status: %', p_status using errcode = '22023';
  end if;

  return query
    select
      u.id,
      u.email::text,
      (u.email_confirmed_at is not null),
      coalesce(a.status, 'pending')::text,
      coalesce(a.is_global_admin, false),
      u.created_at,
      a.decided_at,
      a.decided_by,
      a.decision_note
    from auth.users u
    left join public.app_accounts a on a.user_id = u.id
    where p_status is null or coalesce(a.status, 'pending') = p_status
    order by u.created_at, u.id;
end;
$$;

revoke all on function public.list_accounts(text) from public, anon;
grant execute on function public.list_accounts(text) to authenticated;

comment on function public.list_accounts(text) is
  'The global approval queue. Global administrators only -- a family administrator is refused. '
  'Carries no family data of any kind: no person, no Area, no amount (052).';


-- ---------------------------------------------------------------------------
-- 5. DECIDING
--
-- Approve, reject, suspend. One routine, because they are one decision with
-- different answers, and writing them separately would be four places to
-- forget the confirmed-email rule in.
-- ---------------------------------------------------------------------------

create or replace function public.set_account_status(
  p_user_id uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_confirmed boolean;
  admins_left integer;
begin
  if not public.is_global_admin() then
    raise exception 'Only a Gift Planner administrator can decide an account'
      using errcode = '42501';
  end if;

  if p_status is null or p_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception 'Unknown account status: %', coalesce(p_status, 'null') using errcode = '22023';
  end if;

  -- NOBODY DECIDES THEMSELVES. Not because self-approval would be worse than
  -- approving a confederate, but because the reviewer and the reviewed being
  -- the same person is the one case an audit trail cannot make sense of.
  if p_user_id = caller then
    raise exception 'You cannot change the status of your own account'
      using errcode = '42501';
  end if;

  select (u.email_confirmed_at is not null) into target_confirmed
  from auth.users u where u.id = p_user_id;

  if target_confirmed is null then
    raise exception 'No such account' using errcode = 'P0002';
  end if;

  -- APPROVAL REQUIRES A CONFIRMED EMAIL, AT THE DATABASE. The sign-up screen
  -- checks this too; that check is a courtesy and this one is the rule.
  if p_status = 'approved' and not target_confirmed then
    raise exception 'That account has not confirmed its email address yet'
      using errcode = '42501';
  end if;

  if p_note is not null then
    if length(p_note) > 500 then
      raise exception 'A decision note may be at most 500 characters' using errcode = '22001';
    end if;
    if p_note ~ '[[:cntrl:]]' then
      raise exception 'A decision note may not contain control characters' using errcode = '22023';
    end if;
  end if;

  -- THE INSTALLATION MUST NEVER RUN OUT OF ADMINISTRATORS. Unreachable while
  -- self-decision is refused -- a caller who is an administrator is a second
  -- one -- but written down anyway, because "unreachable" is a property of the
  -- code around it and this rule should not depend on that staying true.
  if p_status <> 'approved' then
    select count(*) into admins_left
    from public.app_accounts a
    where a.is_global_admin = true and a.status = 'approved' and a.user_id <> p_user_id;

    if admins_left = 0 and exists (
      select 1 from public.app_accounts a
      where a.user_id = p_user_id and a.is_global_admin = true and a.status = 'approved'
    ) then
      raise exception 'That is the last Gift Planner administrator'
        using errcode = '23514';
    end if;
  end if;

  -- ANY STATUS BUT APPROVED CLEARS THE ADMIN FLAG, AND RE-APPROVAL DOES NOT
  -- BRING IT BACK. Coming back from suspension returns you to the installation,
  -- not to its controls; the flag is reissued deliberately or not at all.
  insert into public.app_accounts as a
    (user_id, status, is_global_admin, decided_at, decided_by, decision_note, updated_at)
  values
    (p_user_id, p_status, false, now(), caller, p_note, now())
  on conflict (user_id) do update
    set status          = excluded.status,
        is_global_admin = case when excluded.status = 'approved' then a.is_global_admin else false end,
        decided_at      = excluded.decided_at,
        decided_by      = excluded.decided_by,
        decision_note   = excluded.decision_note,
        updated_at      = excluded.updated_at;

  -- A GLOBAL DECISION IS NOT A FAMILY EVENT. `stamp_audit_area` refuses to put
  -- an Area on this row even though the caller may well be standing in one --
  -- see section 9 -- so this entry is visible only through the global policy in
  -- section 8, and never in any family's activity log.
  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_accounts', p_user_id, 'decided', caller, null,
    format('Global account set to %s', p_status),
    null, null, null,
    jsonb_build_object('status', p_status, 'note', p_note),
    null, null, false
  );
end;
$$;

revoke all on function public.set_account_status(uuid, text, text) from public, anon;
grant execute on function public.set_account_status(uuid, text, text) to authenticated;

comment on function public.set_account_status(uuid, text, text) is
  'Approve, reject, suspend or re-open a global account. Global administrators only, never '
  'oneself, never approving an unconfirmed email, and any status but approved clears the '
  'global-admin flag without restoring it on re-approval (052).';


-- ---------------------------------------------------------------------------
-- 6. GLOBAL ADMINISTRATION
--
-- Appointing one creates NO family membership. A Gift Planner administrator
-- with no Areas sees no gift, no budget, no birthday and no name -- and that
-- separation is the point of having two kinds of administrator at all.
-- ---------------------------------------------------------------------------

create or replace function public.grant_global_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_confirmed boolean;
  target_status text;
begin
  if not public.is_global_admin() then
    raise exception 'Only a Gift Planner administrator can appoint another'
      using errcode = '42501';
  end if;

  select (u.email_confirmed_at is not null) into target_confirmed
  from auth.users u where u.id = p_user_id;

  if target_confirmed is null then
    raise exception 'No such account' using errcode = 'P0002';
  end if;

  if not target_confirmed then
    raise exception 'That account has not confirmed its email address yet'
      using errcode = '42501';
  end if;

  select a.status into target_status
  from public.app_accounts a where a.user_id = p_user_id;

  if target_status is distinct from 'approved' then
    raise exception 'That account must be approved before it can administer Gift Planner'
      using errcode = '42501';
  end if;

  update public.app_accounts
  set is_global_admin = true,
      updated_at = now()
  where user_id = p_user_id;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_accounts', p_user_id, 'granted', caller, null,
    'Global administrator granted',
    null, null, null, jsonb_build_object('is_global_admin', true),
    null, null, false
  );
end;
$$;

revoke all on function public.grant_global_admin(uuid) from public, anon;
grant execute on function public.grant_global_admin(uuid) to authenticated;

comment on function public.grant_global_admin(uuid) is
  'Appoints another global administrator. Requires an approved account with a confirmed '
  'email, and creates no Area membership whatsoever (052).';

create or replace function public.revoke_global_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  admins_left integer;
begin
  if not public.is_global_admin() then
    raise exception 'Only a Gift Planner administrator can stand another down'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.app_accounts a
    where a.user_id = p_user_id and a.is_global_admin = true
  ) then
    raise exception 'That account does not administer Gift Planner' using errcode = 'P0002';
  end if;

  -- THE INSTALLATION MUST NEVER RUN OUT. Unlike the same rule in
  -- `set_account_status`, this one IS reachable: standing yourself down is a
  -- legitimate thing to do, right up until you are the only one left.
  select count(*) into admins_left
  from public.app_accounts a
  where a.is_global_admin = true and a.status = 'approved' and a.user_id <> p_user_id;

  if admins_left = 0 then
    raise exception 'That is the last Gift Planner administrator'
      using errcode = '23514';
  end if;

  update public.app_accounts
  set is_global_admin = false,
      updated_at = now()
  where user_id = p_user_id;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_accounts', p_user_id, 'revoked', caller, null,
    'Global administrator revoked',
    null, null, null, jsonb_build_object('is_global_admin', false),
    null, null, false
  );
end;
$$;

revoke all on function public.revoke_global_admin(uuid) from public, anon;
grant execute on function public.revoke_global_admin(uuid) to authenticated;

comment on function public.revoke_global_admin(uuid) is
  'Stands a global administrator down, and refuses to remove the last one. Changes no Area '
  'membership (052).';


-- ---------------------------------------------------------------------------
-- 7. FAMILY ACCESS, MOVED INTO THE DATABASE
--
-- These three replace what the Family Access route does today with the service
-- role -- which bypasses both row level security AND the write barrier, so
-- every rule it obeys is one it applies to itself. Here the rules are the
-- database's own, and the route becomes a caller like any other.
--
-- THE ONE RULE THAT MATTERS MOST: NEITHER OF THESE EVER WRITES `user_id`.
-- Attaching a login to an invitation is `claim_app_member`'s job and nothing
-- else's, because only the claimant can prove which login is theirs. An
-- administrator who could write `user_id` could hand any family seat to any
-- account, which is precisely the takeover this separation prevents.
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

  -- The Area comes from the PERSON, never from the caller. A person in another
  -- family therefore lands on `require_acting_area` below, which answers the
  -- same sentence whether or not the row exists.
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
  -- The same shape `app_members_email_safe_check` enforces, checked here so the
  -- refusal is a sentence rather than a constraint name.
  if length(normalised) < 3
     or length(normalised) > 254
     or normalised ~ '[[:space:][:cntrl:]]'
     or normalised !~ '^[^@]+@[^@]+\.[^@]+$' then
    raise exception 'That is not an email address we can invite' using errcode = '22023';
  end if;

  select * into seat
  from public.app_members m
  where m.person_id = p_person_id and m.area_id = target_area;

  -- THE ADMINISTRATOR'S OWN SEAT IS NOT EDITABLE HERE, BY ANYBODY INCLUDING
  -- THEMSELVES. Administration moves through `transfer_area_admin` and departs
  -- through `leave_area`; both keep the "exactly one active administrator"
  -- invariant that this routine has no idea about.
  if seat.id is not null and seat.role = 'admin' then
    raise exception 'The family administrator''s access is changed by handing over the family, not here'
      using errcode = '42501';
  end if;

  -- The unique index on (area_id, lower(email)) would refuse this anyway; said
  -- out loud so the caller learns why rather than reading a constraint name.
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
    -- A SEAT NOBODY HAS SAT IN YET. `user_id` is left null on purpose and is
    -- not in the column list at all.
    insert into public.app_members (area_id, person_id, email, role, active)
    values (target_area, p_person_id, normalised, 'member', true);
    return;
  end if;

  if seat.user_id is null then
    -- STILL AN INVITATION. Re-addressing it is the whole point: a mistyped
    -- address is fixed here, and nothing is attached to a login yet.
    update public.app_members
    set email = normalised, active = true, updated_at = now()
    where id = seat.id;
    return;
  end if;

  -- FROM HERE THE SEAT IS CLAIMED, AND `user_id` IS THE IDENTITY -- not the
  -- email column beside it, which is a cache of what the address was when the
  -- claim happened and may be years stale.
  select lower(u.email) into linked_email
  from auth.users u
  where u.id = seat.user_id
    and u.email_confirmed_at is not null;

  if linked_email is null then
    raise exception 'The account holding this seat has no confirmed email address'
      using errcode = '42501';
  end if;

  if linked_email <> normalised then
    -- REFUSED, NOT TRANSFERRED. Moving a claimed seat to a different address
    -- would move a family membership to a different person on an
    -- administrator's say-so. Revoke with p_unlink, and let the new address
    -- claim the empty seat itself.
    raise exception 'That seat already belongs to a different account. Remove its access first.'
      using errcode = '42501';
  end if;

  -- The address matches the live, confirmed one: restore the seat, and heal the
  -- cached column if the account has since changed address.
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

create or replace function public.revoke_area_access(p_person_id uuid, p_unlink boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_area uuid;
  seat public.app_members%rowtype;
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
    raise exception 'Only this family''s administrator can take access away'
      using errcode = '42501';
  end if;

  select * into seat
  from public.app_members m
  where m.person_id = p_person_id and m.area_id = target_area;

  if seat.id is null then
    raise exception 'That family member has no access to take away' using errcode = 'P0002';
  end if;

  if seat.role = 'admin' then
    raise exception 'The family administrator''s access is changed by handing over the family, not here'
      using errcode = '42501';
  end if;

  -- LEAVING IS `leave_area`, NOT THIS. An administrator removing themselves
  -- here would skip the last-administrator check that routine exists for.
  if seat.user_id = caller then
    raise exception 'Use Leave family to remove your own access' using errcode = '42501';
  end if;

  if p_unlink then
    -- THE ONLY UNLINK PATH THERE IS, AND IT IS EXPLICIT. The seat becomes an
    -- empty chair again: a future grant re-invites it, and the next claim
    -- attaches whichever login proves that address is theirs.
    update public.app_members
    set active = false, user_id = null, updated_at = now()
    where id = seat.id;
    return;
  end if;

  -- The ordinary case. `user_id` and `email` are kept so that restoring access
  -- restores the same person's seat rather than opening it to whoever asks.
  update public.app_members
  set active = false, updated_at = now()
  where id = seat.id;
end;
$$;

revoke all on function public.revoke_area_access(uuid, boolean) from public, anon;
grant execute on function public.revoke_area_access(uuid, boolean) to authenticated;

comment on function public.revoke_area_access(uuid, boolean) is
  'Takes one family member''s access away in the acting Area. Keeps user_id unless p_unlink '
  'is explicitly true. Refuses the administrator''s seat and refuses self-removal, which is '
  'leave_area''s job (052).';

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
  -- NO AREA PARAMETER, ON PURPOSE. A routine that took one would be a routine
  -- an administrator of one family could point at another; the acting Area is
  -- already checked by the hook that set it.
  if acting is null then
    raise exception 'Say which family you are working in.' using errcode = '42501';
  end if;

  if not public.is_area_admin(acting) then
    raise exception 'Only this family''s administrator can see who has access'
      using errcode = '42501';
  end if;

  -- auth.users and app_accounts are joined ONLY through a membership row that
  -- is already in this Area, so there is no way to reach an account this family
  -- has nothing to do with, and no way to ask about an address at all.
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
-- 8. THE TWO POLICIES
-- ---------------------------------------------------------------------------

/*
 * THE MEMBERSHIP LEAK THIS CLOSES.
 *
 * Every other Area policy asks `is_area_member` or `is_active_app_member`,
 * which section 9 puts behind approval. This one asked neither: it matched on
 * `user_id = auth.uid()` directly, so a rejected or suspended account that had
 * once claimed a seat could still read that seat -- its Area id, its person id,
 * its role. Not much, but it is family data, and the rule is that there is no
 * "not much".
 */
drop policy if exists "active members may read own membership" on public.app_members;
create policy "active members may read own membership"
  on public.app_members
  for select
  using (
    user_id = (select auth.uid())
    and active = true
    and public.is_globally_approved()
  );

/*
 * THE GLOBAL DECISIONS, AND ONLY THOSE.
 *
 * A permissive policy, so it is OR'd with `members read the audit log` -- which
 * means every restriction here has to hold on its own. Four of them:
 *
 *   area_id is null                  no family's entries, ever
 *   table_name = 'app_accounts'      and not the OTHER Area-less rows, which
 *                                    include historic entries 049 could not
 *                                    attribute to any family
 *   celebrant_person_id is null      belt to the braces: 050's birthday subject
 *   birthday_privacy_unknown = false must never be reachable through this door
 *   is_global_admin()                and only a Gift Planner administrator
 */
create policy "global admins read global account decisions"
  on public.audit_log
  for select
  using (
    area_id is null
    and table_name = 'app_accounts'
    and celebrant_person_id is null
    and birthday_privacy_unknown = false
    and public.is_global_admin()
  );


-- ---------------------------------------------------------------------------
-- 9. THE NINE REDEFINITIONS
--
-- Six were named in the approved design; the other three (9b, 9b(ii)) are
-- rehearsal findings. Each is the CURRENT effective definition with one thing added and nothing
-- else changed. Diff them against `pg_get_functiondef` on a 051 database and
-- the only differences should be the comments and the gate.
-- ---------------------------------------------------------------------------

-- 9a. The three membership predicates every Area policy is built on. One
--     conjunct each, and it is the same conjunct, because "approved" is one
--     question however many families you are in.

create or replace function public.is_active_app_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_globally_approved() and exists (
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
  select public.is_globally_approved() and exists (
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
  select public.is_globally_approved() and exists (
    select 1
    from public.app_members m
    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
      and m.role = 'admin'
  );
$$;

/*
 * 9b. AND A FOURTH, WHICH THE APPROVED DESIGN DID NOT LIST -- FOUND BY REHEARSAL.
 *
 * `is_own_app_member` is the only other predicate that turns a login into a
 * family permission, and it is not reached through any of the three above. It
 * gates `notifications`, `notification_preferences` and `push_subscriptions`,
 * all of which key on an `app_member_id` rather than an `area_id` -- which is
 * why an Area-shaped sweep does not notice them.
 *
 * MEASURED, NOT SUPPOSED. On a database carrying this migration WITHOUT this
 * redefinition, an account set to `rejected` while holding a claimed active
 * membership still read its own notification rows:
 *
 *     rejected   notifications= 1  prefs= 1  push= 1
 *
 * and a notification row carries the gift itself -- title and body, e.g.
 * "Surprise weekend away". So the approved rule "pending, rejected and
 * suspended are blocked from ALL Area data at the database layer" was not true
 * with six redefinitions. It is with seven.
 *
 * The delta is the same one conjunct as the other three.
 */
create or replace function public.is_own_app_member(p_app_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_globally_approved() and exists (
    select 1
    from public.app_members m
    where m.id = p_app_member_id
      and m.user_id = (select auth.uid())
      and m.active = true
  );
$$;

/*
 * 9b(ii). AND TWO MORE, ALSO FOUND BY REHEARSAL RATHER THAN BY DESIGN.
 *
 * A MUTATION SURVIVED, AND THIS IS WHAT IT FOUND. Taking the gate off
 * `is_area_admin` broke nothing any test could see, because every test that
 * suspended an account suspended an ordinary MEMBER -- for whom
 * `is_area_admin` answers false either way. Suspending an ADMINISTRATOR
 * instead, and asking every permission predicate in the schema what it thought,
 * produced this:
 *
 *     is_active_app_member()        false   <- gated
 *     is_area_member(bravo)         false   <- gated
 *     is_area_admin(bravo)          false   <- gated
 *     is_own_app_member(...)        false   <- gated
 *     is_app_admin()                TRUE    <- not gated
 *     is_area_contributor_member()  TRUE    <- not gated
 *
 * NEITHER OF THEM LETS A SUSPENDED ACCOUNT DO ANYTHING TODAY, and that was
 * measured too, not assumed: every read is zero and every one of nineteen
 * writes is refused, because each is backstopped by a predicate that IS gated.
 * They are fixed anyway, because "you are still this family's administrator" is
 * a dangerous thing for the database to keep saying to somebody it has locked
 * out -- it is true until one refactor makes it load-bearing, and then it is a
 * hole nobody introduced.
 *
 * `is_app_admin` reaches `is_area_admin` through its acting-Area branch, which
 * is already gated; what needed the conjunct is the OTHER branch, the one that
 * answers for a caller with exactly one membership and no Area on screen. The
 * gate goes in front of the whole CASE so both branches are covered by one
 * reading of one rule.
 *
 * WHAT IS DELIBERATELY LEFT UNGATED, and why:
 *
 *   is_acting_area(uuid)      a SCOPING test -- "is this row in the family you
 *                             are standing in" -- not a permission. Every
 *                             policy that uses it also requires a gated
 *                             membership predicate, and it answers TRUE for a
 *                             null argument by design (045), which a gate would
 *                             turn into "you may not" rather than "no such row".
 *
 *   current_person_id(), current_app_member_id(),
 *   current_member_in_area(), current_person_in_area()
 *                             identity resolvers, not permissions: they answer
 *                             WHO you are, and every policy that compares
 *                             against one also asks a gated predicate. One of
 *                             them, current_person_id(), is half of migration
 *                             050's birthday-privacy comparison, and changing
 *                             what it returns is not a thing to do in passing.
 *
 * That distinction is locked in by a test, so a future gate added to either
 * group is a decision somebody makes on purpose.
 */
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_globally_approved() and case
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
  select public.is_globally_approved() and exists (
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

-- 9c. Creating a family. THE ROUTINE THIS MIGRATION EXISTS FOR. Before public
--     sign-up it was reasonable for any signed-in account to make one; the
--     moment anybody can sign in, it is the front door standing open.

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

  -- MIGRATION 052. Sign-in is not permission. An approved account may start as
  -- many families as it likes; an unapproved one may not start any.
  if not public.is_globally_approved() then
    raise exception 'Your Gift Planner account has not been approved yet'
      using errcode = '42501';
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

-- 9d. Claiming an invitation. The one routine that may write `user_id`, and
--     therefore the one place an unconfirmed address must not be believed:
--     anybody can type somebody else's email into a sign-up form, and until the
--     confirmation link is followed, "the account whose email is X" means
--     nothing at all.

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

  -- MIGRATION 052: `and email_confirmed_at is not null`. Without it, signing up
  -- as somebody else's address was enough to walk into their family.
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

-- 9e. The audit stamp. A global account decision has no family, and the
--     deciding administrator may well be standing in one of their own -- which
--     is exactly what step 2 of this function would have written onto the row.
--     The early return is what keeps `Global account set to rejected` out of
--     somebody's family activity log.

create or replace function public.stamp_audit_area()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_areas uuid[];
begin
  -- MIGRATION 052: GLOBAL DECISIONS BELONG TO NO FAMILY. Set rather than
  -- merely left alone, so a caller who supplies an area_id cannot smuggle a
  -- global entry into a family's log either.
  if new.table_name = 'app_accounts' then
    new.area_id := null;
    return new;
  end if;

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
-- 10. THE BACKFILL
--
-- CONFIRMED-ONLY, AND DERIVED, NOT LISTED. Everybody who already held an
-- active claimed membership with a confirmed email keeps working through the
-- upgrade without noticing it happened. Everybody else -- including an active
-- membership whose email was never confirmed -- stays undecided and is looked
-- at by a person. There is not one uuid written down in this file.
--
-- `decided_by` is null because there was no decider. Inventing one would be a
-- lie in the only table whose whole job is to record who decided what.
-- ---------------------------------------------------------------------------

insert into public.app_accounts (user_id, status, decided_at, decided_by, decision_note)
select distinct
  u.id,
  'approved',
  now(),
  null::uuid,
  'Backfilled by migration 052: held an active claimed membership and a confirmed email at the upgrade.'
from auth.users u
where u.email_confirmed_at is not null
  and exists (
    select 1
    from public.app_members m
    where m.user_id = u.id
      and m.active = true
  )
on conflict (user_id) do nothing;


-- ---------------------------------------------------------------------------
-- 11. END STATE
--
-- Says out loud what is now true, and refuses to finish if it is not.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  gate record;
  privilege text;
  role_name text;
  admins integer;
  approved integer;
  expected integer;
  policies integer;

  new_routines text[] := array[
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
  ];
begin
  -- 11a. The table, its guards, and the fact that no browser can see it.
  if to_regclass('public.app_accounts') is null then
    problems := problems || 'public.app_accounts was not created'::text;
  else
    if not (select c.relrowsecurity from pg_class c where c.oid = 'public.app_accounts'::regclass) then
      problems := problems || 'app_accounts does not have row level security enabled'::text;
    end if;

    select count(*) into policies from pg_policy where polrelid = 'public.app_accounts'::regclass;
    if policies <> 0 then
      problems := problems || format('app_accounts has %s policies; it must have none', policies)::text;
    end if;

    foreach role_name in array array['anon', 'authenticated'] loop
      foreach privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(role_name, 'public.app_accounts', privilege) then
          problems := problems || format('%s still holds %s on app_accounts', role_name, privilege)::text;
        end if;
      end loop;
    end loop;

    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'app_accounts' and indexname = 'app_accounts_undecided_idx'
    ) then
      problems := problems || 'app_accounts_undecided_idx is missing'::text;
    end if;

    foreach fn in array array['app_accounts_status_known', 'app_accounts_admin_must_be_approved'] loop
      if not exists (
        select 1 from pg_constraint where conrelid = 'public.app_accounts'::regclass and conname = fn
      ) then
        problems := problems || format('constraint %s is missing', fn)::text;
      end if;
    end loop;
  end if;

  -- 11b. Ten new routines: present, definer, pinned, callable by authenticated
  --      and by nobody anonymous.
  foreach fn in array new_routines loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s was not created', fn)::text;
    else
      if not (select p.prosecdef from pg_proc p where p.oid = fn::regprocedure) then
        problems := problems || format('%s is not SECURITY DEFINER', fn)::text;
      end if;
      if not exists (
        select 1 from pg_proc p, unnest(p.proconfig) as cfg
        where p.oid = fn::regprocedure and cfg in ('search_path=', 'search_path=""')
      ) then
        problems := problems || format('%s does not pin search_path to the empty string', fn)::text;
      end if;
      if not has_function_privilege('authenticated', fn, 'execute') then
        problems := problems || format('%s is not callable by authenticated', fn)::text;
      end if;
      if has_function_privilege('anon', fn, 'execute') then
        problems := problems || format('%s is callable by anon', fn)::text;
      end if;
    end if;
  end loop;

  -- 11c. The six redefinitions each carry their gate.
  for gate in
    select * from (values
      ('public.is_active_app_member()',                'public.is_globally_approved()'),
      ('public.is_area_member(uuid)',                  'public.is_globally_approved()'),
      ('public.is_area_admin(uuid)',                   'public.is_globally_approved()'),
      ('public.is_own_app_member(uuid)',               'public.is_globally_approved()'),
      ('public.is_app_admin()',                        'public.is_globally_approved()'),
      ('public.is_area_contributor_member(uuid)',      'public.is_globally_approved()'),
      ('public.create_area(text, text)',               'public.is_globally_approved()'),
      ('public.claim_app_member()',                    'email_confirmed_at is not null'),
      ('public.stamp_audit_area()',                    'app_accounts')
    ) as t(signature, needle)
  loop
    if to_regprocedure(gate.signature) is null then
      problems := problems || format('%s is missing', gate.signature)::text;
    elsif position(gate.needle in pg_get_functiondef(gate.signature::regprocedure)) = 0 then
      problems := problems || format('%s was not redefined: %s is not in its body', gate.signature, gate.needle)::text;
    end if;
  end loop;

  -- And 049's logic survived inside the one that got an early return.
  if position('public.acting_area()' in pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) = 0 then
    problems := problems || 'stamp_audit_area lost migration 049''s acting-Area step'::text;
  end if;
  if position('public.area_of_record(' in pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) = 0 then
    problems := problems || 'stamp_audit_area lost its record-derived Area step'::text;
  end if;

  -- 11d. Both policies.
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.app_members'::regclass
      and polname = 'active members may read own membership'
      and position('is_globally_approved' in pg_get_expr(polqual, polrelid)) > 0
  ) then
    problems := problems || 'the app_members own-row policy does not require global approval'::text;
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.audit_log'::regclass
      and polname = 'global admins read global account decisions'
  ) then
    problems := problems || 'the global audit policy was not created'::text;
  end if;

  -- 050's policy is left exactly as it was.
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.audit_log'::regclass
      and polname = 'members read the audit log'
      and position('birthday_privacy_unknown' in pg_get_expr(polqual, polrelid)) > 0
  ) then
    problems := problems || 'migration 050''s audit policy is missing or changed'::text;
  end if;

  -- 11d(ii). The action vocabulary was widened, not replaced.
  for gate in
    select * from (values ('added'), ('removed'), ('restored'), ('handover'),
                          ('decided'), ('granted'), ('revoked')) as t(signature)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.audit_log'::regclass
        and conname = 'audit_log_action_check'
        and position('''' || gate.signature || '''' in pg_get_constraintdef(oid)) > 0
    ) then
      problems := problems || format('audit_log.action no longer allows %L', gate.signature)::text;
    end if;
  end loop;

  -- 11e. NOBODY ADMINISTERS GIFT PLANNER YET. The first one is appointed by a
  --      documented operator statement, after a person has read the census.
  select count(*) into admins from public.app_accounts where is_global_admin = true;
  if admins <> 0 then
    problems := problems || format('%s global administrators exist; 052 must finish with none', admins)::text;
  end if;

  -- 11f. The backfill approved exactly the confirmed, claimed, active set.
  select count(*) into approved from public.app_accounts where status = 'approved';
  select count(distinct u.id) into expected
  from auth.users u
  where u.email_confirmed_at is not null
    and exists (select 1 from public.app_members m where m.user_id = u.id and m.active = true);

  if approved <> expected then
    problems := problems || format(
      'the backfill approved %s accounts but %s met the confirmed-and-claimed rule', approved, expected)::text;
  end if;

  if exists (
    select 1 from public.app_accounts a
    join auth.users u on u.id = a.user_id
    where a.status = 'approved' and u.email_confirmed_at is null
  ) then
    problems := problems || 'an account was approved without a confirmed email'::text;
  end if;

  if array_length(problems, 1) is null then
    raise notice
      'Migration 052: app_accounts created and closed to the browser; 10 routines added, 9 redefined, '
      '2 policies changed; % account(s) backfilled as approved; 0 global administrators.', approved;
  else
    raise exception 'Migration 052 did not reach its end state: %', array_to_string(problems, '; ');
  end if;
end;
$$;
