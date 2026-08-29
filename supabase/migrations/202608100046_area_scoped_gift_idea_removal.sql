-- Removing a gift idea was the one gift/purchase write with no acting Area.
--
-- WHAT WAS WRONG, MEASURED RATHER THAN SUSPECTED
--
--   Migration 045 put `require_acting_area()` at the top of sixteen routines,
--   including `save_gift_idea`, `save_purchase_with_location`,
--   `set_purchase_status` and `void_purchase`. Removing an idea is not a
--   routine. The application deleted the row directly:
--
--       from("gift_ideas").delete()
--         .eq("id", ...).eq("christmas_recipient_id", ...)
--
--   so it never reached a routine and never reached that guard. Its only
--   boundary was this table's DELETE policy, which asked
--   `is_area_member(area_of_recipient(...))` -- the right permission and the
--   wrong question, exactly as 045's header describes. Membership answers "may
--   this reader touch that family at all", not "is that family the one they are
--   standing in", and a login that belongs to two families passes it in both.
--
--   Against a real PostgreSQL with 001-045 applied, the fixture account that
--   belongs to Alpha and Bravo, ACTING IN BRAVO, ran the application's own
--   delete against ALPHA's gift idea. It returned the row and the idea was
--   gone. Nothing refused.
--
--   The same delete cost history. `purchases.originating_gift_idea_id` is
--   `on delete set null`, so removing an idea a purchase had come from left the
--   purchase in place with its provenance quietly set to null -- while the
--   confirmation on screen promised "Purchases and budgets will not change".
--
-- WHAT THIS MIGRATION DOES
--
--   1. `is_acting_area(area)` -- `require_acting_area()`'s question as a
--      BOOLEAN. A policy cannot use the raising version: `using` needs a
--      predicate, not an exception. The two must agree, so this mirrors that
--      function's logic line for line, including its single-membership
--      fallback for an account that has never chosen.
--
--   2. `remove_gift_idea(id)` -- the routine the application should have been
--      calling, in 045's shape: `require_acting_area` first, then membership,
--      then the business rule. It refuses in a sentence a person can read.
--
--   3. Replacement UPDATE and DELETE policies on `gift_ideas`, so the raw path
--      is closed for a caller who never uses the routine. A policy is the
--      boundary; the routine is the good manners.
--
--   Belt and braces on purpose. Either alone would leave the other path open:
--   the routine cannot stop a direct PostgREST call, and the policy cannot
--   explain itself to a user.
--
-- APPEND-ONLY. Nothing in 001-045 is edited. The policies are replaced by
-- name, which is how 031, 036 and 039 have each replaced them before.

-- ---------------------------------------------------------------------------
-- 1. The acting-Area question, as a predicate
-- ---------------------------------------------------------------------------

create or replace function public.is_acting_area(p_area_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  acting uuid;
  memberships integer;
begin
  -- No such row. Let the caller's own "not found" answer stand, exactly as
  -- `require_acting_area` does -- a policy that returned false here would turn
  -- "this does not exist" into "you may not", which is a different sentence.
  if p_area_id is null then
    return true;
  end if;

  acting := public.acting_area();

  if acting is not null then
    return acting = p_area_id;
  end if;

  -- Nobody said which family. That is only answerable when there is one.
  select count(*) into memberships
  from public.app_members m
  where m.user_id = (select auth.uid()) and m.active = true;

  if memberships <> 1 then
    return false;
  end if;

  return exists (
    select 1 from public.app_members m
    where m.user_id = (select auth.uid()) and m.active = true and m.area_id = p_area_id
  );
end;
$$;

comment on function public.is_acting_area(uuid) is
  'Whether the caller is standing in the given Area. The boolean form of require_acting_area(), for row level security, which needs a predicate rather than an exception. Keep the two in step.';

revoke all on function public.is_acting_area(uuid) from public, anon;
grant execute on function public.is_acting_area(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Removing an idea, as a routine that can explain itself
-- ---------------------------------------------------------------------------

create or replace function public.remove_gift_idea(p_gift_idea_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  idea_recipient uuid;
begin
  -- MIGRATION 045's guard, on the write it never covered.
  perform public.require_acting_area(public.area_of_gift_idea(p_gift_idea_id));

  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  select christmas_recipient_id into idea_recipient
  from public.gift_ideas
  where id = p_gift_idea_id;

  -- An idea that does not exist and an idea this reader may not touch are
  -- deliberately the same answer.
  if idea_recipient is null
     or not public.is_area_member(public.area_of_recipient(idea_recipient)) then
    raise exception 'That gift idea could not be found' using errcode = 'P0002';
  end if;

  -- The celebrant's own birthday. They cannot read these rows; they must not
  -- be able to delete one by naming it either.
  if public.is_own_birthday_recipient(idea_recipient) then
    raise exception 'That gift idea could not be found' using errcode = 'P0002';
  end if;

  -- THE PROVENANCE RULE. `purchases.originating_gift_idea_id` is
  -- `on delete set null`, so deleting an idea somebody has already bought
  -- would leave the purchase standing with no record of what it was for. The
  -- money is the history; the idea is why it was spent.
  if exists (
    select 1
    from public.purchases
    where originating_gift_idea_id = p_gift_idea_id
      and deleted_at is null
  ) then
    raise exception 'This idea has already been bought, so it stays as the record of what was planned. Remove the purchase instead if it was a mistake.'
      using errcode = '23503';
  end if;

  delete from public.gift_ideas where id = p_gift_idea_id;
end;
$$;

comment on function public.remove_gift_idea(uuid) is
  'Remove a gift idea from the family on screen. Refuses across Areas, refuses on the celebrant''s own birthday, and refuses when a live purchase came from the idea.';

revoke all on function public.remove_gift_idea(uuid) from public, anon;
grant execute on function public.remove_gift_idea(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The policies, so the routine is not merely the polite route
-- ---------------------------------------------------------------------------

-- UPDATE.
--
-- `using` decides which rows may be chosen; `with check` decides what they may
-- become. Both are needed and they are not the same question: `using` alone
-- would let a legitimate row be edited into a foreign one, and `with check`
-- alone would let a foreign row be chosen. Migration 036's version tested
-- membership in both halves; this adds the acting Area to both, and refuses
-- the celebrant's own birthday in both.
drop policy if exists "active members edit gift ideas" on public.gift_ideas;
create policy "active members edit gift ideas"
  on public.gift_ideas for update
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and public.is_acting_area(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
  )
  with check (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and public.is_acting_area(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
  );

-- The grant, which is the reason a raw delete was reachable at all.
--
-- Migration 011 took `insert, update` away from `authenticated` on this table
-- so that writing an idea has to go through `save_gift_idea`. It left `delete`
-- behind -- the only reason the application could delete a row directly, and
-- so the only reason the policy below was ever the whole boundary. Removal now
-- goes through `remove_gift_idea` like every other write, and the grant that
-- made the bypass possible goes with it.
--
-- `select` stays: reading is what the list is for.
revoke delete on table public.gift_ideas from authenticated;

-- DELETE.
--
-- Kept, and tightened, even though the grant above now makes it unreachable
-- from a browser. A policy is cheap and a grant is one migration away from
-- being handed back by somebody who does not know why it went; if that ever
-- happens this should still refuse. Belt, braces, and a note explaining both.
--
-- The own-birthday exclusion here is DELIBERATE REDUNDANCY, and worth naming as
-- such: the read policy already hides these rows from the celebrant, and a
-- DELETE cannot match a row it cannot see, so removing this line changes no
-- observable behaviour today. It is here so the rule survives a future change
-- to the read policy rather than depending on one. Nothing in the mutation
-- suite covers it, because nothing can: a mutation that alters no behaviour is
-- not a mutation worth claiming a catch for.
--
-- The same acting-Area and own-birthday rules, plus the provenance guard, so a
-- direct PostgREST delete is refused for the same reasons the routine gives --
-- silently, because a policy has no voice. The routine above is what turns
-- that silence into a sentence.
drop policy if exists "active members remove gift ideas" on public.gift_ideas;
create policy "active members remove gift ideas"
  on public.gift_ideas for delete
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and public.is_acting_area(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
    and not exists (
      select 1
      from public.purchases p
      where p.originating_gift_idea_id = public.gift_ideas.id
        and p.deleted_at is null
    )
  );
