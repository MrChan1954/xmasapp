create table public.contributors (
  id uuid primary key default gen_random_uuid(),
  christmas_event_id uuid not null references public.christmas_events(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (christmas_event_id, person_id)
);

create table public.recipient_contributions (
  id uuid primary key default gen_random_uuid(),
  christmas_recipient_id uuid not null references public.christmas_recipients(id) on delete cascade,
  contributor_id uuid not null references public.contributors(id) on delete cascade,
  planned_amount_pennies integer not null default 0 check (planned_amount_pennies >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (christmas_recipient_id, contributor_id)
);

alter table public.contributors enable row level security;
alter table public.recipient_contributions enable row level security;

-- TEMPORARY DEVELOPMENT POLICIES: replace unauthenticated policies when auth is introduced.
create policy "temporary public read contributors" on public.contributors for select to anon, authenticated using (true);
create policy "temporary public write contributors" on public.contributors for all to anon, authenticated using (true) with check (true);
create policy "temporary public read contributions" on public.recipient_contributions for select to anon, authenticated using (true);
create policy "temporary public write contributions" on public.recipient_contributions for all to anon, authenticated using (true) with check (true);
