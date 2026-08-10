create extension if not exists pgcrypto;

create table public.christmas_events (
  id uuid primary key default gen_random_uuid(),
  year integer not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.christmas_recipients (
  id uuid primary key default gen_random_uuid(),
  christmas_event_id uuid not null references public.christmas_events(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  active boolean not null default true,
  budget_pennies integer not null default 0 check (budget_pennies >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (christmas_event_id, person_id)
);

alter table public.christmas_events enable row level security;
alter table public.people enable row level security;
alter table public.christmas_recipients enable row level security;

-- TEMPORARY DEVELOPMENT POLICIES: replace these unauthenticated policies when auth is introduced.
create policy "temporary public read events" on public.christmas_events for select to anon, authenticated using (true);
create policy "temporary public write events" on public.christmas_events for all to anon, authenticated using (true) with check (true);
create policy "temporary public read people" on public.people for select to anon, authenticated using (true);
create policy "temporary public write people" on public.people for all to anon, authenticated using (true) with check (true);
create policy "temporary public read recipients" on public.christmas_recipients for select to anon, authenticated using (true);
create policy "temporary public write recipients" on public.christmas_recipients for all to anon, authenticated using (true) with check (true);

insert into public.christmas_events (year, name) values (2026, 'Christmas 2026');
