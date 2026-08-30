-- Three internal helpers that anybody on the internet could call.
--
-- WHAT WAS WRONG
--
--   `area_of_record`, `area_of_written_row` and `audit_actor_name` are
--   SECURITY DEFINER helpers written for the write barrier (037) and the audit
--   log (015). Nothing is supposed to call them but the trigger functions they
--   were written for. Nothing does.
--
--   They were never granted to anybody on purpose. They did not have to be:
--   Supabase's project default is
--
--       ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--         GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role
--
--   so every function created in `public` arrives callable by the browser
--   roles unless a migration takes that away. Migrations 034-047 revoke the
--   default on the routines they add. These three were missed, and PostgREST
--   exposes any function the calling role may execute -- so they were live
--   RPC endpoints at `/rest/v1/rpc/...` for the ANONYMOUS role.
--
-- MEASURED AGAINST PRODUCTION, NOT INFERRED
--
--   During the Q10 audit, with no session and nothing but the public
--   publishable key:
--
--       POST /rest/v1/rpc/area_of_record
--         { "p_table_name": "events", "p_record_id": "<the real family's
--           Christmas 2026 event id>" }
--
--       200  "<the real family's Area id>"
--
--   Definer rights mean row level security never gets a say. The same call
--   also distinguishes a record id that exists in a given table from one that
--   does not, which is a confirmation oracle for anybody guessing.
--
-- HOW BAD, HONESTLY
--
--   What comes back is a uuid, and the caller must already hold a record uuid
--   to ask the question. No name, amount, gift, birthday or membership is
--   reachable this way, and every table remains refused to `anon` -- checked,
--   all twenty-two. So this is an unauthenticated bypass of row level security
--   with low-value output, not a disclosure of family data. It is fixed here
--   because "the database must refuse on its own" is the rule the whole
--   application rests on, and a definer routine reachable by the anonymous
--   role is not refusing anything.
--
-- WHY A REVOKE AND NOT A REWRITE
--
--   The routines themselves are correct. `area_of_record` dispatches through a
--   fixed CASE over known table names, so there is no injection in it, and it
--   is search_path-pinned like every other definer here. The only defect is
--   who may call it. Nothing about their behaviour changes below.
--
-- WHY THIS BREAKS NOTHING -- CHECKED, NOT ASSUMED
--
--   Against a real PostgreSQL carrying 001-047, every reference to all three
--   was enumerated:
--
--     area_of_record       called by stamp_audit_area            (DEFINER)
--     area_of_written_row  called by refuse_foreign_area_write   (DEFINER)
--     audit_actor_name     called by record_audit_event,
--                          record_birthday_audit_event,
--                          delete_event_if_empty, set_event_status,
--                          transfer_area_admin, update_event     (all DEFINER)
--
--   A SECURITY DEFINER body executes with the OWNER's rights, so none of those
--   call sites consults the caller's grant. And there is no other kind of
--   reference: zero row level security policies, zero views, zero column
--   defaults, zero CHECK constraints, zero index expressions, zero trigger
--   definitions, and zero occurrences anywhere in `src/`.
--
--   The contrast matters. `area_of_event`, `area_of_recipient`,
--   `area_of_purchase` and `area_of_gift_idea` ARE named in policy
--   expressions -- twenty-one of them between them -- so `authenticated` must
--   keep EXECUTE on those or every read through those policies fails. They are
--   deliberately NOT touched here. Neither are they reachable by `anon`.
--
-- WHAT IS DELIBERATELY LEFT ALONE
--
--   `claim_active_area()` is also anon-callable, and must stay that way: it is
--   PostgREST's `db-pre-request` hook (038) and runs on every request,
--   including the anonymous ones the sign-in page makes. It returns void, and
--   it sets the acting Area only after checking the membership table, so
--   calling it directly achieves nothing.
--
--   `service_role` keeps its grant. It bypasses row level security and the
--   write barrier regardless, so removing it would buy nothing and would be a
--   surprise to server-side code later.
--
-- ROLLBACK
--
--   grant execute on function public.area_of_record(text, uuid)       to anon, authenticated;
--   grant execute on function public.area_of_written_row(text, jsonb) to anon, authenticated;
--   grant execute on function public.audit_actor_name()               to anon, authenticated;
--
--   No object is created, altered or dropped here and no row is touched, so
--   there is nothing else to undo.

-- ---------------------------------------------------------------------------
-- 1. Take the default grant away
-- ---------------------------------------------------------------------------

revoke all on function public.area_of_record(text, uuid) from public, anon, authenticated;
revoke all on function public.area_of_written_row(text, jsonb) from public, anon, authenticated;
revoke all on function public.audit_actor_name() from public, anon, authenticated;

comment on function public.area_of_record(text, uuid) is
  'Internal helper for the audit-log Area stamp. Called only from SECURITY DEFINER trigger bodies; not callable by anon or authenticated (048).';
comment on function public.area_of_written_row(text, jsonb) is
  'Internal helper for the cross-Area write barrier. Called only from SECURITY DEFINER trigger bodies; not callable by anon or authenticated (048).';
comment on function public.audit_actor_name() is
  'Internal helper naming the acting member for an audit entry. Called only from SECURITY DEFINER bodies; not callable by anon or authenticated (048).';

-- ---------------------------------------------------------------------------
-- 2. End state
--
-- Says out loud what is now true, and refuses to finish if it is not. Run this
-- file twice and it reports the same thing the second time.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  needed text;
begin
  -- The three are closed to both browser roles.
  foreach fn in array array[
    'public.area_of_record(text, uuid)',
    'public.area_of_written_row(text, jsonb)',
    'public.audit_actor_name()'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    else
      if has_function_privilege('anon', fn, 'execute') then
        problems := problems || format('%s is still callable by anon', fn)::text;
      end if;
      if has_function_privilege('authenticated', fn, 'execute') then
        problems := problems || format('%s is still callable by authenticated', fn)::text;
      end if;
    end if;
  end loop;

  -- And nothing else was taken away with them. These four are named in row
  -- level security policies, so `authenticated` losing EXECUTE would break
  -- ordinary reads for every family.
  foreach needed in array array[
    'public.area_of_event(uuid)',
    'public.area_of_recipient(uuid)',
    'public.area_of_purchase(uuid)',
    'public.area_of_gift_idea(uuid)'
  ] loop
    if to_regprocedure(needed) is null then
      problems := problems || format('%s is missing', needed)::text;
    elsif not has_function_privilege('authenticated', needed, 'execute') then
      problems := problems || format('%s lost the grant its policies need', needed)::text;
    end if;
  end loop;

  -- The pre-request hook stays reachable, or every anonymous request fails.
  if not has_function_privilege('anon', 'public.claim_active_area()', 'execute') then
    problems := problems || 'claim_active_area is no longer callable by anon'::text;
  end if;

  if array_length(problems, 1) is null then
    raise notice 'Migration 048: the three internal helpers are closed to anon and authenticated; policy helpers and the pre-request hook are untouched.';
  else
    raise exception 'Migration 048 did not reach its end state: %', array_to_string(problems, '; ');
  end if;
end;
$$;
