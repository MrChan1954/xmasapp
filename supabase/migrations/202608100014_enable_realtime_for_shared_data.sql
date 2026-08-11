-- Stream shared Christmas data changes to open browser tabs so a change made on
-- one device appears on another without a manual reload.
--
-- This migration grants no new access. Realtime evaluates each subscriber's
-- existing RLS SELECT policy per changed row before delivering it, so a client
-- only ever receives rows it could already have fetched. Every table below is
-- already restricted to active app members by migration 010; none of them are
-- readable by `anon`.
--
-- Deliberately excluded:
--   app_members  -- its SELECT policy is `user_id = auth.uid()`, so a stream
--                   would only ever echo a member's own row back to them. It
--                   also holds login emails, and Family Access already reads it
--                   through the authorized admin route instead.
--   christmas_events -- effectively static; one row per year.

-- Supabase provisions this publication on new projects, but create it when a
-- project predates that so this migration is safe to run anywhere.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- `alter publication ... add table` errors if the table is already a member, so
-- add each one only when it is absent. That keeps this migration re-runnable.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'contributors',
    'recipient_contributions',
    'christmas_recipients',
    'people',
    'purchases',
    'purchase_allocations',
    'gift_ideas',
    'settlements'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end
$$;

-- The client only needs to know that something changed, then refetches through
-- the same authorized path it already uses. Default replica identity therefore
-- suffices: it carries the primary key on delete, and no old-row column values
-- are broadcast. Setting `replica identity full` here would put complete
-- pre-change rows -- including purchase amounts and settlement figures -- on the
-- wire for every update, so it is intentionally left alone.
