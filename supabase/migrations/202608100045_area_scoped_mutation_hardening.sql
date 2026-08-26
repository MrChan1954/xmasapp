-- Authorising in one family and writing in another.
--
-- THE SHAPE, EXACTLY
--
--   Almost every mutation in this database was written when there was one
--   family, and follows the same two steps:
--
--       if not public.is_app_admin() then raise ... end if;      -- may I?
--       update public.<table> ... where id = p_target_id;        -- do it
--
--   Migration 038 taught `is_app_admin()` to answer about the Area the caller
--   SAID they are acting in. It could not teach these routines which Area they
--   are WRITING to, because they never ask. So the question and the row came
--   apart:
--
--       "Am I an administrator?"        -> of Alpha, yes.
--       "...of the family this row is   -> never asked.
--        in?"
--
--   Migration 037's write barrier does not close it. That refuses a writer who
--   is not a MEMBER of the row's Area -- exactly right for a stranger, and no
--   help at all against somebody who belongs to both families.
--
-- MEASURED, NOT ASSUMED
--
--   Against a real PostgreSQL with 001-044 applied, the fixture account that
--   administers Alpha and merely belongs to Bravo was pointed at Bravo rows
--   while acting in Alpha. Of sixteen routines tried, NOT ONE refused with
--   42501. Eight wrote to Bravo outright -- archiving its event, adding a
--   recipient, electing a contributor, deactivating a recipient, rewriting a
--   gift idea, changing a purchase's status, voiding a purchase and voiding a
--   settlement. The other eight passed authorisation and were stopped only by
--   a business rule about the arguments, which a different argument set would
--   satisfy.
--
--   The same account, an administrator of BOTH Alpha and Charlie, renamed and
--   archived Charlie while acting in Alpha, and left Bravo while acting in
--   Alpha.
--
-- THE FIX, AND WHY IT IS ONE LINE PER ROUTINE
--
--   `require_acting_area(target)` is added as the first statement of each
--   routine. It resolves nothing about permission -- it only insists that the
--   Area of the row being changed is the Area the caller is standing in.
--
--   Once that holds, every existing `is_app_admin()` beneath it is ALREADY a
--   question about the target Area, because the acting Area and the target Area
--   are now the same Area. That is why no role check, no validation, no error
--   code, no audit write and no return shape is touched: the bodies below are
--   the current ones, reproduced verbatim from the catalogue, with one guard
--   line inserted. The diff per routine is that line.
--
--   THE SELECTED FAMILY IS AUTHORITATIVE. An administrator of two families who
--   is standing in Alpha may not change Bravo by quoting a Bravo id. They
--   switch to Bravo first, exactly as the rest of the application already
--   requires. That is not a new rule; it is the rule the switcher has always
--   implied and the database never enforced.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits NO row of any kind. Function bodies only.
--   * It changes no policy, no table, no column, no constraint and no trigger.
--   * It changes no signature, so no application call site changes.
--   * It widens nothing: every routine refuses strictly more than before. A
--     caller working inside their own family sees no difference whatsoever.
--   * It rewrites no budget, purchase, allocation, settlement or receipt, and
--     touches Christmas 2026 in no way at all.
--
-- MIGRATIONS 001-044 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.acting_area') is null then
    raise exception 'Migration 038 has not been applied: acting_area is missing.';
  end if;
  if to_regproc('public.area_of_event') is null or to_regproc('public.area_of_recipient') is null then
    raise exception 'Migration 035 has not been applied: the area_of_* helpers are missing.';
  end if;
  if to_regprocedure('public.set_person_name(uuid, text)') is null then
    raise exception 'Migration 044 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The Area of a settlement
--
-- The one link in the chain that had no helper. A settlement belongs to an
-- event, and the event belongs to a family.
-- ---------------------------------------------------------------------------

create or replace function public.area_of_settlement(p_settlement_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select public.area_of_event(s.christmas_event_id)
  from public.settlements s
  where s.id = p_settlement_id;
$$;

revoke all on function public.area_of_settlement(uuid) from public, anon;
grant execute on function public.area_of_settlement(uuid) to authenticated;

comment on function public.area_of_settlement(uuid) is
  'The Area a settlement belongs to, through its event. Reads nothing financial.';

-- ---------------------------------------------------------------------------
-- 2. THE GUARD
--
-- WHY A NULL TARGET RETURNS QUIETLY. A null Area means the row does not exist,
-- and the routine underneath is about to say so in its own words with its own
-- error code -- 'That event could not be found', P0002. Raising here instead
-- would replace every "not found" in the application with an authorisation
-- error, which is both a worse message and a behaviour change this migration
-- has no business making. Nothing can be written through a row that is not
-- there.
--
-- WHY "NO ACTING AREA" IS NOT A WAY ROUND IT. The acting Area comes from a
-- header, so a caller can simply omit it. With none claimed, this falls back to
-- migration 038's own rule: a login with exactly ONE active membership is
-- unambiguous and may proceed if the target is that Area; a login with several
-- is refused, because refusing to guess is the whole reason 038 exists. So
-- omitting the header gains a multi-family caller nothing.
-- ---------------------------------------------------------------------------

create or replace function public.require_acting_area(p_area_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  acting uuid;
  memberships integer;
begin
  -- No such row. Let the caller's own "not found" answer stand.
  if p_area_id is null then
    return;
  end if;

  acting := public.acting_area();

  if acting is not null then
    if acting <> p_area_id then
      -- Deliberately the same sentence whichever family it belongs to, so this
      -- cannot be used to discover what exists elsewhere.
      raise exception 'That belongs to another family. Switch to that family first.'
        using errcode = '42501';
    end if;
    return;
  end if;

  select count(*) into memberships
  from public.app_members m
  where m.user_id = (select auth.uid()) and m.active = true;

  if memberships <> 1 then
    raise exception 'Say which family you are working in.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.app_members m
    where m.user_id = (select auth.uid()) and m.active = true and m.area_id = p_area_id
  ) then
    raise exception 'That belongs to another family. Switch to that family first.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.require_acting_area(uuid) from public, anon;
grant execute on function public.require_acting_area(uuid) to authenticated;

comment on function public.require_acting_area(uuid) is
  'Refuses unless the Area of the row being changed is the Area the caller is acting in. Not a permission check: the routine''s own role check still runs, and now runs about the right family.';

-- ---------------------------------------------------------------------------
-- 3. Every targeted mutation, guarded
--
-- Each body below is the CURRENT definition, reproduced from the catalogue,
-- with one `require_acting_area` line added after its opening `begin`. Nothing
-- else in any of them has changed.
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------------------
-- set_event_status  ->  public.area_of_event(p_event_id)
-- ------------------------------------------------------------------------

create or replace function public.set_event_status(p_event_id uuid, p_status text)
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
$function$
;

-- ------------------------------------------------------------------------
-- update_event  ->  public.area_of_event(p_event_id)
-- ------------------------------------------------------------------------

create or replace function public.update_event(p_event_id uuid, p_name text, p_event_date date, p_description text)
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
$function$
;

-- ------------------------------------------------------------------------
-- delete_event_if_empty  ->  public.area_of_event(p_event_id)
-- ------------------------------------------------------------------------

create or replace function public.delete_event_if_empty(p_event_id uuid)
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
$function$
;

-- ------------------------------------------------------------------------
-- add_event_recipient  ->  public.area_of_event(p_event_id)
-- ------------------------------------------------------------------------

create or replace function public.add_event_recipient(p_event_id uuid, p_person_id uuid)
 RETURNS christmas_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_recipient public.christmas_recipients;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to add a recipient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.people where id = p_person_id) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
  values (p_event_id, p_person_id, 0, true)
  on conflict (christmas_event_id, person_id)
  do update set active = true
  returning * into saved_recipient;

  insert into public.recipient_contributions (
    christmas_recipient_id, contributor_id, planned_amount_pennies
  )
  select saved_recipient.id, contributor.id, 0
  from public.contributors as contributor
  where contributor.christmas_event_id = p_event_id
    and contributor.active = true
  on conflict (christmas_recipient_id, contributor_id) do nothing;

  return saved_recipient;
end;
$function$
;

-- ------------------------------------------------------------------------
-- set_event_contributor  ->  public.area_of_event(p_event_id)
-- ------------------------------------------------------------------------

create or replace function public.set_event_contributor(p_event_id uuid, p_person_id uuid, p_active boolean)
 RETURNS contributors
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  saved_contributor public.contributors;
  planned_total bigint;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change contributors' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.people where id = p_person_id) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  if not p_active then
    -- The same rule Family Access has always applied: somebody carrying part of
    -- a plan cannot simply vanish from it.
    select coalesce(sum(contribution.planned_amount_pennies), 0)
    into planned_total
    from public.recipient_contributions as contribution
    join public.contributors as contributor on contributor.id = contribution.contributor_id
    where contributor.christmas_event_id = p_event_id
      and contributor.person_id = p_person_id;

    if planned_total > 0 then
      raise exception 'Reassign this person''s planned amounts before removing them from the event'
        using errcode = '23514';
    end if;
  end if;

  insert into public.contributors (christmas_event_id, person_id, active)
  values (p_event_id, p_person_id, p_active)
  on conflict (christmas_event_id, person_id)
  do update set active = excluded.active
  returning * into saved_contributor;

  -- A newly active contributor must appear in every active recipient's plan, at
  -- zero, or the budget invariant from migration 012 would reject the next
  -- edit to any of them.
  if p_active then
    insert into public.recipient_contributions (
      christmas_recipient_id, contributor_id, planned_amount_pennies
    )
    select recipient.id, saved_contributor.id, 0
    from public.christmas_recipients as recipient
    where recipient.christmas_event_id = p_event_id
      and recipient.active = true
    on conflict (christmas_recipient_id, contributor_id) do nothing;
  end if;

  return saved_contributor;
end;
$function$
;

-- ------------------------------------------------------------------------
-- set_christmas_recipient_active  ->  public.area_of_recipient(p_christmas_recipient_id)
-- ------------------------------------------------------------------------

create or replace function public.set_christmas_recipient_active(p_christmas_recipient_id uuid, p_active boolean)
 RETURNS christmas_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  updated_recipient public.christmas_recipients;
  recipient_budget_pennies integer;
  allocation_total bigint;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_recipient(p_christmas_recipient_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required'
      using errcode = '42501';
  end if;

  if p_active then
    select recipient.budget_pennies,
      coalesce(sum(contribution.planned_amount_pennies), 0)
    into recipient_budget_pennies, allocation_total
    from public.christmas_recipients as recipient
    left join public.recipient_contributions as contribution
      on contribution.christmas_recipient_id = recipient.id
    where recipient.id = p_christmas_recipient_id
    group by recipient.id, recipient.budget_pennies;

    if not found then
      raise exception 'Christmas recipient not found' using errcode = 'P0002';
    end if;
    if allocation_total <> recipient_budget_pennies then
      raise exception 'Contributor allocations must equal the recipient budget before restoring this person'
        using errcode = '23514';
    end if;
  end if;

  update public.christmas_recipients
  set active = p_active, updated_at = now()
  where id = p_christmas_recipient_id
  returning * into updated_recipient;

  if not found then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;

  return updated_recipient;
end;
$function$
;

-- ------------------------------------------------------------------------
-- save_christmas_recipient_with_contributions  ->  coalesce(public.area_of_recipient(p_christmas_recipient_id), public.area_of_event(p_christmas_event_id))
-- ------------------------------------------------------------------------

create or replace function public.save_christmas_recipient_with_contributions(p_christmas_recipient_id uuid, p_christmas_event_id uuid, p_name text, p_budget_pennies integer, p_allocations jsonb)
 RETURNS christmas_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target_event_id uuid;
  linked_person_id uuid;
  existing_name text;
  existing_budget_pennies integer;
  existing_is_active boolean;
  details_changed boolean := false;
  allocation_count integer;
  distinct_contributor_count integer;
  active_contributor_count integer;
  allocation_total numeric;
  saved_recipient public.christmas_recipients;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(coalesce(public.area_of_recipient(p_christmas_recipient_id), public.area_of_event(p_christmas_event_id)));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_name is null
     or length(trim(p_name)) not between 1 and 100
     or trim(p_name) ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid person name' using errcode = '23514';
  end if;
  if p_budget_pennies is null or p_budget_pennies < 0 then
    raise exception 'Enter a valid Christmas budget' using errcode = '23514';
  end if;

  if p_christmas_recipient_id is null then
    if not public.is_app_admin() then
      raise exception 'Global Admin access required' using errcode = '42501';
    end if;
    if p_christmas_event_id is null or not exists (
      select 1
      from public.christmas_events
      where id = p_christmas_event_id
    ) then
      raise exception 'Christmas event not found' using errcode = 'P0002';
    end if;
    target_event_id := p_christmas_event_id;
  else
    select
      recipient.christmas_event_id,
      recipient.person_id,
      recipient.budget_pennies,
      recipient.active,
      person.name
    into
      target_event_id,
      linked_person_id,
      existing_budget_pennies,
      existing_is_active,
      existing_name
    from public.christmas_recipients as recipient
    join public.people as person on person.id = recipient.person_id
    where recipient.id = p_christmas_recipient_id
    for update of recipient, person;

    if not found then
      raise exception 'Christmas recipient not found' using errcode = 'P0002';
    end if;
    if not existing_is_active then
      raise exception 'Only active Christmas recipients can be edited'
        using errcode = '23514';
    end if;
    if p_christmas_event_id is not null and p_christmas_event_id <> target_event_id then
      raise exception 'A recipient cannot be moved to another Christmas event'
        using errcode = '23514';
    end if;

    details_changed := trim(p_name) is distinct from existing_name
      or p_budget_pennies is distinct from existing_budget_pennies;
    if details_changed and not public.is_app_admin() then
      raise exception 'Global Admin access required to change recipient details'
        using errcode = '42501';
    end if;
  end if;

  -- Serialize this snapshot against Family Access contributor activation or
  -- deactivation so the definition of "every active contributor" cannot
  -- change between validation and commit.
  lock table public.contributors in share mode;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'A complete contributor allocation plan is required'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'contributor_id')
       or not (item ? 'planned_amount_pennies')
       or jsonb_typeof(item -> 'contributor_id') <> 'string'
       or jsonb_typeof(item -> 'planned_amount_pennies') <> 'number'
       or coalesce(item ->> 'contributor_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(item ->> 'planned_amount_pennies', '') !~ '^[0-9]+$'
  ) then
    raise exception 'Contributor allocations are invalid' using errcode = '23514';
  end if;

  select
    count(*),
    count(distinct item ->> 'contributor_id'),
    coalesce(sum((item ->> 'planned_amount_pennies')::numeric), 0)
  into allocation_count, distinct_contributor_count, allocation_total
  from jsonb_array_elements(p_allocations) as allocation(item);

  if allocation_count <> distinct_contributor_count then
    raise exception 'Each contributor can appear only once' using errcode = '23514';
  end if;
  if allocation_total > 2147483647 then
    raise exception 'Contributor allocation is too large' using errcode = '22003';
  end if;
  if allocation_total <> p_budget_pennies then
    raise exception 'Contributor allocations must equal the recipient budget exactly'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    left join public.contributors as contributor
      on contributor.id = (item ->> 'contributor_id')::uuid
    where contributor.id is null
       or contributor.christmas_event_id <> target_event_id
       or contributor.active = false
  ) then
    raise exception 'Contributors must be active for this Christmas event'
      using errcode = '23514';
  end if;

  select count(*)
  into active_contributor_count
  from public.contributors
  where christmas_event_id = target_event_id
    and active = true;

  if allocation_count <> active_contributor_count then
    raise exception 'The allocation plan must include every active contributor exactly once'
      using errcode = '23514';
  end if;

  if p_christmas_recipient_id is null then
    insert into public.people (name)
    values (trim(p_name))
    returning id into linked_person_id;

    insert into public.christmas_recipients (
      christmas_event_id,
      person_id,
      budget_pennies,
      active
    ) values (
      target_event_id,
      linked_person_id,
      p_budget_pennies,
      true
    ) returning * into saved_recipient;
  else
    if details_changed then
      update public.people
      set name = trim(p_name), updated_at = now()
      where id = linked_person_id;

      update public.christmas_recipients
      set budget_pennies = p_budget_pennies, updated_at = now()
      where id = p_christmas_recipient_id
      returning * into saved_recipient;
    else
      select *
      into saved_recipient
      from public.christmas_recipients
      where id = p_christmas_recipient_id;
    end if;
  end if;

  delete from public.recipient_contributions
  where christmas_recipient_id = saved_recipient.id;

  insert into public.recipient_contributions (
    christmas_recipient_id,
    contributor_id,
    planned_amount_pennies,
    updated_at
  )
  select
    saved_recipient.id,
    (item ->> 'contributor_id')::uuid,
    (item ->> 'planned_amount_pennies')::integer,
    now()
  from jsonb_array_elements(p_allocations) as allocation(item);

  return saved_recipient;
end;
$function$
;

-- ------------------------------------------------------------------------
-- save_gift_idea  ->  coalesce(public.area_of_gift_idea(p_gift_idea_id), public.area_of_recipient(p_christmas_recipient_id))
-- ------------------------------------------------------------------------

create or replace function public.save_gift_idea(p_gift_idea_id uuid, p_christmas_recipient_id uuid, p_title text, p_estimated_price_pennies integer, p_retailer text, p_url text, p_notes text)
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
$function$
;

-- ------------------------------------------------------------------------
-- save_purchase_with_location  ->  coalesce(public.area_of_purchase(p_purchase_id), public.area_of_recipient(p_christmas_recipient_id))
-- ------------------------------------------------------------------------

create or replace function public.save_purchase_with_location(p_purchase_id uuid, p_christmas_recipient_id uuid, p_description text, p_actual_price_pennies integer, p_checkout_payer_contributor_id uuid, p_gift_location_person_id uuid, p_purchase_date date, p_retailer text, p_notes text, p_status text, p_split_type text, p_originating_gift_idea_id uuid, p_allocations jsonb)
 RETURNS purchases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  recipient_event_id uuid;
  saved_purchase public.purchases;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(coalesce(public.area_of_purchase(p_purchase_id), public.area_of_recipient(p_christmas_recipient_id)));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_status not in ('purchased', 'wrapped') then
    raise exception 'Choose Purchased or Wrapped' using errcode = '23514';
  end if;

  select christmas_event_id
  into recipient_event_id
  from public.christmas_recipients
  where id = p_christmas_recipient_id;

  if not found then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;

  if p_gift_location_person_id is not null and not exists (
    select 1
    from public.contributors as location_contributor
    where location_contributor.christmas_event_id = recipient_event_id
      and location_contributor.person_id = p_gift_location_person_id
      and location_contributor.active = true
  ) then
    raise exception 'Choose an active contributor as the gift location'
      using errcode = '23514';
  end if;

  saved_purchase := public.save_purchase(
    p_purchase_id,
    p_christmas_recipient_id,
    p_description,
    p_actual_price_pennies,
    p_checkout_payer_contributor_id,
    p_purchase_date,
    p_retailer,
    p_notes,
    p_status,
    p_split_type,
    p_originating_gift_idea_id,
    p_allocations
  );

  update public.purchases
  set gift_location_person_id = p_gift_location_person_id
  where id = saved_purchase.id
  returning * into saved_purchase;

  return saved_purchase;
end;
$function$
;

-- ------------------------------------------------------------------------
-- set_purchase_status  ->  public.area_of_purchase(p_purchase_id)
-- ------------------------------------------------------------------------

create or replace function public.set_purchase_status(p_purchase_id uuid, p_status text)
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
$function$
;

-- ------------------------------------------------------------------------
-- void_purchase  ->  public.area_of_purchase(p_purchase_id)
-- ------------------------------------------------------------------------

create or replace function public.void_purchase(p_purchase_id uuid)
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
$function$
;

-- ------------------------------------------------------------------------
-- record_settlement  ->  public.area_of_event(p_christmas_event_id)
-- ------------------------------------------------------------------------

create or replace function public.record_settlement(p_christmas_event_id uuid, p_payer_contributor_id uuid, p_payee_contributor_id uuid, p_amount_pennies integer, p_payment_date date, p_notes text)
 RETURNS settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  caller_is_receiver boolean;
  forward_obligations bigint;
  reverse_obligations bigint;
  forward_confirmed bigint;
  reverse_confirmed bigint;
  forward_awaiting bigint;
  outstanding_pennies bigint;
  claimable_pennies bigint;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_christmas_event_id));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  current_member_id := public.current_app_member_id();
  current_contributor_id := public.current_app_contributor_id(p_christmas_event_id);
  if current_member_id is null or current_contributor_id is null then
    raise exception 'An active contributor account is required' using errcode = '42501';
  end if;

  -- The whole authorization rule, and it does not mention roles.
  if current_contributor_id <> p_payee_contributor_id
    and current_contributor_id <> p_payer_contributor_id
  then
    raise exception 'Only the payer or the person being paid can record this payment'
      using errcode = '42501';
  end if;
  caller_is_receiver := current_contributor_id = p_payee_contributor_id;

  if p_payer_contributor_id = p_payee_contributor_id then
    raise exception 'Payment payer and receiver must be different'
      using errcode = '23514';
  end if;
  if p_amount_pennies is null or p_amount_pennies <= 0 then
    raise exception 'Payment amount must be greater than zero'
      using errcode = '23514';
  end if;
  if p_payment_date is null then
    raise exception 'Enter a payment date' using errcode = '23514';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'Payment notes are too long' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.contributors
    where id = p_payer_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) or not exists (
    select 1
    from public.contributors
    where id = p_payee_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) then
    raise exception 'Both payment contributors must belong to this Christmas event'
      using errcode = '23514';
  end if;

  -- Serialize recordings for the same event/pair so two devices cannot both
  -- pass the limit check below with the same headroom.
  pair_lock_key := least(p_payer_contributor_id::text, p_payee_contributor_id::text)
    || '|'
    || greatest(p_payer_contributor_id::text, p_payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into forward_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payer_contributor_id
    and purchase.checkout_payer_contributor_id = p_payee_contributor_id;

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into reverse_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payee_contributor_id
    and purchase.checkout_payer_contributor_id = p_payer_contributor_id;

  -- Only CONFIRMED money has moved a balance, so only confirmed money counts
  -- here. This mirrors `calculateNetOwedBalances` in src/lib/owed.ts exactly.
  select coalesce(sum(confirmed_amount_pennies), 0)
  into forward_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null;

  select coalesce(sum(confirmed_amount_pennies), 0)
  into reverse_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payee_contributor_id
    and payee_contributor_id = p_payer_contributor_id
    and voided_at is null;

  -- Claims already waiting on this receiver reserve their share of the debt.
  -- Without this, the same 20 could be claimed five times over.
  select coalesce(sum(amount_pennies - confirmed_amount_pennies), 0)
  into forward_awaiting
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null
    and rejected_at is null;

  outstanding_pennies := forward_obligations
    - reverse_obligations
    - forward_confirmed
    + reverse_confirmed;
  claimable_pennies := outstanding_pennies - forward_awaiting;

  if outstanding_pennies <= 0 then
    raise exception 'There is no outstanding net balance in this payment direction'
      using errcode = '23514';
  end if;
  if claimable_pennies <= 0 then
    raise exception 'Every outstanding penny in this direction is already awaiting confirmation'
      using errcode = '23514';
  end if;
  if p_amount_pennies > claimable_pennies then
    raise exception 'Payment exceeds the amount still outstanding and unclaimed'
      using errcode = '23514';
  end if;

  insert into public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    amount_pennies,
    payment_date,
    recorded_by_app_member_id,
    notes,
    confirmed_amount_pennies,
    confirmed_at,
    last_reviewed_at,
    reviewed_by_app_member_id
  ) values (
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    p_amount_pennies,
    p_payment_date,
    current_member_id,
    nullif(trim(p_notes), ''),
    case when caller_is_receiver then p_amount_pennies else 0 end,
    case when caller_is_receiver then now() else null end,
    case when caller_is_receiver then now() else null end,
    case when caller_is_receiver then current_member_id else null end
  )
  returning * into saved_settlement;

  if caller_is_receiver then
    insert into public.payment_receipts (
      settlement_id,
      christmas_event_id,
      payer_contributor_id,
      payee_contributor_id,
      action,
      amount_pennies,
      source,
      reviewed_by_app_member_id,
      reviewer_contributor_id
    ) values (
      saved_settlement.id,
      p_christmas_event_id,
      p_payer_contributor_id,
      p_payee_contributor_id,
      'confirm',
      p_amount_pennies,
      'auto_receipt',
      current_member_id,
      current_contributor_id
    );
  end if;

  return saved_settlement;
end;
$function$
;

-- ------------------------------------------------------------------------
-- admin_record_confirmed_payment  ->  public.area_of_event(p_christmas_event_id)
-- ------------------------------------------------------------------------

create or replace function public.admin_record_confirmed_payment(p_christmas_event_id uuid, p_payer_contributor_id uuid, p_payee_contributor_id uuid, p_amount_pennies integer, p_payment_date date, p_reason text)
 RETURNS settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  clean_reason text;
  forward_obligations bigint;
  reverse_obligations bigint;
  forward_confirmed bigint;
  reverse_confirmed bigint;
  forward_awaiting bigint;
  outstanding_pennies bigint;
  claimable_pennies bigint;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_event(p_christmas_event_id));
  if not public.is_app_admin() then
    raise exception 'Only Global Admin can record a confirmed payment on behalf of others'
      using errcode = '42501';
  end if;

  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'An active membership is required' using errcode = '42501';
  end if;
  current_contributor_id := public.current_app_contributor_id(p_christmas_event_id);

  -- No self-dealing. An admin may reconcile other people's money, never their
  -- own debt.
  if current_contributor_id is not null
    and current_contributor_id = p_payer_contributor_id
  then
    raise exception 'You cannot confirm your own payment. Record it normally and let the other person confirm it.'
      using errcode = '42501';
  end if;

  clean_reason := nullif(trim(coalesce(p_reason, '')), '');
  if clean_reason is null then
    raise exception 'Give a reason for recording this payment as already confirmed'
      using errcode = '23514';
  end if;
  if length(clean_reason) > 500 then
    raise exception 'Keep the reason under 500 characters' using errcode = '23514';
  end if;

  if p_payer_contributor_id = p_payee_contributor_id then
    raise exception 'Payment payer and receiver must be different'
      using errcode = '23514';
  end if;
  if p_amount_pennies is null or p_amount_pennies <= 0 then
    raise exception 'Payment amount must be greater than zero'
      using errcode = '23514';
  end if;
  if p_payment_date is null then
    raise exception 'Enter a payment date' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.contributors
    where id = p_payer_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) or not exists (
    select 1
    from public.contributors
    where id = p_payee_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) then
    raise exception 'Both payment contributors must belong to this Christmas event'
      using errcode = '23514';
  end if;

  pair_lock_key := least(p_payer_contributor_id::text, p_payee_contributor_id::text)
    || '|'
    || greatest(p_payer_contributor_id::text, p_payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into forward_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payer_contributor_id
    and purchase.checkout_payer_contributor_id = p_payee_contributor_id;

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into reverse_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payee_contributor_id
    and purchase.checkout_payer_contributor_id = p_payer_contributor_id;

  select coalesce(sum(confirmed_amount_pennies), 0)
  into forward_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null;

  select coalesce(sum(confirmed_amount_pennies), 0)
  into reverse_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payee_contributor_id
    and payee_contributor_id = p_payer_contributor_id
    and voided_at is null;

  select coalesce(sum(amount_pennies - confirmed_amount_pennies), 0)
  into forward_awaiting
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null
    and rejected_at is null;

  outstanding_pennies := forward_obligations
    - reverse_obligations
    - forward_confirmed
    + reverse_confirmed;
  claimable_pennies := outstanding_pennies - forward_awaiting;

  -- Same ceiling as the ordinary path. An override corrects the ledger; it
  -- cannot invent a debt in the opposite direction, and the admin should
  -- reject or void the pending claim rather than confirm the same money twice.
  if outstanding_pennies <= 0 then
    raise exception 'There is no outstanding net balance in this payment direction'
      using errcode = '23514';
  end if;
  if claimable_pennies <= 0 then
    raise exception 'Every outstanding penny in this direction is already awaiting confirmation'
      using errcode = '23514';
  end if;
  if p_amount_pennies > claimable_pennies then
    raise exception 'Payment exceeds the amount still outstanding and unclaimed'
      using errcode = '23514';
  end if;

  insert into public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    amount_pennies,
    payment_date,
    recorded_by_app_member_id,
    notes,
    confirmed_amount_pennies,
    confirmed_at,
    last_reviewed_at,
    reviewed_by_app_member_id
  ) values (
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    p_amount_pennies,
    p_payment_date,
    current_member_id,
    null,
    p_amount_pennies,
    now(),
    now(),
    current_member_id
  )
  returning * into saved_settlement;

  insert into public.payment_receipts (
    settlement_id,
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    action,
    amount_pennies,
    reason,
    source,
    reviewed_by_app_member_id,
    reviewer_contributor_id
  ) values (
    saved_settlement.id,
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    'confirm',
    p_amount_pennies,
    clean_reason,
    'admin_override',
    current_member_id,
    p_payee_contributor_id
  );

  return saved_settlement;
end;
$function$
;

-- ------------------------------------------------------------------------
-- review_payment  ->  public.area_of_settlement(p_settlement_id)
-- ------------------------------------------------------------------------

create or replace function public.review_payment(p_settlement_id uuid, p_action text, p_amount_pennies integer, p_reason text)
 RETURNS payment_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  existing_settlement public.settlements;
  remaining_pennies integer;
  applied_pennies integer;
  clean_reason text;
  saved_receipt public.payment_receipts;
  pair_lock_key text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_settlement(p_settlement_id));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'An active contributor account is required' using errcode = '42501';
  end if;

  if p_action is null or p_action not in ('confirm', 'reject') then
    raise exception 'Choose whether the payment was received' using errcode = '23514';
  end if;

  -- Read once, unlocked, purely to learn which pair this payment belongs to.
  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id;

  if not found then
    raise exception 'Payment record not found' using errcode = 'P0002';
  end if;

  -- Then take the pair lock BEFORE the row lock, in the same order
  -- `record_settlement` takes them. Two operations on one pair are therefore
  -- serialized in a fixed order, so a review and a new claim cannot both size
  -- themselves against a balance the other is halfway through changing, and
  -- neither can deadlock against the other.
  pair_lock_key := least(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text)
    || '|'
    || greatest(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(existing_settlement.christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  -- Re-read under a row lock. This is the copy every figure below is derived
  -- from: whatever another device committed while this call was waiting for the
  -- lock is now visible, so a second confirmation can only take what is left.
  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id
  for update;

  if not found then
    raise exception 'Payment record not found' using errcode = 'P0002';
  end if;

  current_contributor_id := public.current_app_contributor_id(existing_settlement.christmas_event_id);
  if current_contributor_id is null
    or current_contributor_id <> existing_settlement.payee_contributor_id
  then
    raise exception 'Only the person this payment was sent to can review it'
      using errcode = '42501';
  end if;

  if existing_settlement.voided_at is not null then
    raise exception 'This payment record has been voided and cannot be reviewed'
      using errcode = '23514';
  end if;
  if existing_settlement.rejected_at is not null then
    raise exception 'This payment has already been reviewed as not received'
      using errcode = '23514';
  end if;

  remaining_pennies := existing_settlement.amount_pennies - existing_settlement.confirmed_amount_pennies;
  if remaining_pennies <= 0 then
    raise exception 'This payment is already confirmed in full' using errcode = '23514';
  end if;

  if p_action = 'confirm' then
    if p_amount_pennies is null or p_amount_pennies <= 0 then
      raise exception 'Enter how much you received' using errcode = '23514';
    end if;
    if p_amount_pennies > remaining_pennies then
      raise exception 'You cannot confirm more than the amount still unconfirmed'
        using errcode = '23514';
    end if;
    applied_pennies := p_amount_pennies;
    clean_reason := null;

    update public.settlements
    set
      confirmed_amount_pennies = confirmed_amount_pennies + applied_pennies,
      last_reviewed_at = now(),
      reviewed_by_app_member_id = current_member_id,
      confirmed_at = case
        when confirmed_amount_pennies + applied_pennies >= amount_pennies then now()
        else confirmed_at
      end
    where id = existing_settlement.id;
  else
    clean_reason := nullif(trim(coalesce(p_reason, '')), '');
    if clean_reason is null then
      raise exception 'Say why the payment has not arrived' using errcode = '23514';
    end if;
    if length(clean_reason) > 500 then
      raise exception 'Keep the reason under 500 characters' using errcode = '23514';
    end if;
    -- A rejection closes whatever is still unconfirmed. Anything already
    -- confirmed stays confirmed: the receiver said that part did arrive, and
    -- taking it back would rewrite history.
    applied_pennies := remaining_pennies;

    update public.settlements
    set
      rejected_at = now(),
      rejection_reason = clean_reason,
      last_reviewed_at = now(),
      reviewed_by_app_member_id = current_member_id
    where id = existing_settlement.id;
  end if;

  insert into public.payment_receipts (
    settlement_id,
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    action,
    amount_pennies,
    reason,
    source,
    reviewed_by_app_member_id,
    reviewer_contributor_id
  ) values (
    existing_settlement.id,
    existing_settlement.christmas_event_id,
    existing_settlement.payer_contributor_id,
    existing_settlement.payee_contributor_id,
    p_action,
    applied_pennies,
    clean_reason,
    'review',
    current_member_id,
    current_contributor_id
  )
  returning * into saved_receipt;

  return saved_receipt;
end;
$function$
;

-- ------------------------------------------------------------------------
-- void_settlement  ->  public.area_of_settlement(p_settlement_id)
-- ------------------------------------------------------------------------

create or replace function public.void_settlement(p_settlement_id uuid)
 RETURNS settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  existing_settlement public.settlements;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(public.area_of_settlement(p_settlement_id));
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();

  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id
    and voided_at is null
  for update;

  if not found then
    raise exception 'Active payment record not found' using errcode = 'P0002';
  end if;

  if not public.is_app_admin() then
    current_contributor_id := public.current_app_contributor_id(existing_settlement.christmas_event_id);
    if current_contributor_id is null
      or current_contributor_id <> existing_settlement.payer_contributor_id
      or existing_settlement.confirmed_amount_pennies > 0
      or existing_settlement.rejected_at is not null
    then
      raise exception 'Only Global Admin can void a payment'
        using errcode = '42501';
    end if;
  end if;

  pair_lock_key := least(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text)
    || '|'
    || greatest(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(existing_settlement.christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  update public.settlements
  set
    voided_at = now(),
    voided_by_app_member_id = current_member_id
  where id = p_settlement_id
    and voided_at is null
  returning * into saved_settlement;

  if not found then
    raise exception 'Payment was already voided' using errcode = '23514';
  end if;
  return saved_settlement;
end;
$function$
;

-- ------------------------------------------------------------------------
-- set_area_name  ->  p_area_id
-- ------------------------------------------------------------------------

create or replace function public.set_area_name(p_area_id uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(p_area_id);
  if not public.is_area_admin(p_area_id) then
    raise exception 'Only this Area''s administrator can rename it' using errcode = '42501';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'An Area needs a name' using errcode = '22023';
  end if;
  update public.areas set name = trim(p_name), updated_at = now() where id = p_area_id;
end;
$function$
;

-- ------------------------------------------------------------------------
-- set_area_archived  ->  p_area_id
-- ------------------------------------------------------------------------

create or replace function public.set_area_archived(p_area_id uuid, p_archived boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(p_area_id);
  if not public.is_area_admin(p_area_id) then
    raise exception 'Only this Area''s administrator can archive it' using errcode = '42501';
  end if;
  update public.areas
  set archived_at = case when p_archived then now() else null end,
      updated_at = now()
  where id = p_area_id;
end;
$function$
;

-- ------------------------------------------------------------------------
-- leave_area  ->  p_area_id
-- ------------------------------------------------------------------------

create or replace function public.leave_area(p_area_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  mine public.app_members;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(p_area_id);
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select * into mine
  from public.app_members m
  where m.area_id = p_area_id
    and m.user_id = caller
    and m.active = true;

  if not found then
    -- "No such family" and "you are not in it" are the same answer, so nobody
    -- can use this to find out which families exist.
    raise exception 'You are not a member of that family' using errcode = '42501';
  end if;

  -- THE ADMINISTRATOR CANNOT WALK OUT.
  --
  -- Migration 033's guard would refuse the write anyway; saying so here means
  -- the person gets an instruction they can act on instead of a constraint
  -- violation. Migration 041 is what makes that instruction possible.
  if mine.role = 'admin' then
    raise exception 'Hand this family over to somebody else before you leave it'
      using errcode = '42501';
  end if;

  -- Deactivated, not deleted. `audit_app_members` fires on `active` and records
  -- it; the person, their history and the family's money are untouched.
  update public.app_members
  set active = false, updated_at = now()
  where id = mine.id;
end;
$function$
;

-- ------------------------------------------------------------------------
-- transfer_area_admin  ->  p_area_id
-- ------------------------------------------------------------------------

create or replace function public.transfer_area_admin(p_area_id uuid, p_new_admin_member_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  outgoing public.app_members;
  incoming public.app_members;
  incoming_name text;
  area_name text;
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(p_area_id);
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
$function$
;

-- ---------------------------------------------------------------------------
-- 4. Grants, re-stated
--
-- `create or replace function` keeps the existing privileges, so nothing below
-- changes anything. It is written out because a reader auditing this file
-- should be able to see who may call these routines without going to look, and
-- because a future edit that recreates one of them from scratch would silently
-- lose the revoke.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_event_status(uuid, text)',
    'public.update_event(uuid, text, date, text)',
    'public.delete_event_if_empty(uuid)',
    'public.add_event_recipient(uuid, uuid)',
    'public.set_event_contributor(uuid, uuid, boolean)',
    'public.set_christmas_recipient_active(uuid, boolean)',
    'public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)',
    'public.save_gift_idea(uuid, uuid, text, integer, text, text, text)',
    'public.save_purchase_with_location(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb)',
    'public.set_purchase_status(uuid, text)',
    'public.void_purchase(uuid)',
    'public.record_settlement(uuid, uuid, uuid, integer, date, text)',
    'public.admin_record_confirmed_payment(uuid, uuid, uuid, integer, date, text)',
    'public.review_payment(uuid, text, integer, text)',
    'public.void_settlement(uuid)',
    'public.set_area_name(uuid, text)',
    'public.set_area_archived(uuid, boolean)',
    'public.leave_area(uuid)',
    'public.transfer_area_admin(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  guarded text[] := array[
    'set_event_status', 'update_event', 'delete_event_if_empty', 'add_event_recipient',
    'set_event_contributor', 'set_christmas_recipient_active',
    'save_christmas_recipient_with_contributions', 'save_gift_idea',
    'save_purchase_with_location', 'set_purchase_status', 'void_purchase',
    'record_settlement', 'admin_record_confirmed_payment', 'review_payment',
    'void_settlement', 'set_area_name', 'set_area_archived', 'leave_area',
    'transfer_area_admin'
  ];
  fn text;
  offender record;
begin
  if to_regprocedure('public.require_acting_area(uuid)') is null then
    problems := problems || 'require_acting_area is missing'::text;
  end if;
  if to_regprocedure('public.area_of_settlement(uuid)') is null then
    problems := problems || 'area_of_settlement is missing'::text;
  end if;

  -- Every routine named above must actually call the guard.
  foreach fn in array guarded loop
    if not exists (
      select 1 from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = fn
        and p.prosrc like '%require_acting_area%'
    ) then
      problems := problems || format('%s does not call require_acting_area', fn)::text;
    end if;
  end loop;

  -- And every one of them is still SECURITY DEFINER with a pinned search_path,
  -- still unavailable to anon, and still available to the application.
  for offender in
    select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any(guarded)
      and (not p.prosecdef
           or p.proconfig is null
           or not (array_to_string(p.proconfig, ',') like '%search_path=%'))
  loop
    problems := problems || format('%s is not a definer with a pinned search_path', offender.proname)::text;
  end loop;

  for offender in
    select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any(guarded)
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    problems := problems || format('anon can execute %s', offender.proname)::text;
  end loop;

  for offender in
    select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any(guarded)
      and not has_function_privilege('authenticated', p.oid, 'execute')
  loop
    problems := problems || format('authenticated can no longer execute %s', offender.proname)::text;
  end loop;

  -- The guard itself must be a definer with a pinned path, or it is not a guard.
  if not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('require_acting_area', 'area_of_settlement')
      and p.prosecdef
      and array_to_string(p.proconfig, ',') like '%search_path=%'
    having count(*) = 2
  ) then
    problems := problems || 'the guard or the settlement helper is not a pinned definer'::text;
  end if;

  -- Nothing here may have disturbed what 035, 037 or 044 put in place.
  if to_regproc('public.refuse_foreign_area_write') is null
    or to_regproc('public.refuse_cross_area_person') is null
    or to_regprocedure('public.set_person_name(uuid, text)') is null then
    problems := problems || 'a guard from 035, 037 or 044 has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 045 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Every targeted mutation now asks which family the row is in.';
end;
$$;
