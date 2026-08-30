-- =============================================================================
-- Q12 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATION 050
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and its own rows, and
--   tells you line by line whether migration 050 is really in place: the two
--   columns, the absence of a foreign key on one of them, the coherence
--   constraint, the partial index, all four clauses of the audit_log policy,
--   the guards inside three routines, the stamping inside four more, and --
--   most importantly -- whether the backfill actually agrees with the data.
--
--   IT ONLY READS. There is no insert, update, delete or DDL anywhere in this
--   file. Running it twice changes nothing.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You will get one table back. Read the first column.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine. Nothing to do.
--   FAIL     something is wrong. Do not deploy. Send the whole table back.
--   INFO     a fact for the record, not a pass or a fail.
--
--   FAIL rows sort to the TOP.
--
-- THE TWO CHECKS THAT MATTER MOST
--   `structural agreement` and `nothing left unclassified` do not trust the
--   backfill's own arithmetic. They re-derive the answer from the surviving
--   records and compare it against what is stored. If the backfill had stamped
--   the wrong person, or missed a row, those two would say FAIL even though
--   every count elsewhere looked right.
-- =============================================================================

with resolved as (
  select
    l.id,
    l.celebrant_person_id,
    l.birthday_privacy_unknown,
    l.table_name in (
      'events', 'christmas_recipients', 'contributors', 'recipient_contributions',
      'gift_ideas', 'purchases', 'purchase_allocations', 'settlements',
      'item_photos', 'payment_receipts'
    ) as planning_sensitive,
    case l.table_name
      when 'events' then l.record_id
      when 'christmas_recipients' then (
        select r.christmas_event_id from public.christmas_recipients r where r.id = l.record_id)
      when 'contributors' then (
        select c.christmas_event_id from public.contributors c where c.id = l.record_id)
      when 'settlements' then (
        select s.christmas_event_id from public.settlements s where s.id = l.record_id)
      when 'payment_receipts' then (
        select pr.christmas_event_id from public.payment_receipts pr where pr.id = l.record_id)
      when 'gift_ideas' then (
        select r.christmas_event_id
          from public.gift_ideas g
          join public.christmas_recipients r on r.id = g.christmas_recipient_id
         where g.id = l.record_id)
      when 'purchases' then (
        select r.christmas_event_id
          from public.purchases p
          join public.christmas_recipients r on r.id = p.christmas_recipient_id
         where p.id = l.record_id)
      when 'recipient_contributions' then (
        select r.christmas_event_id
          from public.recipient_contributions rc
          join public.christmas_recipients r on r.id = rc.christmas_recipient_id
         where rc.id = l.record_id)
      when 'purchase_allocations' then (
        select r.christmas_event_id
          from public.purchase_allocations pa
          join public.purchases p on p.id = pa.purchase_id
          join public.christmas_recipients r on r.id = p.christmas_recipient_id
         where pa.id = l.record_id)
      when 'item_photos' then (
        select r.christmas_event_id
          from public.item_photos ip
          left join public.purchases  p on p.id = ip.purchase_id
          left join public.gift_ideas g on g.id = ip.gift_idea_id
          join public.christmas_recipients r
            on r.id = coalesce(p.christmas_recipient_id, g.christmas_recipient_id)
         where ip.id = l.record_id)
      else null
    end as event_id
  from public.audit_log l
),
judged as (
  select
    d.*,
    e.event_type,
    e.celebrant_person_id as true_celebrant,
    case
      when not d.planning_sensitive then 'not-sensitive'
      when e.id is null then 'unresolvable'
      when e.event_type = 'birthday' and e.celebrant_person_id is null then 'unresolvable'
      when e.event_type = 'birthday' then 'birthday'
      else 'not-a-birthday'
    end as verdict
  from resolved d
  left join public.events e on e.id = d.event_id
),
checks as (

  select 1 as ord, 'INFO' as status, 'audit_log rows in total' as check_name,
         count(*)::text as detail from public.audit_log

  union all
  select 2,
    case when count(*) filter (where attname = 'celebrant_person_id') = 1
          and count(*) filter (where attname = 'birthday_privacy_unknown') = 1
         then 'PASS' else 'FAIL' end,
    'both privacy columns exist',
    string_agg(attname || ' ' || format_type(atttypid, atttypmod)
               || case when attnotnull then ' not null' else '' end, ', ' order by attname)
  from pg_attribute
  where attrelid = 'public.audit_log'::regclass and attnum > 0 and not attisdropped
    and attname in ('celebrant_person_id', 'birthday_privacy_unknown')

  union all
  -- The design property that keeps the marker durable: no FK, so no later
  -- deletion can null it and make an entry more visible.
  select 3,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'celebrant_person_id carries NO foreign key',
    coalesce(string_agg(conname, ', '), 'none, as intended')
  from pg_constraint
  where conrelid = 'public.audit_log'::regclass and contype = 'f'
    and 'celebrant_person_id' = any (
      select a.attname from pg_attribute a
      where a.attrelid = conrelid and a.attnum = any (conkey))

  union all
  select 4,
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    'coherence constraint present',
    coalesce(string_agg(pg_get_constraintdef(oid), ' '), 'MISSING')
  from pg_constraint
  where conrelid = 'public.audit_log'::regclass
    and conname = 'audit_log_privacy_subject_is_coherent'

  union all
  select 5,
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    'partial index present',
    coalesce(string_agg(indexdef, ' '), 'MISSING')
  from pg_indexes
  where schemaname = 'public' and indexname = 'audit_log_celebrant_idx'

  union all
  select 6,
    case when qual ilike '%is_active_app_member%'
          and qual ilike '%is_area_member%'
          and qual ilike '%birthday_privacy_unknown%'
          and qual ilike '%celebrant_person_id%'
         then 'PASS' else 'FAIL' end,
    'audit_log SELECT policy has all four clauses',
    qual
  from (
    select pg_get_expr(pol.polqual, pol.polrelid) as qual
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'audit_log'
      and pol.polname = 'members read the audit log'
  ) p

  union all
  select 7,
    case when count(*) = 3 then 'PASS' else 'FAIL' end,
    'the three own-birthday guards are in place',
    string_agg(proname, ', ' order by proname)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      (p.proname in ('set_purchase_status', 'void_purchase')
       and p.prosrc ilike '%is_own_birthday_purchase(p_purchase_id)%')
      or (p.proname = 'save_gift_idea'
       and p.prosrc ilike '%is_own_birthday_recipient(p_christmas_recipient_id)%')
    )

  union all
  select 8,
    case when count(*) = 4 then 'PASS' else 'FAIL' end,
    'the four stamping routines write the privacy columns',
    string_agg(proname, ', ' order by proname)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('record_audit_event', 'update_event', 'set_event_status', 'delete_event_if_empty')
    and p.prosrc ilike '%birthday_privacy_unknown%'

  union all
  select 9,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'anon still holds no grant on audit_log',
    coalesce(string_agg(privilege_type, ', '), 'none, as intended')
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'audit_log' and grantee = 'anon'

  -- ---- the data itself -----------------------------------------------------

  union all
  select 10,
    case when count(*) >= 92 then 'PASS' else 'FAIL' end,
    'entries stamped with a celebrant (reviewed baseline 92)',
    count(*)::text
  from public.audit_log where celebrant_person_id is not null

  union all
  select 11,
    case when count(*) >= 154 then 'PASS' else 'FAIL' end,
    'entries marked privacy-unknown (reviewed baseline 154)',
    count(*)::text
  from public.audit_log where birthday_privacy_unknown

  union all
  select 12,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'no entry both names a celebrant and admits it cannot',
    count(*)::text
  from public.audit_log
  where celebrant_person_id is not null and birthday_privacy_unknown

  union all
  -- THE ONE THAT MATTERS. Re-derived from the surviving records, not trusted.
  select 13,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'structural agreement: every resolvable entry names the right celebrant',
    count(*)::text || ' disagreeing rows'
  from judged
  where verdict = 'birthday'
    and celebrant_person_id is distinct from true_celebrant

  union all
  -- An entry can be unresolvable TODAY and still perfectly classified, because
  -- after 050 the stamp is written at the moment of the write, while the chain
  -- is still intact. Deleting the record afterwards does not unclassify it --
  -- that durability is the whole reason the subject is stamped rather than
  -- looked up. So the fault to look for is an unresolvable entry that is
  -- NEITHER stamped NOR marked, which is the only state that could leak.
  select 14,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'nothing left unclassified: every unresolvable entry is stamped or marked',
    count(*)::text || ' unclassified rows'
  from judged
  where verdict = 'unresolvable'
    and not birthday_privacy_unknown
    and celebrant_person_id is null

  union all
  select 15,
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    'no Christmas or non-birthday entry was stamped',
    count(*)::text
  from judged
  where verdict in ('not-a-birthday', 'not-sensitive')
    and (celebrant_person_id is not null or birthday_privacy_unknown)

  union all
  select 16,
    case when count(*) = 26 then 'PASS'
         when count(*) > 26 then 'FAIL'   -- new Area-less entries: 049 regressed
         else 'INFO' end,                 -- fewer: somebody backfilled them
    'the historic Area-less entries are still Area-less (expected 26)',
    count(*)::text
  from public.audit_log where area_id is null

  union all
  select 17, 'INFO',
    'entries by privacy verdict',
    string_agg(verdict || '=' || n::text, ', ' order by verdict)
  from (select verdict, count(*) as n from judged group by verdict) v

  union all
  select 18, 'INFO',
    'distinct celebrants protected',
    count(distinct celebrant_person_id)::text
  from public.audit_log where celebrant_person_id is not null
)
select
  status,
  check_name,
  detail
from checks
order by
  case status when 'FAIL' then 0 when 'REVIEW' then 1 when 'PASS' then 2 else 3 end,
  ord;
