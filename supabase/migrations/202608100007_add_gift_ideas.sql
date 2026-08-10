-- Collaborative, year-specific gift planning.
--
-- Gift ideas deliberately reference christmas_recipients rather than people,
-- so ideas remain attached to the correct Christmas event. Estimated prices
-- are planning values in integer pennies and do not affect budgets, spending,
-- contributor allocations, purchases, or money owed.

create or replace function public.current_app_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id
  from public.app_members
  where user_id = (select auth.uid())
    and active = true
  limit 1;
$$;

revoke all on function public.current_app_member_id() from public;
revoke all on function public.current_app_member_id() from anon;
grant execute on function public.current_app_member_id() to authenticated;

create table public.gift_ideas (
  id uuid primary key default gen_random_uuid(),
  christmas_recipient_id uuid not null
    references public.christmas_recipients(id) on delete cascade,
  title text not null
    check (length(trim(title)) between 1 and 200),
  estimated_price_pennies integer
    check (estimated_price_pennies is null or estimated_price_pennies >= 0),
  retailer text
    check (retailer is null or length(retailer) <= 200),
  url text
    check (
      url is null
      or (
        length(url) <= 2048
        and url ~* '^https?://'
      )
    ),
  notes text
    check (notes is null or length(notes) <= 4000),
  suggested_by_app_member_id uuid not null
    default public.current_app_member_id()
    references public.app_members(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index gift_ideas_recipient_created_idx
  on public.gift_ideas (christmas_recipient_id, created_at desc);

alter table public.gift_ideas enable row level security;

-- Gift ideas are collaborative Christmas planning. Every operation requires
-- an authenticated user with one active app_members row; anonymous users have
-- no grants or policies. The insert check prevents spoofing another suggester.
create policy "active members read gift ideas"
on public.gift_ideas
for select
to authenticated
using (public.is_active_app_member());

create policy "active members add gift ideas"
on public.gift_ideas
for insert
to authenticated
with check (
  public.is_active_app_member()
  and suggested_by_app_member_id = public.current_app_member_id()
);

create policy "active members edit gift ideas"
on public.gift_ideas
for update
to authenticated
using (public.is_active_app_member())
with check (public.is_active_app_member());

create policy "active members remove gift ideas"
on public.gift_ideas
for delete
to authenticated
using (public.is_active_app_member());

revoke all on table public.gift_ideas from anon;
grant select, insert, update, delete on table public.gift_ideas to authenticated;

-- Preserve the idea's original Christmas recipient and suggester even when a
-- different active member edits it. Only editable planning fields can change.
create or replace function public.protect_gift_idea_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.christmas_recipient_id = old.christmas_recipient_id;
  new.suggested_by_app_member_id = old.suggested_by_app_member_id;
  new.created_at = old.created_at;
  new.updated_at = now();
  return new;
end;
$$;

create trigger protect_gift_idea_identity_before_update
before update on public.gift_ideas
for each row execute function public.protect_gift_idea_identity();

-- app_members intentionally remains private. This active-member-only function
-- resolves the safe display name through auth user -> app_members -> people
-- without exposing membership UUIDs, Auth UUIDs, or other members' emails.
create or replace function public.list_gift_ideas(
  p_christmas_recipient_id uuid
)
returns table (
  id uuid,
  christmas_recipient_id uuid,
  title text,
  estimated_price_pennies integer,
  retailer text,
  url text,
  notes text,
  suggested_by_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required'
      using errcode = '42501';
  end if;

  return query
  select
    idea.id,
    idea.christmas_recipient_id,
    idea.title,
    idea.estimated_price_pennies,
    idea.retailer,
    idea.url,
    idea.notes,
    coalesce(person.name, 'Unknown member') as suggested_by_name,
    idea.created_at,
    idea.updated_at
  from public.gift_ideas as idea
  join public.app_members as member
    on member.id = idea.suggested_by_app_member_id
  left join public.people as person
    on person.id = member.person_id
  where idea.christmas_recipient_id = p_christmas_recipient_id
  order by idea.created_at desc;
end;
$$;

revoke all on function public.list_gift_ideas(uuid) from public;
revoke all on function public.list_gift_ideas(uuid) from anon;
grant execute on function public.list_gift_ideas(uuid) to authenticated;

