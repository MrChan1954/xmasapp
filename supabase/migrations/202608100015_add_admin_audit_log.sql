-- A Global-Admin-only record of everything added or removed.
--
-- Captured by database triggers rather than in application code on purpose:
-- most of this app writes to Supabase straight from the browser through RLS and
-- RPCs, so anything that logged from a route handler would miss the majority of
-- changes. A trigger cannot be bypassed by a code path that forgets to call it,
-- and it also catches edits made from the Supabase dashboard.
--
-- Only adds and removals are recorded. Ordinary edits (renaming a person,
-- correcting a price) are deliberately not logged: the question this table
-- exists to answer is "who added or deleted that?", and logging every field
-- change would bury it.

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('added', 'removed', 'restored')),
  -- Who did it. `actor_name` is denormalised at write time so the log stays
  -- readable after a person is renamed or their account is removed — an audit
  -- record that changes retrospectively is not much of an audit record.
  actor_user_id uuid,
  actor_name text,
  summary text not null,
  details jsonb
);

create index audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index audit_log_table_name_idx on public.audit_log (table_name, occurred_at desc);

alter table public.audit_log enable row level security;

-- Match the lockdown every other table received in migration 010.
revoke all privileges on table public.audit_log from public, anon, authenticated;
grant select on table public.audit_log to authenticated;

-- Readable only by the Global Admin, and writable by nobody: rows arrive
-- exclusively through the SECURITY DEFINER trigger below, so the log cannot be
-- edited or cleared from the app even by an admin.
create policy "admins read the audit log" on public.audit_log
  for select to authenticated
  using (public.is_app_admin());

/*
 * Resolves the acting user into a name at write time.
 *
 * Returns NULL for the service-role client, which has no `auth.uid()`. The only
 * thing in this app that uses that key is the Family Access admin route, so a
 * NULL actor unambiguously means "a Global Admin acting through Family Access",
 * and the UI labels it that way rather than pretending the actor is unknown.
 */
create or replace function public.audit_actor_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.name
  from public.app_members m
  join public.people p on p.id = m.person_id
  where m.user_id = (select auth.uid())
  limit 1;
$$;

/*
 * One trigger function for every audited table.
 *
 * "Removing" is usually a soft delete in this schema, so a plain DELETE is not
 * enough to detect it:
 *   contributors, christmas_recipients, app_members  ->  active flag
 *   purchases                                        ->  deleted_at
 *   settlements                                      ->  voided_at
 * An UPDATE is therefore logged only when it flips one of those, in either
 * direction, and is ignored otherwise.
 *
 * TG_ARGV[0] names the soft-delete column, or is empty for tables that are only
 * ever hard-deleted.
 */
create or replace function public.record_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  soft_column text := nullif(TG_ARGV[0], '');
  was_removed boolean;
  is_removed boolean;
  resolved_action text;
  record_id uuid;
  -- The surviving row as jsonb. OLD is unassigned during INSERT and NEW during
  -- DELETE, and touching either raises "record is not assigned yet" — so the
  -- row is resolved once, here, and every field is read from this instead.
  payload jsonb;
  actor uuid := (select auth.uid());
  actor_name text := public.audit_actor_name();
begin
  if TG_OP = 'DELETE' then
    payload := to_jsonb(OLD);
  else
    payload := to_jsonb(NEW);
  end if;

  if TG_OP = 'INSERT' then
    resolved_action := 'added';
    record_id := NEW.id;
  elsif TG_OP = 'DELETE' then
    resolved_action := 'removed';
    record_id := OLD.id;
  else
    -- UPDATE: only interesting when it crosses the soft-delete boundary.
    if soft_column is null then
      return null;
    end if;

    if soft_column = 'active' then
      -- `active` inverts the sense: false means removed.
      was_removed := not (to_jsonb(OLD) ->> 'active')::boolean;
      is_removed := not (to_jsonb(NEW) ->> 'active')::boolean;
    else
      -- A timestamp column: non-null means removed.
      was_removed := (to_jsonb(OLD) ->> soft_column) is not null;
      is_removed := (to_jsonb(NEW) ->> soft_column) is not null;
    end if;

    if was_removed = is_removed then
      return null;
    end if;

    resolved_action := case when is_removed then 'removed' else 'restored' end;
    record_id := NEW.id;
  end if;

  insert into public.audit_log (table_name, record_id, action, actor_user_id, actor_name, summary, details)
  values (
    TG_TABLE_NAME,
    record_id,
    resolved_action,
    actor,
    actor_name,
    format('%s %s', TG_TABLE_NAME, resolved_action),
    -- Deliberately narrow: identifiers and amounts only. Never the whole row —
    -- app_members holds login emails, and a log is not the place for them.
    case TG_TABLE_NAME
      when 'purchases' then jsonb_build_object(
        'description', payload ->> 'description',
        'amount_pennies', payload ->> 'actual_price_pennies'
      )
      when 'settlements' then jsonb_build_object('amount_pennies', payload ->> 'amount_pennies')
      when 'gift_ideas' then jsonb_build_object('title', payload ->> 'title')
      when 'people' then jsonb_build_object('name', payload ->> 'name')
      when 'contributors' then jsonb_build_object('person_id', payload ->> 'person_id')
      when 'christmas_recipients' then jsonb_build_object('person_id', payload ->> 'person_id')
      when 'app_members' then jsonb_build_object(
        'person_id', payload ->> 'person_id',
        'role', payload ->> 'role'
      )
      else '{}'::jsonb
    end
  );

  return null;
end;
$$;

-- AFTER triggers throughout: the audit row is only written once the change has
-- actually committed to the table, so the log can never claim something that
-- did not happen.

create trigger audit_people
  after insert or delete on public.people
  for each row execute function public.record_audit_event('');

create trigger audit_contributors
  after insert or update or delete on public.contributors
  for each row execute function public.record_audit_event('active');

create trigger audit_christmas_recipients
  after insert or update or delete on public.christmas_recipients
  for each row execute function public.record_audit_event('active');

create trigger audit_recipient_contributions
  after insert or delete on public.recipient_contributions
  for each row execute function public.record_audit_event('');

create trigger audit_purchases
  after insert or update or delete on public.purchases
  for each row execute function public.record_audit_event('deleted_at');

create trigger audit_purchase_allocations
  after insert or delete on public.purchase_allocations
  for each row execute function public.record_audit_event('');

create trigger audit_gift_ideas
  after insert or delete on public.gift_ideas
  for each row execute function public.record_audit_event('');

create trigger audit_settlements
  after insert or update or delete on public.settlements
  for each row execute function public.record_audit_event('voided_at');

create trigger audit_app_members
  after insert or update or delete on public.app_members
  for each row execute function public.record_audit_event('active');
