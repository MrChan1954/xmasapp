create table public.app_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text unique,
  person_id uuid references public.people(id) on delete set null,
  contributor_id uuid references public.contributors(id) on delete set null,
  role text not null default 'family',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_members enable row level security;
-- Temporary development policy: replace with tighter member self-read rules when the family is onboarded.
create policy "members may read own membership" on public.app_members for select to authenticated using (user_id = auth.uid());
create policy "invited email lookup for magic link" on public.app_members for select to anon using (active = true);

-- Replace the earlier unauthenticated data policies. Christmas data requires an active member session.
do $$ declare table_name text; begin
  foreach table_name in array array['christmas_events','people','christmas_recipients','contributors','recipient_contributions'] loop
    execute format('drop policy if exists "temporary public read %s" on public.%I', replace(table_name, '_', ' '), table_name);
    execute format('drop policy if exists "temporary public write %s" on public.%I', replace(table_name, '_', ' '), table_name);
  end loop;
end $$;

create or replace function public.is_active_app_member()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.app_members where user_id = auth.uid() and active = true); $$;

create policy "active members read events" on public.christmas_events for select to authenticated using (public.is_active_app_member());
create policy "active members manage events" on public.christmas_events for all to authenticated using (public.is_active_app_member()) with check (public.is_active_app_member());
create policy "active members read people" on public.people for select to authenticated using (public.is_active_app_member());
create policy "active members manage people" on public.people for all to authenticated using (public.is_active_app_member()) with check (public.is_active_app_member());
create policy "active members read recipients" on public.christmas_recipients for select to authenticated using (public.is_active_app_member());
create policy "active members manage recipients" on public.christmas_recipients for all to authenticated using (public.is_active_app_member()) with check (public.is_active_app_member());
create policy "active members read contributors" on public.contributors for select to authenticated using (public.is_active_app_member());
create policy "active members manage contributors" on public.contributors for all to authenticated using (public.is_active_app_member()) with check (public.is_active_app_member());
create policy "active members read contributions" on public.recipient_contributions for select to authenticated using (public.is_active_app_member());
create policy "active members manage contributions" on public.recipient_contributions for all to authenticated using (public.is_active_app_member()) with check (public.is_active_app_member());

-- Add four approved membership slots. Fill email, person_id and contributor_id before testing login.
insert into public.app_members (email, person_id, contributor_id)
select null, p.id, c.id from public.people p join public.contributors c on c.person_id = p.id where p.name in ('Jade','Kirsten','Paige','Taylor') and c.christmas_event_id = (select id from public.christmas_events where year = 2026) on conflict do nothing;
