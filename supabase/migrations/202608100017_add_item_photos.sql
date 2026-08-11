-- Photos attached to a purchase or a gift idea.
--
-- The files live in a PRIVATE Storage bucket (`item-photos`); this table is the
-- index. Nothing is readable without a signed URL the app mints for a signed-in
-- member, so a leaked link stops working when it expires.
--
-- Visibility deliberately mirrors the parent record: both `purchases` and
-- `gift_ideas` are readable by any active member, so their photos are too. A
-- photo must never be visible to someone who cannot see the thing it is of.

create table public.item_photos (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one parent. A photo of nothing, or of two things, is a bug.
  purchase_id uuid references public.purchases(id) on delete cascade,
  gift_idea_id uuid references public.gift_ideas(id) on delete cascade,
  storage_path text not null unique,
  width integer,
  height integer,
  byte_size integer,
  uploaded_by_app_member_id uuid references public.app_members(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint item_photos_one_parent check (
    (purchase_id is not null and gift_idea_id is null)
    or (purchase_id is null and gift_idea_id is not null)
  )
);

create index item_photos_purchase_idx on public.item_photos (purchase_id, created_at);
create index item_photos_gift_idea_idx on public.item_photos (gift_idea_id, created_at);

alter table public.item_photos enable row level security;

-- Same lockdown shape as every other table since migration 010.
revoke all privileges on table public.item_photos from public, anon, authenticated;
grant select, insert, delete on table public.item_photos to authenticated;

create policy "active members read item photos" on public.item_photos
  for select to authenticated
  using (public.is_active_app_member());

create policy "active members add item photos" on public.item_photos
  for insert to authenticated
  with check (public.is_active_app_member());

create policy "active members remove item photos" on public.item_photos
  for delete to authenticated
  using (public.is_active_app_member());

-- No UPDATE policy: a photo row is written once and then either exists or does
-- not. Re-pointing an existing row at a different file would let someone swap
-- the image behind an audit entry.

/*
 * Storage access for the `item-photos` bucket.
 *
 * The bucket is private, so every one of these is required before a member can
 * upload or be issued a signed URL. `storage.objects` is a normal RLS table;
 * these policies are scoped to this bucket alone and leave any other bucket
 * untouched.
 */
create policy "active members read item photo files" on storage.objects
  for select to authenticated
  using (bucket_id = 'item-photos' and public.is_active_app_member());

create policy "active members upload item photo files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_active_app_member());

create policy "active members delete item photo files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_active_app_member());

-- Photos are things that get added and removed, so they belong in the activity
-- log like everything else. `record_audit_event` resolves the subject per table;
-- an unknown table falls through with a null subject, so extend it rather than
-- leaving entries blank.
create trigger audit_item_photos
  after insert or delete on public.item_photos
  for each row execute function public.record_audit_event('');

/*
 * Teaches the audit trigger about photos: the subject is which item it belongs
 * to, so the log reads "Photo on PS5" rather than a bare "Photo".
 *
 * This is the migration 016 function with one branch added; everything else is
 * unchanged.
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
$$;
