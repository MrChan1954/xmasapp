-- Family Access authorization and structural-data protections.
--
-- This migration deliberately does not change any Christmas, contributor, or
-- membership rows. It narrows the broad policies installed during the initial
-- authenticated-development phase and adds reusable role-based authorization.

create or replace function public.is_app_admin()
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
      and role = 'admin'
  );
$$;

revoke all on function public.is_app_admin() from public;
revoke all on function public.is_app_admin() from anon;
grant execute on function public.is_app_admin() to authenticated;

-- Migration 004 attempted to remove these by deriving policy names from table
-- names. Three of the derived names did not match the original policies
-- (events, recipients, and contributions), so explicitly remove every legacy
-- anonymous development policy. Without this, the old recipient write policy
-- would override the admin-only policy below because RLS policies are
-- permissive (ORed) by default.
drop policy if exists "temporary public read events" on public.christmas_events;
drop policy if exists "temporary public write events" on public.christmas_events;
drop policy if exists "temporary public read people" on public.people;
drop policy if exists "temporary public write people" on public.people;
drop policy if exists "temporary public read recipients" on public.christmas_recipients;
drop policy if exists "temporary public write recipients" on public.christmas_recipients;
drop policy if exists "temporary public read contributors" on public.contributors;
drop policy if exists "temporary public write contributors" on public.contributors;
drop policy if exists "temporary public read contributions" on public.recipient_contributions;
drop policy if exists "temporary public write contributions" on public.recipient_contributions;

-- app_members is self-readable so the request protection layer can validate a
-- session. Global Admins may additionally list memberships. All membership
-- writes remain confined to the protected server endpoint, which also guards
-- the sole admin row even though its server secret bypasses RLS.
-- The original anonymous email lookup is no longer required now that accounts
-- are provisioned through protected server-side Auth Admin endpoints.
drop policy if exists "invited email lookup for magic link" on public.app_members;

drop policy if exists "admins read all memberships" on public.app_members;
create policy "admins read all memberships"
on public.app_members
for select
to authenticated
using (public.is_app_admin());

-- Account mutations go only through the independently-authorized server-only
-- Family Access endpoint. Do not add browser-token INSERT/UPDATE/DELETE
-- policies here: the endpoint's secret-key client bypasses RLS after checking
-- the caller, while ordinary browser sessions remain read-only.
drop policy if exists "admins create memberships" on public.app_members;
drop policy if exists "admins update memberships" on public.app_members;
drop policy if exists "admins delete memberships" on public.app_members;

-- Prevent duplicate memberships for one person, case-variant duplicate login
-- emails, and more than one Global Admin. NULL values remain available for the
-- existing unprovisioned membership slots.
create unique index if not exists app_members_one_membership_per_person_idx
  on public.app_members (person_id)
  where person_id is not null;

create unique index if not exists app_members_email_case_insensitive_idx
  on public.app_members (lower(email))
  where email is not null;

create unique index if not exists app_members_single_admin_idx
  on public.app_members (role)
  where role = 'admin';

alter table public.app_members alter column role set default 'member';

-- Initial authentication policies granted every active member ALL access to
-- these structural tables. Remove them. Active members retain their existing
-- read policies, and the existing recipient_contributions policy remains so
-- family members can still manage non-destructive contributor allocations.
-- Only the person/recipient INSERT and UPDATE operations used by the current
-- admin UI are restored; permanent DELETE is intentionally unavailable.
drop policy if exists "active members manage events" on public.christmas_events;
drop policy if exists "active members manage people" on public.people;
drop policy if exists "active members manage recipients" on public.christmas_recipients;
drop policy if exists "active members manage contributors" on public.contributors;

drop policy if exists "admins manage events" on public.christmas_events;
drop policy if exists "admins manage people" on public.people;
drop policy if exists "admins create people" on public.people;
create policy "admins create people"
on public.people
for insert
to authenticated
with check (public.is_app_admin());

drop policy if exists "admins update people" on public.people;
create policy "admins update people"
on public.people
for update
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "admins manage recipients" on public.christmas_recipients;
drop policy if exists "admins create recipients" on public.christmas_recipients;
create policy "admins create recipients"
on public.christmas_recipients
for insert
to authenticated
with check (public.is_app_admin());

drop policy if exists "admins update recipients" on public.christmas_recipients;
create policy "admins update recipients"
on public.christmas_recipients
for update
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "admins manage contributors" on public.contributors;

-- Explicit archive/restore entry point used by the People UI. It independently
-- checks the caller's active admin membership before bypassing table RLS.
create or replace function public.set_christmas_recipient_active(
  p_christmas_recipient_id uuid,
  p_active boolean
)
returns public.christmas_recipients
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_recipient public.christmas_recipients;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required'
      using errcode = '42501';
  end if;

  update public.christmas_recipients
  set
    active = p_active,
    updated_at = now()
  where id = p_christmas_recipient_id
  returning * into updated_recipient;

  if not found then
    raise exception 'Christmas recipient not found'
      using errcode = 'P0002';
  end if;

  return updated_recipient;
end;
$$;

revoke all on function public.set_christmas_recipient_active(uuid, boolean) from public;
revoke all on function public.set_christmas_recipient_active(uuid, boolean) from anon;
grant execute on function public.set_christmas_recipient_active(uuid, boolean) to authenticated;
