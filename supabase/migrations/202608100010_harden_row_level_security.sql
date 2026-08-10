-- Full public-schema RLS hardening for the Christmas Budget application.
--
-- This migration changes authorization metadata only. It does not mutate any
-- Christmas, budget, purchase, settlement, contributor, membership, user, or
-- gift-idea row.

-- Keep RLS explicit for every private application table, including tables
-- that were already protected by their creation migrations.
alter table public.christmas_events enable row level security;
alter table public.people enable row level security;
alter table public.christmas_recipients enable row level security;
alter table public.contributors enable row level security;
alter table public.recipient_contributions enable row level security;
alter table public.app_members enable row level security;
alter table public.gift_ideas enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_allocations enable row level security;
alter table public.settlements enable row level security;

-- No application table is public. Remove any anonymous policy that may have
-- survived an incomplete earlier deployment, including policies not known to
-- the local migration history. Authenticated policies are left untouched.
do $$
declare
  anonymous_policy record;
begin
  for anonymous_policy in
    select schemaname, tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'christmas_events',
        'people',
        'christmas_recipients',
        'contributors',
        'recipient_contributions',
        'app_members',
        'gift_ideas',
        'purchases',
        'purchase_allocations',
        'settlements'
      ])
      and roles && array['anon', 'public']::name[]
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      anonymous_policy.policyname,
      anonymous_policy.schemaname,
      anonymous_policy.tablename
    );
  end loop;
end;
$$;

-- Harden the two older SECURITY DEFINER helpers to match the fixed empty
-- search_path already used by migrations 006-009.
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

create or replace function public.claim_app_member()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.app_members
  set
    user_id = (select auth.uid()),
    updated_at = now()
  where lower(email) = lower((
    select auth_user.email
    from auth.users as auth_user
    where auth_user.id = (select auth.uid())
  ))
    and user_id is null
    and active = true;

  return found;
end;
$$;

-- A disabled account must not retain even self-read access to app_members.
-- Active members still read only their own row; active admins additionally use
-- the existing admin policy to list memberships for Family Access.
drop policy if exists "members may read own membership" on public.app_members;
create policy "active members may read own membership"
on public.app_members
for select
to authenticated
using (
  user_id = (select auth.uid())
  and active = true
);

-- Contributor allocation editing is intentionally collaborative, but the UI
-- only uses INSERT/UPDATE upserts. Remove the legacy FOR ALL policy so browser
-- clients cannot hard-delete allocation rows.
drop policy if exists "active members manage contributions"
  on public.recipient_contributions;
drop policy if exists "active members add contributions"
  on public.recipient_contributions;
create policy "active members add contributions"
on public.recipient_contributions
for insert
to authenticated
with check (public.is_active_app_member());

drop policy if exists "active members update contributions"
  on public.recipient_contributions;
create policy "active members update contributions"
on public.recipient_contributions
for update
to authenticated
using (public.is_active_app_member())
with check (public.is_active_app_member());

-- Normalize direct table grants. RLS still decides which rows an authenticated
-- user may access; these grants additionally remove operations the browser has
-- no reason to attempt. Service-role privileges are intentionally unchanged.
revoke all privileges on table public.christmas_events from public, anon, authenticated;
revoke all privileges on table public.people from public, anon, authenticated;
revoke all privileges on table public.christmas_recipients from public, anon, authenticated;
revoke all privileges on table public.contributors from public, anon, authenticated;
revoke all privileges on table public.recipient_contributions from public, anon, authenticated;
revoke all privileges on table public.app_members from public, anon, authenticated;
revoke all privileges on table public.gift_ideas from public, anon, authenticated;
revoke all privileges on table public.purchases from public, anon, authenticated;
revoke all privileges on table public.purchase_allocations from public, anon, authenticated;
revoke all privileges on table public.settlements from public, anon, authenticated;

grant select on table public.christmas_events to authenticated;
grant select, insert, update on table public.people to authenticated;
grant select, insert, update on table public.christmas_recipients to authenticated;
grant select on table public.contributors to authenticated;
grant select, insert, update on table public.recipient_contributions to authenticated;
grant select on table public.app_members to authenticated;
grant select, insert, update, delete on table public.gift_ideas to authenticated;
grant select on table public.purchases to authenticated;
grant select on table public.purchase_allocations to authenticated;
grant select on table public.settlements to authenticated;

-- Make execution privileges explicit for every application-facing
-- SECURITY DEFINER function. Trigger-only and platform-managed functions are
-- deliberately outside this list.
revoke all on function public.is_active_app_member() from public, anon, authenticated;
revoke all on function public.claim_app_member() from public, anon, authenticated;
revoke all on function public.is_app_admin() from public, anon, authenticated;
revoke all on function public.set_christmas_recipient_active(uuid, boolean) from public, anon, authenticated;
revoke all on function public.current_app_member_id() from public, anon, authenticated;
revoke all on function public.list_gift_ideas(uuid) from public, anon, authenticated;
revoke all on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_purchase_status(uuid, text) from public, anon, authenticated;
revoke all on function public.void_purchase(uuid) from public, anon, authenticated;
revoke all on function public.current_app_contributor_id(uuid) from public, anon, authenticated;
revoke all on function public.record_settlement(uuid, uuid, uuid, integer, date, text) from public, anon, authenticated;
revoke all on function public.void_settlement(uuid) from public, anon, authenticated;

grant execute on function public.is_active_app_member() to authenticated;
grant execute on function public.claim_app_member() to authenticated;
grant execute on function public.is_app_admin() to authenticated;
grant execute on function public.set_christmas_recipient_active(uuid, boolean) to authenticated;
grant execute on function public.current_app_member_id() to authenticated;
grant execute on function public.list_gift_ideas(uuid) to authenticated;
grant execute on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb) to authenticated;
grant execute on function public.set_purchase_status(uuid, text) to authenticated;
grant execute on function public.void_purchase(uuid) to authenticated;
grant execute on function public.current_app_contributor_id(uuid) to authenticated;
grant execute on function public.record_settlement(uuid, uuid, uuid, integer, date, text) to authenticated;
grant execute on function public.void_settlement(uuid) to authenticated;

-- Fail atomically if a future edit or unexpected hosted state would leave a
-- core invariant false. These checks inspect authorization metadata only.
do $$
declare
  application_tables constant text[] := array[
    'christmas_events',
    'people',
    'christmas_recipients',
    'contributors',
    'recipient_contributions',
    'app_members',
    'gift_ideas',
    'purchases',
    'purchase_allocations',
    'settlements'
  ];
begin
  if exists (
    select 1
    from unnest(application_tables) as expected(table_name)
    left join pg_catalog.pg_namespace as namespace
      on namespace.nspname = 'public'
    left join pg_catalog.pg_class as relation
      on relation.relnamespace = namespace.oid
     and relation.relname = expected.table_name
    where relation.oid is null
       or relation.relkind not in ('r', 'p')
       or not relation.relrowsecurity
  ) then
    raise exception 'RLS audit failed: every application table must exist with RLS enabled'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (application_tables)
      and roles && array['anon', 'public']::name[]
  ) then
    raise exception 'RLS audit failed: anonymous/public application policy remains'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('purchases', 'purchase_allocations', 'settlements')
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'RLS audit failed: direct financial mutation policy remains'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'recipient_contributions'
      and cmd in ('ALL', 'DELETE')
  ) then
    raise exception 'RLS audit failed: contributor allocations remain directly deletable'
      using errcode = '42501';
  end if;
end;
$$;
