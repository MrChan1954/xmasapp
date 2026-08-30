-- =============================================================================
-- MIGRATION 051 -- READ-ONLY PRODUCTION CHECKS, AFTER APPLYING
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and tells you line by
--   line whether migration 051 is really in place: the three routines gone,
--   their replacements still here, `authenticated` narrowed to exactly the
--   privileges the application uses on the two tables, TRUNCATE refused on
--   both, `anon` still holding nothing, `service_role` untouched, and the rest
--   of the schema exactly where migration 050 left it.
--
--   IT ONLY READS. There is no insert, update, delete or DDL anywhere in this
--   file, and nothing in it can change a privilege. Running it twice changes
--   nothing.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You will get one table back. Read the first column.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine. Nothing to do.
--   FAIL     something is wrong. Send the whole table back before doing
--            anything else; docs/Q15-051-ROLLBACK.sql exists for this.
--   INFO     a fact for the record, not a pass or a fail.
--
--   FAIL rows sort to the TOP.
--
-- THE CHECK THAT MATTERS MOST
--   `no browser role holds more than the four DML verbs` does not name a table.
--   It sweeps every table and view in `public` and fails if ANY of them has
--   handed `anon` or `authenticated` TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
--   That is the rule 051 exists to restore, and the one that catches the next
--   table to arrive carrying Supabase's blanket default.
-- =============================================================================

with
-- What `authenticated` actually holds on the two tables, from the catalogue.
acl as (
  select c.relname, a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'public'
    and a.grantee = 'authenticated'::regrole
),

checks as (
  -- 1-3. The three routines are gone.
  select 1 as ord,
    case when to_regprocedure('public.is_family_contributor_member()') is null
         then 'PASS' else 'FAIL' end as status,
    'is_family_contributor_member is dropped' as check_name,
    coalesce(to_regprocedure('public.is_family_contributor_member()')::text, 'absent') as detail

  union all
  select 2,
    case when to_regprocedure('public.save_christmas_recipient(uuid, uuid, text, integer)') is null
         then 'PASS' else 'FAIL' end,
    'save_christmas_recipient is dropped',
    coalesce(to_regprocedure('public.save_christmas_recipient(uuid, uuid, text, integer)')::text, 'absent')

  union all
  select 3,
    case when to_regprocedure('public.save_recipient_contributions(uuid, jsonb)') is null
         then 'PASS' else 'FAIL' end,
    'save_recipient_contributions is dropped',
    coalesce(to_regprocedure('public.save_recipient_contributions(uuid, jsonb)')::text, 'absent')

  -- 4. What replaced them, and the sibling that is NOT redundant, are all here.
  union all
  select 4,
    case when to_regprocedure('public.is_area_contributor_member(uuid)') is not null
          and to_regprocedure('public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)') is not null
          and to_regprocedure('public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb)') is not null
          and to_regprocedure('public.save_purchase_with_location(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb)') is not null
          and to_regprocedure('public.set_person_birthday(uuid, smallint, smallint, smallint)') is not null
         then 'PASS' else 'FAIL' end,
    'the canonical replacements and save_purchase all survive',
    'is_area_contributor_member, save_christmas_recipient_with_contributions, save_purchase, save_purchase_with_location, set_person_birthday'

  -- 5. `areas`: authenticated holds exactly SELECT.
  union all
  select 5,
    case when coalesce((select array_agg(privilege_type order by privilege_type)
                        from acl where relname = 'areas'), array[]::text[])
              = array['SELECT']
         then 'PASS' else 'FAIL' end,
    'areas: authenticated holds exactly SELECT',
    coalesce((select string_agg(privilege_type, ',' order by privilege_type)
              from acl where relname = 'areas'), '(nothing)')

  -- 6. `birthday_wishlist_ideas`: exactly the four DML verbs.
  union all
  select 6,
    case when coalesce((select array_agg(privilege_type order by privilege_type)
                        from acl where relname = 'birthday_wishlist_ideas'), array[]::text[])
              = array['DELETE', 'INSERT', 'SELECT', 'UPDATE']
         then 'PASS' else 'FAIL' end,
    'birthday_wishlist_ideas: authenticated holds exactly SELECT, INSERT, UPDATE, DELETE',
    coalesce((select string_agg(privilege_type, ',' order by privilege_type)
              from acl where relname = 'birthday_wishlist_ideas'), '(nothing)')

  -- 7. TRUNCATE, asked directly. Row level security never constrains it, which
  --    is the entire reason 051 was written.
  union all
  select 7,
    case when not has_table_privilege('authenticated', 'public.areas', 'TRUNCATE')
          and not has_table_privilege('authenticated', 'public.birthday_wishlist_ideas', 'TRUNCATE')
         then 'PASS' else 'FAIL' end,
    'authenticated cannot TRUNCATE either table',
    format('areas=%s, birthday_wishlist_ideas=%s',
      has_table_privilege('authenticated', 'public.areas', 'TRUNCATE'),
      has_table_privilege('authenticated', 'public.birthday_wishlist_ideas', 'TRUNCATE'))

  -- 8. THE GENERAL RULE. No table named; this is the one that catches the next
  --    table to arrive with the blanket default still on it.
  union all
  select 8,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'no browser role holds more than the four DML verbs, on any table in public',
    coalesce(string_agg(format('%s.%s=%s', relname, role, privilege_type), '; ' order by relname), 'none')
  from (
    select c.relname, a.grantee::regrole::text as role, a.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind in ('r', 'v')
      and a.grantee::regrole::text in ('anon', 'authenticated')
      and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) wide

  -- 9. anon still holds nothing on the two tables.
  union all
  select 9,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'anon holds nothing on areas or birthday_wishlist_ideas',
    coalesce(string_agg(format('%s=%s', relname, privilege_type), ', '), 'nothing')
  from (
    select c.relname, a.privilege_type
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    where c.oid in ('public.areas'::regclass, 'public.birthday_wishlist_ideas'::regclass)
      and a.grantee = 'anon'::regrole
  ) anon_grants

  -- 10. service_role kept everything it had.
  union all
  select 10,
    case when has_table_privilege('service_role', 'public.areas', 'SELECT')
          and has_table_privilege('service_role', 'public.areas', 'INSERT')
          and has_table_privilege('service_role', 'public.areas', 'TRUNCATE')
          and has_table_privilege('service_role', 'public.birthday_wishlist_ideas', 'SELECT')
          and has_table_privilege('service_role', 'public.birthday_wishlist_ideas', 'INSERT')
          and has_table_privilege('service_role', 'public.birthday_wishlist_ideas', 'TRUNCATE')
         then 'PASS' else 'FAIL' end,
    'service_role is untouched on both tables',
    'select/insert/truncate all still granted'

  -- 11. Row level security is still switched on everywhere.
  union all
  select 11,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'every table in public still has row level security enabled',
    coalesce(string_agg(relname, ', ' order by relname), 'none unguarded')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

  -- 12-14. The rest of the schema is where 050 left it. 051 touches no policy,
  --        no trigger and no index, so any movement here is somebody else's.
  union all
  select 12,
    case when count(*) = 37 then 'PASS' else 'FAIL' end,
    'policies in public are unchanged (expected 37)',
    count(*)::text
  from pg_policies where schemaname = 'public'

  union all
  select 13,
    case when count(*) = 61 then 'PASS' else 'FAIL' end,
    'triggers in public are unchanged (expected 61)',
    count(*)::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal

  union all
  select 14,
    case when count(*) = 77 then 'PASS' else 'FAIL' end,
    'indexes in public are unchanged (expected 77)',
    count(*)::text
  from pg_indexes where schemaname = 'public'

  -- 15. And 051 destroyed nothing. If a TRUNCATE had gone through during the
  --     apply, these would be zero.
  union all
  select 15,
    case when (select count(*) from public.areas) > 0 then 'PASS' else 'FAIL' end,
    'areas still holds its rows',
    (select count(*)::text from public.areas)

  union all
  select 16, 'INFO',
    'birthday_wishlist_ideas row count (a wishlist may legitimately be empty)',
    (select count(*)::text from public.birthday_wishlist_ideas)

  union all
  select 17, 'INFO',
    'application routines remaining in public',
    (select count(*)::text from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))

  union all
  select 18, 'INFO',
    'the two tables, as authenticated now sees them',
    format('areas={%s}, birthday_wishlist_ideas={%s}',
      coalesce((select string_agg(privilege_type, ',' order by privilege_type) from acl where relname = 'areas'), ''),
      coalesce((select string_agg(privilege_type, ',' order by privilege_type) from acl where relname = 'birthday_wishlist_ideas'), ''))
)
select
  status,
  check_name,
  detail
from checks
order by
  case status when 'FAIL' then 0 when 'REVIEW' then 1 when 'PASS' then 2 else 3 end,
  ord;
