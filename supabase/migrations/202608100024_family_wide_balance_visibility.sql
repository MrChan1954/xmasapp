-- Every active family member may READ the family's balances. Nobody gains a
-- single new way to change one.
--
-- WHY THIS EXISTS
--   The Owed screen has two views, "My balances" and "All balances", and the
--   second was admin-only. That looked like a privacy decision. It was not --
--   it was a workaround for this policy, from migration 009:
--
--     using (
--       is_active_app_member()
--       and (
--         is_app_admin()
--         or payer_contributor_id = current_app_contributor_id(...)
--         or payee_contributor_id = current_app_contributor_id(...)
--       )
--     )
--
--   `purchases` and `purchase_allocations` have always been readable by every
--   active member, so anybody could already see the obligations that CREATE a
--   balance. Only the repayments that REDUCE it were restricted. A member
--   opening "All balances" would therefore have seen, for a pair they are not
--   part of, the gross purchase total with the repayments silently missing --
--   a number that is wrong, not merely incomplete, because RLS filters rows
--   without raising anything the loader could notice.
--
--   Hiding the tab hid the symptom. This fixes the cause.
--
-- WHAT CHANGES
--   Exactly two SELECT policies: `settlements` and `payment_receipts`. Both
--   widen from "the two people involved, or an admin" to "any active member of
--   this family".
--
-- WHAT DOES NOT CHANGE -- and this is the important half
--   * No table gains an INSERT, UPDATE or DELETE policy.
--   * No grant changes. `settlements` and `payment_receipts` remain SELECT-only
--     to `authenticated`, exactly as migrations 009, 010 and 021 left them.
--   * `record_settlement` still admits only the payer or the payee.
--   * `review_payment` still admits only the payee.
--   * `admin_record_confirmed_payment` is still admin-only and still refuses
--     self-dealing.
--   * `void_settlement` is unchanged.
--   * `payment_receipts` is still append-only, enforced by its own trigger.
--   * No financial value, allocation, constraint or generated column is
--     touched. Owed still nets confirmed money only, in src/lib/owed.ts.
--
--   Reading a balance has never been what authorises changing one. Those
--   functions are SECURITY DEFINER and check the caller's contributor identity
--   themselves; they do not consult these policies, and widening a SELECT
--   cannot reach them.
--
-- PRIVACY
--   This is a private family app whose whole purpose is a shared ledger. The
--   rows opened up are: who paid whom, how much was claimed and confirmed,
--   when, and the reason attached to a rejection or an admin override. That is
--   the explanation of a balance every member can already half-see.
--
--   Note what is NOT opened up: `notifications` (each member's own inbox only,
--   deliberately not even readable by an admin), `push_subscriptions`,
--   `notification_preferences`, and `app_members` beyond what migration 010
--   already allowed. Nothing here exposes credentials or device data.

-- ---------------------------------------------------------------------------
-- 1. settlements
-- ---------------------------------------------------------------------------
-- The payments themselves. Required for a correct balance for any pair, since
-- only the confirmed part of a settlement reduces one.
drop policy if exists "members read relevant settlements" on public.settlements;
drop policy if exists "active members read family settlements" on public.settlements;
create policy "active members read family settlements"
on public.settlements
for select
to authenticated
using (public.is_active_app_member());

-- ---------------------------------------------------------------------------
-- 2. payment_receipts
-- ---------------------------------------------------------------------------
-- The review history behind each payment: what was confirmed, what was
-- rejected, when, by whom, and whether an admin recorded it as an override.
--
-- Widened alongside `settlements` rather than left behind, because the Owed
-- screen's "Why this balance?" panel renders these receipts inline underneath
-- each payment. Without them a member would see that a GBP 30 claim reduced a
-- balance by GBP 20 and have no way to see that the other GBP 10 was rejected
-- -- which is precisely the explanation the panel exists to give.
drop policy if exists "members read relevant payment receipts" on public.payment_receipts;
drop policy if exists "active members read family payment receipts" on public.payment_receipts;
create policy "active members read family payment receipts"
on public.payment_receipts
for select
to authenticated
using (public.is_active_app_member());

-- ---------------------------------------------------------------------------
-- 3. Assert the end state
-- ---------------------------------------------------------------------------
-- Same discipline as migration 023: this file must not be able to finish
-- quietly having done half its job, and it must not be able to widen anything
-- it did not intend to.
do $$
declare
  problems text[] := array[]::text[];
  policy_count integer;
begin
  -- The two tables must be readable by any active member...
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'settlements'
      and policyname = 'active members read family settlements' and cmd = 'SELECT'
  ) then
    problems := problems || 'settlements read policy missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'payment_receipts'
      and policyname = 'active members read family payment receipts' and cmd = 'SELECT'
  ) then
    problems := problems || 'payment_receipts read policy missing';
  end if;

  -- ...and by nothing else. A leftover policy is not harmful here (they are
  -- OR-ed, and the new one is the widest), but two policies claiming to govern
  -- the same read is exactly how the next person misreads the rules.
  select count(*) into policy_count from pg_catalog.pg_policies
  where schemaname = 'public' and tablename = 'settlements';
  if policy_count <> 1 then
    problems := problems || ('settlements should have exactly 1 policy, found ' || policy_count);
  end if;
  select count(*) into policy_count from pg_catalog.pg_policies
  where schemaname = 'public' and tablename = 'payment_receipts';
  if policy_count <> 1 then
    problems := problems || ('payment_receipts should have exactly 1 policy, found ' || policy_count);
  end if;

  -- WRITING must still be impossible from a browser session. If widening a
  -- read has somehow coincided with a write grant, this file fails.
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('settlements', 'payment_receipts')
      and grantee in ('authenticated', 'anon', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    problems := problems || 'a browser role can write to settlements or payment_receipts';
  end if;

  -- RLS itself must still be on, or the policies above mean nothing.
  if not exists (
    select 1 from pg_catalog.pg_class where oid = 'public.settlements'::regclass and relrowsecurity
  ) then
    problems := problems || 'row level security is off on settlements';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class where oid = 'public.payment_receipts'::regclass and relrowsecurity
  ) then
    problems := problems || 'row level security is off on payment_receipts';
  end if;

  -- And the three functions that DO authorise change must still exist. This
  -- file does not touch them; the check is here so that a future edit which
  -- quietly drops one cannot pass review by leaving the reads looking fine.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_settlement'
  ) then
    problems := problems || 'record_settlement is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'review_payment'
  ) then
    problems := problems || 'review_payment is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_record_confirmed_payment'
  ) then
    problems := problems || 'admin_record_confirmed_payment is missing';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Balance visibility migration did not complete cleanly: %',
      array_to_string(problems, ', ');
  end if;

  raise notice 'Every active member can now read family balances. Write permissions are unchanged.';
end;
$$;
