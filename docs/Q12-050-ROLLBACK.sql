-- ===========================================================================
-- ROLLBACK FOR MIGRATION 050
-- ===========================================================================
--
-- Undoes 202608100050_audit_birthday_privacy_subject.sql, returning the schema
-- to its state after 049.
--
-- ORDER MATTERS. The routines and the policy both reference the two new
-- columns, so they are restored to their pre-050 text FIRST; only then can the
-- columns be dropped.
--
-- 050 wrote nothing but `celebrant_person_id` and `birthday_privacy_unknown`,
-- so dropping them discards everything it did and no historical evidence:
-- action, subject, context, details, amount, actor, timestamp and area_id were
-- never touched, including on the 26 entries that carry no Area.
--
-- This file is NOT a migration and must never be placed in supabase/migrations.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The seven routines, exactly as they stood before 050
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_audit_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  soft_column text := nullif(TG_ARGV[0], '');
  was_removed boolean;
  is_removed boolean;
  resolved_action text;
  record_id uuid;
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

  elsif TG_TABLE_NAME = 'item_photos' then
    resolved_subject := 'Photo';
    -- Never the storage path: it is the one thing that, combined with a signed
    -- URL, identifies the file, and the log is visible to the whole family.
    if (payload ->> 'purchase_id') is not null then
      select pu.description into resolved_context
      from public.purchases pu where pu.id = (payload ->> 'purchase_id')::uuid;
    else
      select g.title into resolved_context
      from public.gift_ideas g where g.id = (payload ->> 'gift_idea_id')::uuid;
    end if;
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
    format('%s %s', TG_TABLE_NAME, resolved_action),
    resolved_subject,
    resolved_context,
    resolved_amount,
    '{}'::jsonb
  );

  return null;
end;
$function$;


CREATE OR REPLACE FUNCTION public.update_event(p_event_id uuid, p_name text, p_event_date date, p_description text)
 RETURNS events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  existing public.events;
  saved_event public.events;
  clean_name text;
  clean_description text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change an event' using errcode = '42501';
  end if;

  select * into existing from public.events where id = p_event_id for update;
  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid event name' using errcode = '23514';
  end if;
  if p_event_date is null then
    raise exception 'Choose the date this event is for' using errcode = '23514';
  end if;
  clean_description := nullif(trim(coalesce(p_description, '')), '');
  if clean_description is not null and length(clean_description) > 1000 then
    raise exception 'Keep the description under 1000 characters' using errcode = '23514';
  end if;

  update public.events
  set
    name = clean_name,
    event_date = p_event_date,
    description = clean_description,
    -- A Christmas stays identified by the year of its own date, so moving it
    -- keeps the compatibility view and the one-per-year rule honest.
    year = case when existing.event_type = 'christmas' then extract(year from p_event_date)::integer else year end,
    updated_at = now()
  where id = p_event_id
  returning * into saved_event;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, details
  ) values (
    'events', p_event_id, 'restored', (select auth.uid()), public.audit_actor_name(),
    'events updated', saved_event.name, 'updated', '{}'::jsonb
  );

  return saved_event;
end;
$function$;


CREATE OR REPLACE FUNCTION public.set_event_status(p_event_id uuid, p_status text)
 RETURNS events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_event public.events;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to archive an event' using errcode = '42501';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'Choose whether the event is active or archived' using errcode = '23514';
  end if;

  update public.events
  set status = p_status, updated_at = now()
  where id = p_event_id
  returning * into saved_event;

  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, details
  ) values (
    'events', p_event_id,
    case when p_status = 'archived' then 'removed' else 'restored' end,
    (select auth.uid()), public.audit_actor_name(),
    format('events %s', case when p_status = 'archived' then 'archived' else 'reopened' end),
    saved_event.name, p_status, '{}'::jsonb
  );

  return saved_event;
end;
$function$;


CREATE OR REPLACE FUNCTION public.delete_event_if_empty(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_event public.events;
  blocker text;
  blocking_count bigint;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Only the Global Admin can delete an event' using errcode = '42501';
  end if;

  select * into target_event from public.events where id = p_event_id;
  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  -- Each category is counted rather than merely tested, so the refusal can say
  -- what is actually there. The order is the order a reader would care about:
  -- money first.
  select 'purchases', count(*) into blocker, blocking_count
  from public.purchases as purchase
  join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_event_id;
  if blocking_count = 0 then
    select 'purchase allocations', count(*) into blocker, blocking_count
    from public.purchase_allocations as allocation
    join public.purchases as purchase on purchase.id = allocation.purchase_id
    join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
    where recipient.christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    select 'payments', count(*) into blocker, blocking_count
    from public.settlements
    where christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    -- Confirmations and rejections are both rows in `payment_receipts`, which
    -- carries its own event id: there is no separate confirmations table.
    select 'payment confirmations or rejections', count(*) into blocker, blocking_count
    from public.payment_receipts
    where christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    select 'gift ideas', count(*) into blocker, blocking_count
    from public.gift_ideas as idea
    join public.christmas_recipients as recipient on recipient.id = idea.christmas_recipient_id
    where recipient.christmas_event_id = p_event_id;
  end if;

  if blocking_count > 0 then
    raise exception
      'This event has % % and cannot be deleted. Archive it instead — archiving keeps every record.',
      blocking_count, blocker
      using errcode = '23503';
  end if;

  -- Recorded BEFORE the delete, so the log survives whatever the delete does.
  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details
  )
  values (
    'events',
    target_event.id,
    'removed',
    (select auth.uid()),
    public.audit_actor_name(),
    'events removed',
    target_event.name,
    'event',
    null,
    jsonb_build_object(
      'event_type', target_event.event_type,
      'event_date', target_event.event_date,
      'reason', 'empty occurrence deleted by Global Admin'
    )
  );

  -- Cascades take the recipients, contributors and their zero-value plan rows.
  delete from public.events where id = p_event_id;
  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.set_purchase_status(p_purchase_id uuid, p_status text)
 RETURNS purchases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_purchase public.purchases;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_purchase(p_purchase_id));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_status not in ('purchased', 'wrapped') then
    raise exception 'Choose Purchased or Wrapped' using errcode = '23514';
  end if;

  update public.purchases
  set
    status = p_status,
    updated_by_app_member_id = public.current_app_member_id(),
    updated_at = now()
  where id = p_purchase_id
    and deleted_at is null
  returning * into saved_purchase;

  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  return saved_purchase;
end;
$function$;


CREATE OR REPLACE FUNCTION public.void_purchase(p_purchase_id uuid)
 RETURNS purchases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_purchase public.purchases;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_purchase(p_purchase_id));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  update public.purchases
  set
    deleted_at = now(),
    deleted_by_app_member_id = public.current_app_member_id(),
    updated_by_app_member_id = public.current_app_member_id(),
    updated_at = now()
  where id = p_purchase_id
    and deleted_at is null
  returning * into saved_purchase;

  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  return saved_purchase;
end;
$function$;


CREATE OR REPLACE FUNCTION public.save_gift_idea(p_gift_idea_id uuid, p_christmas_recipient_id uuid, p_title text, p_estimated_price_pennies integer, p_retailer text, p_url text, p_notes text)
 RETURNS gift_ideas
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_idea public.gift_ideas;
  existing_recipient_id uuid;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(coalesce(public.area_of_gift_idea(p_gift_idea_id), public.area_of_recipient(p_christmas_recipient_id)));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_christmas_recipient_id is null or not exists (
    select 1 from public.christmas_recipients where id = p_christmas_recipient_id
  ) then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;
  if p_title is null
     or length(trim(p_title)) not between 1 and 200
     or trim(p_title) ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid gift idea' using errcode = '23514';
  end if;
  if p_estimated_price_pennies is not null and p_estimated_price_pennies < 0 then
    raise exception 'Enter a valid estimated price' using errcode = '23514';
  end if;
  if p_retailer is not null and (
    length(trim(p_retailer)) not between 1 and 200
    or trim(p_retailer) ~ '[[:cntrl:]]'
  ) then
    raise exception 'Enter a valid retailer' using errcode = '23514';
  end if;
  if p_notes is not null and (
    length(trim(p_notes)) not between 1 and 4000
    or translate(p_notes, E'\n\r\t', '') ~ '[[:cntrl:]]'
  ) then
    raise exception 'Enter valid gift notes' using errcode = '23514';
  end if;
  if p_url is not null and (
    length(p_url) not between 1 and 2048
    or p_url <> trim(p_url)
    or p_url ~ '[[:space:][:cntrl:]]'
    or p_url !~* '^https?://[^/?#@]+([/?#][^[:space:]]*)?$'
  ) then
    raise exception 'Enter a valid HTTP or HTTPS product link' using errcode = '23514';
  end if;

  if p_gift_idea_id is null then
    if not exists (
      select 1
      from public.christmas_recipients
      where id = p_christmas_recipient_id and active = true
    ) then
      raise exception 'Gift ideas can only be added for an active recipient'
        using errcode = '23514';
    end if;

    insert into public.gift_ideas (
      christmas_recipient_id,
      title,
      estimated_price_pennies,
      retailer,
      url,
      notes,
      suggested_by_app_member_id
    ) values (
      p_christmas_recipient_id,
      trim(p_title),
      p_estimated_price_pennies,
      nullif(trim(p_retailer), ''),
      nullif(trim(p_url), ''),
      nullif(trim(p_notes), ''),
      public.current_app_member_id()
    ) returning * into saved_idea;
  else
    select christmas_recipient_id into existing_recipient_id
    from public.gift_ideas
    where id = p_gift_idea_id;

    if existing_recipient_id is null then
      raise exception 'Gift idea not found' using errcode = 'P0002';
    end if;
    if existing_recipient_id <> p_christmas_recipient_id then
      raise exception 'A gift idea cannot be moved to another recipient'
        using errcode = '23514';
    end if;

    update public.gift_ideas
    set
      title = trim(p_title),
      estimated_price_pennies = p_estimated_price_pennies,
      retailer = nullif(trim(p_retailer), ''),
      url = nullif(trim(p_url), ''),
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_gift_idea_id
    returning * into saved_idea;
  end if;

  return saved_idea;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The policy, exactly as 036 left it
-- ---------------------------------------------------------------------------

drop policy "members read the audit log" on public.audit_log;

create policy "members read the audit log" on public.audit_log for select
using (
  public.is_active_app_member()
  and public.is_area_member(area_id)
);

-- ---------------------------------------------------------------------------
-- The columns and everything attached to them
-- ---------------------------------------------------------------------------

drop index if exists public.audit_log_celebrant_idx;

alter table public.audit_log
  drop constraint if exists audit_log_privacy_subject_is_coherent;

alter table public.audit_log
  drop column if exists birthday_privacy_unknown,
  drop column if exists celebrant_person_id;
