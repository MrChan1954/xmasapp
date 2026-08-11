-- Two changes to the activity log from migration 015.
--
-- 1. Everyone can read it. It was Global-Admin-only; in a shared family budget
--    the more useful property is that anyone can see who added or removed
--    something, so the policy now admits any active member. Nothing is newly
--    exposed: every name below is already visible throughout the app, and login
--    emails are deliberately still kept out of the log entirely.
--
-- 2. Entries carry real detail. The original trigger stored raw identifiers, so
--    a contributor being removed read only as "Contributor" with no name. Names
--    are now resolved at write time into structured columns, which also lets the
--    UI filter and sort without parsing prose.

alter table public.audit_log add column if not exists subject text;
alter table public.audit_log add column if not exists context text;
alter table public.audit_log add column if not exists amount_pennies integer;

comment on column public.audit_log.subject is 'What was affected, in family language: a gift name, a person, an amount.';
comment on column public.audit_log.context is 'Who or what it related to: the recipient, or the two sides of a payment.';

-- Sorting by amount and filtering by actor are both first-class in the UI now.
create index if not exists audit_log_actor_idx on public.audit_log (actor_name, occurred_at desc);
create index if not exists audit_log_action_idx on public.audit_log (action, occurred_at desc);

drop policy if exists "admins read the audit log" on public.audit_log;

-- Any active member may read. Still no insert/update/delete policy and still
-- only SELECT granted, so the log remains append-only from the app's point of
-- view — nobody can edit or clear their own trail, admin included.
create policy "members read the audit log" on public.audit_log
  for select to authenticated
  using (public.is_active_app_member());

/*
 * Replaces the trigger function from migration 015.
 *
 * Same guarantees as before — AFTER triggers, adds and removals only, soft
 * deletes detected by column transition — with names resolved so an entry reads
 * as "Removed contributor Kirsten" rather than "contributors removed".
 *
 * Every lookup is a plain SELECT INTO, which yields NULL rather than raising
 * when the related row has already gone. That matters: this function runs
 * inside the caller's transaction, so an exception here would roll back the
 * user's actual purchase or deletion.
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
  -- OLD is unassigned during INSERT and NEW during DELETE, so the surviving row
  -- is resolved once here and every field is read from this.
  payload jsonb;
  actor uuid := (select auth.uid());
  actor_name text := public.audit_actor_name();
  resolved_subject text;
  resolved_context text;
  resolved_amount integer;
  helper text;
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
    if soft_column is null then
      return null;
    end if;

    if soft_column = 'active' then
      was_removed := not (to_jsonb(OLD) ->> 'active')::boolean;
      is_removed := not (to_jsonb(NEW) ->> 'active')::boolean;
    else
      was_removed := (to_jsonb(OLD) ->> soft_column) is not null;
      is_removed := (to_jsonb(NEW) ->> soft_column) is not null;
    end if;

    if was_removed = is_removed then
      return null;
    end if;

    resolved_action := case when is_removed then 'removed' else 'restored' end;
    record_id := NEW.id;
  end if;

  if TG_TABLE_NAME = 'people' then
    resolved_subject := payload ->> 'name';

  elsif TG_TABLE_NAME = 'contributors' then
    select p.name into resolved_subject
    from public.people p where p.id = (payload ->> 'person_id')::uuid;

  elsif TG_TABLE_NAME = 'christmas_recipients' then
    select p.name into resolved_subject
    from public.people p where p.id = (payload ->> 'person_id')::uuid;
    resolved_amount := (payload ->> 'budget_pennies')::integer;

  elsif TG_TABLE_NAME = 'recipient_contributions' then
    select p.name into resolved_subject
    from public.contributors c
    join public.people p on p.id = c.person_id
    where c.id = (payload ->> 'contributor_id')::uuid;
    select p.name into resolved_context
    from public.christmas_recipients r
    join public.people p on p.id = r.person_id
    where r.id = (payload ->> 'christmas_recipient_id')::uuid;
    resolved_amount := (payload ->> 'planned_amount_pennies')::integer;

  elsif TG_TABLE_NAME = 'purchases' then
    resolved_subject := payload ->> 'description';
    resolved_amount := (payload ->> 'actual_price_pennies')::integer;
    select p.name into resolved_context
    from public.christmas_recipients r
    join public.people p on p.id = r.person_id
    where r.id = (payload ->> 'christmas_recipient_id')::uuid;

  elsif TG_TABLE_NAME = 'purchase_allocations' then
    select p.name into resolved_subject
    from public.contributors c
    join public.people p on p.id = c.person_id
    where c.id = (payload ->> 'contributor_id')::uuid;
    resolved_amount := (payload ->> 'responsibility_pennies')::integer;
    select pu.description into resolved_context
    from public.purchases pu where pu.id = (payload ->> 'purchase_id')::uuid;

  elsif TG_TABLE_NAME = 'gift_ideas' then
    resolved_subject := payload ->> 'title';
    resolved_amount := (payload ->> 'estimated_price_pennies')::integer;
    select p.name into resolved_context
    from public.christmas_recipients r
    join public.people p on p.id = r.person_id
    where r.id = (payload ->> 'christmas_recipient_id')::uuid;

  elsif TG_TABLE_NAME = 'settlements' then
    resolved_amount := (payload ->> 'amount_pennies')::integer;
    select p.name into resolved_subject
    from public.contributors c
    join public.people p on p.id = c.person_id
    where c.id = (payload ->> 'payer_contributor_id')::uuid;
    select p.name into helper
    from public.contributors c
    join public.people p on p.id = c.person_id
    where c.id = (payload ->> 'payee_contributor_id')::uuid;
    resolved_context := helper;

  elsif TG_TABLE_NAME = 'app_members' then
    select p.name into resolved_subject
    from public.people p where p.id = (payload ->> 'person_id')::uuid;
    resolved_context := payload ->> 'role';
  end if;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details
  )
  values (
    TG_TABLE_NAME,
    record_id,
    resolved_action,
    actor,
    actor_name,
    -- Kept for compatibility with rows written by migration 015; the UI now
    -- composes its own wording from the structured columns.
    format('%s %s', TG_TABLE_NAME, resolved_action),
    resolved_subject,
    resolved_context,
    resolved_amount,
    -- Still deliberately narrow. Never the whole row: app_members holds login
    -- emails, and an audit log readable by the whole family is not the place
    -- for them.
    '{}'::jsonb
  );

  return null;
end;
$$;
