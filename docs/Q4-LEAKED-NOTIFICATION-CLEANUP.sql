-- =====================================================================
--  DO NOT RUN WITHOUT USER APPROVAL.
--  DO NOT RUN WITHOUT USER APPROVAL.
--  DO NOT RUN WITHOUT USER APPROVAL.
--
--  This file has never been executed. It is a reviewed artifact, not a
--  migration: it is not in `supabase/migrations`, nothing applies it
--  automatically, and it must never be added there. Migrations 001-045 are
--  immutable and this is not 046.
-- =====================================================================
--
-- WHAT THIS CLEANS UP, AND WHY IT EXISTS
--
--   On 2026-08-28, before the notification-audience fix in commit ffb327f,
--   `loadFamilyContext` was called without its `areaId` argument. That argument
--   defaults to null, and null means "every membership in the database". Two
--   gift ideas added inside QA Charlie were therefore announced to every member
--   of every Area, including the four real members of `Our family`.
--
--   Eight rows landed in real people's notification centres. Each one is
--   titled "New gift idea for <QA person>" -- naming somebody who exists only
--   in a synthetic QA Area -- and links to a QA Charlie event those readers
--   cannot open. They are noise about strangers, and they are unread.
--
--   The BUG is already fixed and verified live: the same action now produces
--   exactly one notification, inside QA Charlie only. This file only removes
--   the eight rows the bug produced before it was fixed.
--
-- WHY THESE EIGHT ARE PROVABLY SYNTHETIC
--
--   Each row satisfies ALL of the following, and the guards below re-check
--   every one of them at run time rather than trusting this comment:
--
--     * the reader is an `app_members` row whose Area is `Our family`;
--     * `event_kind` is 'gift_idea';
--     * the subject gift idea resolves, through christmas_recipients and
--       events, to an Area that is NOT `Our family`;
--     * `created_at` is one of the two exact QA timestamps;
--     * the row is still unread.
--
--   NO REAL-FAMILY DATA IS INVOLVED. No purchase, budget, settlement, person,
--   event or audit row is touched. `people`, `app_members`, `events` and
--   `audit_log` for `Our family` were all last written on or before
--   2026-08-25 and were not altered by the leak.
--
-- HOW TO USE THIS FILE
--
--   1. Run STEP 1 alone. Read the eight rows it returns.
--   2. Only if STEP 1 returns exactly 8 rows, and every one of them is about a
--      QA person, run STEP 2.
--   3. STEP 2 aborts loudly rather than deleting anything unexpected.
--
--   Deleting is irreversible. There is no undo. The rows are harmless where
--   they are -- this is tidying, not a fix.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1 -- PREVIEW. Read-only. Run this first, on its own.
-- ---------------------------------------------------------------------

select
  n.id,
  n.created_at,
  n.read_at,
  n.event_kind,
  n.title,
  reader_area.name  as delivered_into,
  subject_area.name as subject_actually_belongs_to
from public.notifications n
join public.app_members  am           on am.id = n.app_member_id
join public.areas        reader_area  on reader_area.id = am.area_id
left join public.gift_ideas g         on g.id  = n.event_subject_id
left join public.christmas_recipients r on r.id = g.christmas_recipient_id
left join public.events  e            on e.id  = r.christmas_event_id
left join public.areas   subject_area on subject_area.id = e.area_id
where n.id in (
  '1dde9e37-0086-4303-a7d9-9c7afabf4ee7',
  '8513b9d1-d9dd-4bb4-8ed5-3c5eab46ca0d',
  '78c5992d-636f-4767-a142-917a997c36c8',
  'a982681e-0a87-43bc-955e-9b858b84e5a8',
  'c5df08fc-9f8a-42a7-a5f2-9418ee27ca60',
  '814d0371-e200-44d7-a7ed-c89c7470c293',
  'ae6a3097-0946-4844-88ad-f745a46c1b2f',
  '8d8ebc53-7209-4218-a5ac-0f55c57d5205'
)
order by n.created_at, n.id;

-- EXPECTED: exactly 8 rows.
--   delivered_into              = 'Our family'      (all 8)
--   subject_actually_belongs_to = 'QA Charlie'      (all 8)
--   event_kind                  = 'gift_idea'       (all 8)
--   read_at                     = null              (all 8)
-- If ANY row differs, STOP. Do not run STEP 2.


-- ---------------------------------------------------------------------
-- STEP 2 -- GUARDED DELETE. Only after STEP 1 looks exactly as described.
--
-- Every guard raises rather than deleting. A single mismatched row aborts
-- the whole transaction, because the failure mode of a cleanup that guesses
-- is a real notification removed from somebody's real Christmas.
-- ---------------------------------------------------------------------

do $$
declare
  target_ids uuid[] := array[
    '1dde9e37-0086-4303-a7d9-9c7afabf4ee7',
    '8513b9d1-d9dd-4bb4-8ed5-3c5eab46ca0d',
    '78c5992d-636f-4767-a142-917a997c36c8',
    'a982681e-0a87-43bc-955e-9b858b84e5a8',
    'c5df08fc-9f8a-42a7-a5f2-9418ee27ca60',
    '814d0371-e200-44d7-a7ed-c89c7470c293',
    'ae6a3097-0946-4844-88ad-f745a46c1b2f',
    '8d8ebc53-7209-4218-a5ac-0f55c57d5205'
  ]::uuid[];
  found_count      int;
  bad_count        int;
  deleted_count    int;
begin
  -- GUARD 1. All eight must still exist. Fewer means somebody already acted,
  -- and this file must not guess what they intended.
  select count(*) into found_count
    from public.notifications where id = any(target_ids);
  if found_count <> 8 then
    raise exception
      'ABORT: expected 8 target notifications, found %. Nothing deleted.', found_count;
  end if;

  -- GUARD 2. Every target must be delivered into `Our family`, be a gift_idea,
  -- still be unread, carry one of the two known QA timestamps, and have a
  -- subject that lives in a DIFFERENT Area. Anything else is not this leak.
  select count(*) into bad_count
  from public.notifications n
  join public.app_members am          on am.id = n.app_member_id
  join public.areas reader_area       on reader_area.id = am.area_id
  left join public.gift_ideas g       on g.id = n.event_subject_id
  left join public.christmas_recipients r on r.id = g.christmas_recipient_id
  left join public.events e           on e.id = r.christmas_event_id
  where n.id = any(target_ids)
    and not (
          reader_area.name = 'Our family'
      and n.event_kind     = 'gift_idea'
      and n.read_at is null
      and n.created_at in (
            timestamptz '2026-08-28T19:27:07.410489+00:00',
            timestamptz '2026-08-28T19:45:26.879412+00:00'
          )
      and e.area_id is not null
      and e.area_id <> am.area_id          -- the whole point: foreign subject
    );
  if bad_count <> 0 then
    raise exception
      'ABORT: % target row(s) do not match the leak signature. Nothing deleted.', bad_count;
  end if;

  -- GUARD 3. Belt and braces -- refuse if any target's subject event somehow
  -- belongs to `Our family` after all.
  select count(*) into bad_count
  from public.notifications n
  left join public.gift_ideas g       on g.id = n.event_subject_id
  left join public.christmas_recipients r on r.id = g.christmas_recipient_id
  left join public.events e           on e.id = r.christmas_event_id
  join public.areas a                 on a.id = e.area_id
  where n.id = any(target_ids)
    and a.name = 'Our family';
  if bad_count <> 0 then
    raise exception
      'ABORT: % target row(s) are about real family data. Nothing deleted.', bad_count;
  end if;

  delete from public.notifications where id = any(target_ids);
  get diagnostics deleted_count = row_count;

  if deleted_count <> 8 then
    raise exception
      'ABORT: deleted % rows, expected 8. Transaction rolled back.', deleted_count;
  end if;

  raise notice 'Removed % leaked QA notifications from Our family.', deleted_count;
end
$$;


-- ---------------------------------------------------------------------
-- STEP 3 -- VERIFY AFTER. Read-only.
-- ---------------------------------------------------------------------

-- Expect 29: the count `Our family` held at 2026-08-28T19:05Z, before the leak.
select count(*) as our_family_notifications_after_cleanup
from public.notifications n
join public.app_members am on am.id = n.app_member_id
join public.areas a        on a.id = am.area_id
where a.name = 'Our family';
