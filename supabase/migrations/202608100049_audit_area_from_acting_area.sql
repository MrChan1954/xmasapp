-- An audit entry that cannot find its Area asks where the writer was standing.
--
-- WHAT WAS WRONG
--
--   `stamp_audit_area` (037) fills `audit_log.area_id` on the way in, and it
--   has two ways to work it out:
--
--     1. look the record up            -- `area_of_record(table_name, record_id)`
--     2. failing that, the actor's own -- but only if they have ONE membership
--
--   Step 1 cannot answer for a DELETE. The audit triggers are AFTER triggers,
--   deliberately, so that the log can never claim something that did not
--   commit -- which means that by the time the entry is written the row is
--   gone and the lookup returns null. 037 knew this and said so:
--
--       "A DELETE is audited after the row has gone, so the lookup finds
--        nothing and the actor's own Area is used instead."
--
--   Step 2 then refuses, correctly, to choose between several memberships:
--
--       "One Area, or none of our business. An actor in two is not guessed at."
--
--   So a deletion by somebody who belongs to more than one family was stored
--   with NO Area at all. That was invisible until Q10 scoped `/more/activity`
--   to the acting Area; from that point those entries could never match, and
--   the screen quietly stopped showing deletions to exactly the account most
--   likely to be administering the family.
--
--   `people_birthday` reaches the same dead end by the other road: it is the
--   name the birthday trigger (026) gives its own kind, no table is called
--   that, and `area_of_record` has no branch for it -- so step 1 returns null
--   for it whether or not anything was deleted.
--
-- MEASURED, NOT INFERRED
--
--   Against production, one gift idea, two entries two minutes apart:
--
--       12:32:33  gift_ideas / added    area_id set     "Q11 audit idea 133226"
--       12:34:51  gift_ideas / removed  area_id NULL    "Q11 audit idea 133226"
--
--   26 of 462 rows carried no Area -- 14 `recipient_contributions/removed`,
--   4 `contributors/removed`, 4 `gift_ideas/removed`, 4 `people_birthday/added`
--   -- and every one of them was written by the single account with more than
--   one membership. The same kinds resolve perfectly for everybody else:
--   `recipient_contributions/removed` has 47 rows WITH an Area beside those 14
--   without, and `people_birthday/added` has 19 beside those 4. The actor's
--   membership count is the discriminator, not the kind.
--
-- THE THIRD ANSWER, BETWEEN THE TWO THAT EXIST
--
--   There is a better answer than the actor's memberships and it was already
--   in the database when 037 was written -- `acting_area()` arrived one
--   migration later, in 038, and nothing went back to offer it to the audit
--   stamper. It is the Area the caller SAID they were working in, and it is
--   only ever set after membership has been checked: `claim_active_area`, the
--   PostgREST pre-request hook, sets it `if public.is_area_member(wanted)`,
--   and `act_in_area` raises unless the same is true. It is also the very
--   value `require_acting_area` has just enforced for the deletion itself, in
--   this same transaction, in every routine that guards one.
--
--   So this is not a guess. It is a membership-checked statement of place,
--   used only where the alternative was to record nothing at all.
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
--
--   One step is inserted between the two that exist. Every outcome the
--   function already produced is produced identically:
--
--     area already on the row              kept            unchanged
--     `area_of_record` resolves it         that Area       unchanged
--     no Area, acting Area declared        was NULL        NOW the acting Area
--     no Area, no acting Area, 1 membership  that one      unchanged
--     no Area, no acting Area, several       NULL          unchanged -- still
--                                                          refuses to guess
--
--   The refusal to choose between memberships is deliberately kept. It is the
--   safety property of 037 and this migration does not spend it: a caller who
--   never said where they were is still not told where they must have been.
--
-- NO DATA IS TOUCHED
--
--   No table, column, index, policy, grant or trigger changes, and not one
--   existing row is updated. The trigger `audit_log_stamp_area` already points
--   at this function by name and keeps doing so. The 26 historical rows above
--   stay exactly as they are: 22 of them refer to records that no longer
--   exist, so their Area cannot be recovered from data -- only guessed from
--   the actor's memberships -- and writing a guess into an append-only audit
--   log to tidy a screen is a worse thing than the gap it would hide.
--
-- ROLLBACK
--
--   Re-apply 037's body, which is the same function without the middle branch.

create or replace function public.stamp_audit_area()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_areas uuid[];
begin
  if new.area_id is not null then
    return new;
  end if;

  -- 1. The record itself. Exact, and the only one of the three that is derived
  --    from data rather than from what the caller said. Null after a DELETE,
  --    and null for `people_birthday`, which is not a table.
  new.area_id := public.area_of_record(new.table_name, new.record_id);
  if new.area_id is not null then
    return new;
  end if;

  -- 2. Where the writer said they were standing, which `claim_active_area` and
  --    `act_in_area` both refuse to set unless `is_area_member` passes. For a
  --    guarded routine this is the same Area `require_acting_area` has already
  --    demanded the record belong to, so the deletion and its audit entry
  --    cannot disagree.
  new.area_id := public.acting_area();
  if new.area_id is not null then
    return new;
  end if;

  -- 3. One membership, or none of our business. An actor in two is not guessed
  --    at -- unchanged from 037, and still the last word.
  if new.actor_user_id is not null then
    select array_agg(distinct m.area_id) into actor_areas
    from public.app_members m
    where m.user_id = new.actor_user_id and m.active = true;

    if array_length(actor_areas, 1) = 1 then
      new.area_id := actor_areas[1];
    end if;
  end if;

  return new;
end;
$$;

comment on function public.stamp_audit_area() is
  'BEFORE INSERT on audit_log: fills area_id from the record, else from the membership-checked acting Area, else from a single membership. Never guesses between several.';

-- ---------------------------------------------------------------------------
-- End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  body text;
begin
  if to_regprocedure('public.stamp_audit_area()') is null then
    problems := problems || 'stamp_audit_area is missing';
  else
    body := pg_get_functiondef(to_regprocedure('public.stamp_audit_area()')::oid);

    if body not like '%public.acting_area()%' then
      problems := problems || 'stamp_audit_area does not consult the acting Area';
    end if;

    -- The refusal this migration promised to keep.
    if body not like '%array_length(actor_areas, 1) = 1%' then
      problems := problems || 'the single-membership guard is gone -- an actor in two would be guessed at';
    end if;

    if body not like '%public.area_of_record(new.table_name, new.record_id)%' then
      problems := problems || 'the record lookup is gone';
    end if;
  end if;

  -- The trigger is not recreated here; it must still be the one 037 made.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'audit_log_stamp_area'
      and n.nspname = 'public' and c.relname = 'audit_log'
      and not t.tgisinternal
  ) then
    problems := problems || 'the audit_log_stamp_area trigger is missing';
  end if;

  if array_length(problems, 1) > 0 then
    raise exception 'Migration 049 end state failed: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Migration 049: an audit entry now learns its Area from the acting Area when the record is gone.';
end;
$$;
