-- ===========================================================================
-- MIGRATION 053 -- FAMILY INVITATION CONSENT
-- ===========================================================================
--
-- WHAT CHANGES, IN ONE SENTENCE
--
--   Confirming an email address, or signing in, stops joining you to a family.
--
-- WHY THIS EXISTS
--
--   `claim_app_member()` is called on every sign-in and every auth callback.
--   Its body is one UPDATE with no `where id =`, so it claims EVERY unclaimed
--   invitation addressed to the caller's confirmed address, in EVERY Area, with
--   no consent step and no way for the caller to learn which families they just
--   joined. That was coherent while invitations were private and issued by one
--   trusted person. Public sign-up (052) makes it wrong: an address typed into
--   Family Access became a silent membership the moment its owner confirmed it.
--
--   053 replaces that with an explicit answer. An invitation is offered, and
--   the invitee accepts it or declines it -- by name, one at a time, proving
--   the address is theirs each time.
--
--       auth.users            you can sign in
--         -> app_accounts     a human has approved you for Gift Planner   (052)
--            -> app_members   a family invited you AND YOU SAID YES       (053)
--               -> role       what you may do inside that family
--
-- THE SHAPE OF THE CHANGE
--
--   `app_members` stays canonical. It already distinguishes invitation from
--   membership with `user_id`, which is the same column every permission
--   predicate reads -- so an invitation cannot be mistaken for a membership by
--   construction. The one fact it could not express is DECLINED, which was
--   byte-identical to revoked-and-unlinked. That is the whole of the new state:
--   one nullable `declined_at`, not an enum. Every other state is derived from
--   `(user_id, active, declined_at)` plus the global account status, and
--   therefore cannot contradict itself.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--
--   * NO second invitation table. Two tables that both answer "is this person
--     in?" can disagree, and only one of them is the one RLS reads.
--   * NO expiry. An expiry is a state change with no actor and no audit row.
--     Revoke is the explicit form of the same intent.
--   * NO policy added, and none dropped. All four new routines are SECURITY
--     DEFINER; a policy letting a non-member read an `app_members` row would be
--     a new hole, and none of them needs one.
--   * NO widening of `audit_log_action_check`. Every invitation event maps onto
--     `added` / `removed` / `restored`, which is honest.
--   * NO backfill. `declined_at` is null on every existing row and null is the
--     correct meaning for all of them.
--   * NO routine anywhere takes an email address or a user id. Not one. An RPC
--     that took an address would be an account-existence oracle whatever it
--     claimed to be for.
--   * NO grant to `service_role`. The delivery audit is written with the
--     administrator's own session, so the service role gains no new power.
--
-- ONE BEHAVIOURAL NOTE THAT IS NOT A BACKFILL
--
--   The instant this applies, any outstanding unclaimed invitation stops being
--   auto-claimable and starts requiring Accept. That is the point of the
--   migration. Anyone holding one is told to accept it; no row is rewritten.
--
-- DEPLOY ORDER, SAFE IN BOTH DIRECTIONS
--
--   The database goes FIRST. `claim_app_member()` survives as a stub returning
--   false, which every existing caller already treats as the ordinary case, so
--   the pre-053 runtime keeps working and simply stops joining anybody. The
--   runtime that calls the new routines ships afterwards, by which time they
--   exist. Neither order breaks a live session.
--
-- ROLLBACK
--
--   `docs/Q20-053-ROLLBACK.sql`. Read its header first: dropping `declined_at`
--   destroys decline history, and rolling back restores the silent auto-join.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT -- refuse to apply to a database that is not 052's end state
--
-- In 052's own style. Every object this migration redefines is one it must
-- first FIND, because `create or replace` on a routine that is not there is how
-- a migration silently invents a new one.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
begin
  if to_regclass('public.app_accounts') is null then
    problems := problems || 'app_accounts is missing -- migration 052 has not been applied'::text;
  end if;

  if to_regclass('public.app_members') is null then
    problems := problems || 'app_members is missing'::text;
  end if;

  -- The four routines 053 redefines. All must already exist.
  foreach fn in array array[
    'refuse_foreign_area_write', 'grant_area_access', 'list_area_access', 'claim_app_member'
  ] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace
    ) then
      problems := problems || format('%s is missing -- 053 redefines it and will not create it blind', fn);
    end if;
  end loop;

  -- The routines 053 depends on but does not touch.
  foreach fn in array array[
    'area_of_person', 'require_acting_area', 'is_area_admin', 'acting_area',
    'is_globally_approved', 'area_of_record', 'stamp_audit_area', 'area_of_written_row'
  ] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace
    ) then
      problems := problems || format('%s is missing -- 053 depends on it', fn);
    end if;
  end loop;

  -- 052 section 9: the predicates that carry the global gate. If one of them
  -- had lost `is_globally_approved()`, accepting an invitation while globally
  -- pending would no longer be harmless, and this migration's central
  -- justification would be false.
  foreach fn in array array[
    'is_active_app_member', 'is_area_member', 'is_area_admin', 'is_own_app_member',
    'is_app_admin', 'is_area_contributor_member'
  ] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace
        and pg_get_functiondef(oid) like '%is_globally_approved%'
    ) then
      problems := problems || format('%s does not carry the 052 global-approval gate', fn);
    end if;
  end loop;

  -- The action list 052 left behind. 053 adds no eighth word and would be
  -- writing an illegal row if this were narrower than it expects.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_log'::regclass
      and conname = 'audit_log_action_check'
      and pg_get_constraintdef(oid) like '%''restored''%'
  ) then
    problems := problems || 'audit_log_action_check does not permit ''restored'''::text;
  end if;

  if array_length(problems, 1) > 0 then
    raise exception 'Migration 053 preflight failed: %', array_to_string(problems, '; ');
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 1. THE ONE NEW FACT
--
-- A declined invitation and a revoked-then-unlinked seat were byte-identical:
-- `user_id is null, active = false`. That is the only genuine ambiguity in the
-- table, and one nullable timestamp is the whole fix.
--
-- NOT AN ENUM. A persisted `state` column sitting beside `user_id` and `active`
-- would be a third source of truth for one fact, free to contradict the two the
-- permission system actually reads.
-- ---------------------------------------------------------------------------

alter table public.app_members
  add column if not exists declined_at timestamptz;

comment on column public.app_members.declined_at is
  'When the invitee refused this invitation. Non-null implies an unclaimed, inactive row: a '
  'decline never touches a membership. Cleared by grant_area_access when the family invites '
  'that person again, which restores an INVITATION and never a membership (053).';

-- The invariant that keeps the column honest: a decline is something that
-- happens to an invitation, never to a seat somebody is sitting in.
--
-- `not valid` is the house style from 011 and costs nothing here -- no existing
-- row can violate it, because `declined_at` is null on every one of them -- and
-- it is enforced in full from this moment on, for every insert and every update.
alter table public.app_members
  drop constraint if exists app_members_declined_is_unclaimed;

alter table public.app_members
  add constraint app_members_declined_is_unclaimed
  check (declined_at is null or (user_id is null and active = false))
  not valid;

-- The only reader of this index is `list_my_family_invitations()`, which asks
-- exactly this question: which open invitations are addressed to me?
create index if not exists app_members_open_invitation_idx
  on public.app_members (lower(email))
  where user_id is null and active = true and declined_at is null;


-- ---------------------------------------------------------------------------
-- 2. THE WRITE BARRIER LEARNS ONE MORE SHAPE
--
-- 042's body, reproduced, plus ONE branch -- exactly as 042 itself did to 037's.
--
-- WHY A NEW BRANCH IS UNAVOIDABLE. `refuse_foreign_area_write()` refuses any
-- write touching an Area the caller is not already a member of. An invitee is
-- BY DEFINITION not a member of the Area they are answering about.
--
--   * ACCEPT needs nothing new. It writes `user_id = auth.uid()` and nothing
--     else, which is precisely the shape 042's existing exemption already
--     permits. That is not a coincidence -- it is why accept was designed to
--     write that and only that.
--   * DECLINE does not fit. It writes `active` and `declined_at` on a row whose
--     `user_id` stays null, so the caller never becomes a member and 042's
--     branch never matches.
--
-- The new branch is as narrow as the case: an unclaimed row that STAYS
-- unclaimed, addressed to the caller's own CONFIRMED address, going from active
-- to inactive and from not-declined to declined, in the same Area. It can move
-- nothing between families, attach no login, and grant nothing to anybody -- and
-- it cannot touch a membership, because a membership has a `user_id`.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_foreign_area_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subject record;
  before_area uuid;
  after_area uuid;
begin
  -- Nobody behind the request: a migration, the notification dispatcher, the
  -- reminder job, or the application's own admin client. None of them has a
  -- membership to check, and all of them are already trusted with the whole
  -- database.
  if (select auth.uid()) is null then
    return coalesce(new, old);
  end if;

  /*
   * SOMEBODY BECOMING A MEMBER (042, unchanged -- and now the accept path).
   *
   * At the instant an invitation is accepted the row has no `user_id`, so the
   * caller is not yet a member of that Area, so this barrier would refuse the
   * very write that makes them one.
   *
   * The exemption is as narrow as the case:
   *   * `app_members` only, and only an UPDATE;
   *   * only a row that had NO login at all -- an invitation, never a membership;
   *   * only setting it to the CALLER'S OWN id, so nobody can claim for anybody;
   *   * only when the row is addressed to the caller's own email address;
   *   * and the Area may not change, so this can move nothing between families.
   */
  if tg_table_name = 'app_members' and tg_op = 'UPDATE' then
    if old.user_id is null
      and new.user_id = (select auth.uid())
      and new.area_id is not distinct from old.area_id
      and new.email is not null
      and lower(new.email) = lower((
        select auth_user.email from auth.users as auth_user
        where auth_user.id = (select auth.uid())
      ))
    then
      return new;
    end if;

    /*
     * MIGRATION 053: SOMEBODY SAYING NO.
     *
     * The mirror image of the branch above, and strictly smaller: it does not
     * attach a login, it removes an offer. `user_id` is null before AND after,
     * so no membership exists at any point, and nothing about this write can
     * grant a read to anybody.
     *
     * The address must be the caller's own CONFIRMED one -- stricter than the
     * accept branch above, which inherits 042's comparison. Declining is only
     * reachable through `decline_family_invitation`, which demands a confirmed
     * address too; the barrier says so independently so that the refusal does
     * not depend on which routine happened to make the write.
     */
    if old.user_id is null
      and new.user_id is null
      and old.active = true
      and new.active = false
      and old.declined_at is null
      and new.declined_at is not null
      and new.area_id is not distinct from old.area_id
      and new.email is not null
      and lower(new.email) = lower((
        select auth_user.email from auth.users as auth_user
        where auth_user.id = (select auth.uid())
          and auth_user.email_confirmed_at is not null
      ))
    then
      return new;
    end if;
  end if;

  if tg_op <> 'INSERT' then
    subject := old;
    before_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  if tg_op <> 'DELETE' then
    subject := new;
    after_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  -- AN AREA WITH NOBODY IN IT BELONGS TO NOBODY. The first membership has to be
  -- written by someone who is not yet a member -- that is what `create_area`
  -- does, and there is no order of statements that avoids it. So an Area with
  -- no members at all is open, and closes the instant one exists.
  if after_area is not null and not exists (
    select 1 from public.app_members m where m.area_id = after_area
  ) then
    return coalesce(new, old);
  end if;

  if before_area is not null and not public.is_area_member(before_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  if after_area is not null and not public.is_area_member(after_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.refuse_foreign_area_write() is
  'Refuses any write touching an Area the caller is not a member of. Two exemptions, both on '
  'app_members UPDATE and both requiring the row be addressed to the caller: accepting an '
  'invitation (042) and declining one (053). Neither may change area_id (053).';


-- ---------------------------------------------------------------------------
-- 3. WHAT THE INVITEE CAN ASK, AND WHAT THEY CAN ANSWER
--
-- Three routines, and NOT ONE OF THEM TAKES AN EMAIL ADDRESS OR A USER ID.
-- Every one resolves the caller from `auth.uid()` and the address from
-- `auth.users`, so there is no parameter anywhere for a caller to lie in.
--
-- The invitation id is a SELECTOR, NEVER A CREDENTIAL. It picks a row; the row
-- is then only acted on if it is addressed to the caller's own confirmed
-- address. Knowing a uuid buys nothing at all.
-- ---------------------------------------------------------------------------

-- 3a. What is waiting for me.
--
-- SECURITY DEFINER is REQUIRED here, not merely convenient: `app_members` RLS
-- only lets a caller read a row they already hold, which is false for every
-- invitation by definition.
--
-- NO GLOBAL-APPROVAL GATE, on purpose. A globally pending account must be able
-- to see and answer an invitation -- that is the product requirement, and it is
-- safe because accepting while pending grants nothing (see 3b).

create or replace function public.list_my_family_invitations()
returns table (
  invitation_id uuid,
  area_name text,
  invited_as text,
  invited_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
begin
  if caller is null then
    return;
  end if;

  -- CONFIRMED, or nothing. An unconfirmed address is a claim, not a fact, and
  -- an invitation is answered by the person who owns the address.
  select lower(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = caller
    and auth_user.email_confirmed_at is not null;

  if caller_email is null or caller_email = '' then
    return;
  end if;

  -- WHAT IS DISCLOSED, AND WHY EACH OF THE THREE IS NEEDED: the family's name
  -- and the invited seat's own person name, because the invitee is being asked
  -- to consent to joining THAT family AS THAT PERSON and cannot answer without
  -- both, and when they were asked. Nothing financial. No event. No other
  -- person. No member list. No email address, not even their own.
  return query
    select
      m.id,
      a.name,
      p.name,
      m.created_at
    from public.app_members m
    join public.areas a on a.id = m.area_id
    left join public.people p on p.id = m.person_id
    where m.user_id is null
      and m.active = true
      and m.declined_at is null
      and lower(m.email) = caller_email
      -- Inherited from 042 for the same reason: an invitation into a family
      -- this login is already in is not offerable, because
      -- `app_members_user_per_area_idx` would refuse the accept.
      and not exists (
        select 1 from public.app_members mine
        where mine.area_id = m.area_id
          and mine.user_id = caller
      )
    order by a.name, m.created_at;
end;
$$;

revoke all on function public.list_my_family_invitations() from public, anon;
grant execute on function public.list_my_family_invitations() to authenticated;

comment on function public.list_my_family_invitations() is
  'The open invitations addressed to the CALLER''S OWN confirmed email address. No parameter '
  'of any kind, so it cannot be pointed at another address or another account. Returns the '
  'family name, the invited person''s name and the timestamp -- nothing financial, no event, '
  'no other person. Zero rows, never an error, for signed out / unconfirmed / nothing '
  'pending, so the surface cannot tell those apart (053).';


-- 3b. Yes.
--
-- GLOBAL APPROVAL IS DELIBERATELY NOT REQUIRED. Every permission predicate in
-- the schema already carries `is_globally_approved()` (052 section 9), so a
-- membership held by a pending account grants zero reads and zero writes, and
-- 052 already ships `awaiting_global_approval` as a Family Access status for
-- exactly this shape. Accepting while pending therefore needs no new gate and
-- creates no new state: approval alone activates it later, with no second join
-- action. `rejected` and `suspended` are refused, because those are decisions a
-- person took about this account.
--
-- ONE SENTENCE FOR EVERY WRONG ROW. A guessed uuid, a real invitation belonging
-- to somebody else, an already-claimed row, a declined row and a revoked row
-- all produce the same refusal. That is what stops the id being an oracle.

create or replace function public.accept_family_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  account_status text;
  seat public.app_members%rowtype;
  family_name text;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select lower(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = caller
    and auth_user.email_confirmed_at is not null;

  if caller_email is null or caller_email = '' then
    raise exception 'Confirm your email address first' using errcode = '42501';
  end if;

  -- A missing row is `pending`, exactly as `my_account_status()` reports it.
  select coalesce(a.status, 'pending') into account_status
  from public.app_accounts a
  where a.user_id = caller;
  account_status := coalesce(account_status, 'pending');

  if account_status in ('rejected', 'suspended') then
    raise exception 'This account cannot join a family' using errcode = '42501';
  end if;

  -- THE ID SELECTS. THE ADDRESS AUTHORIZES. Every conjunct below is part of the
  -- selection, so failing any of them lands on the one refusal sentence.
  select * into seat
  from public.app_members m
  where m.id = p_invitation_id
    and m.user_id is null
    and m.active = true
    and m.declined_at is null
    and lower(m.email) = caller_email
    and not exists (
      select 1 from public.app_members mine
      where mine.area_id = m.area_id
        and mine.user_id = caller
    );

  if seat.id is null then
    raise exception 'That invitation is not yours.' using errcode = '42501';
  end if;

  select a.name into family_name from public.areas a where a.id = seat.area_id;

  -- EXACTLY TWO COLUMNS. Not `role`, not `contributor_id`, not `person_id`, not
  -- `area_id`, not `active`, and nothing in any other table. This is the shape
  -- 042's barrier exemption permits, and the reason it is permitted.
  update public.app_members
  set user_id = caller,
      updated_at = now()
  where id = seat.id;

  -- `record_audit_event` does not fire for this: it reports an UPDATE only when
  -- it crosses the `active` boundary, and accepting does not. So the event is
  -- written here or it is not written at all.
  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_members', seat.id, 'added', caller, null,
    format('Joined %s', coalesce(family_name, 'the family')),
    null, null, null, '{}'::jsonb,
    seat.area_id, null, false
  );

  return seat.area_id;
end;
$$;

revoke all on function public.accept_family_invitation(uuid) from public, anon;
grant execute on function public.accept_family_invitation(uuid) to authenticated;

comment on function public.accept_family_invitation(uuid) is
  'Turns ONE named invitation into a membership, for the account whose own confirmed email '
  'address it is addressed to. The id is a selector, never a credential: a guessed uuid and '
  'another person''s invitation produce the same refusal. Writes user_id and updated_at and '
  'nothing else. Permitted while globally pending -- the membership grants nothing until '
  'approval -- and refused for rejected and suspended accounts (053).';


-- 3c. No.
--
-- AUTHORIZATION IS IDENTICAL TO ACCEPT, WITH ONE DELIBERATE DIFFERENCE: a
-- rejected or suspended account MAY decline. Declining reduces access, and an
-- operation that only ever reduces access must never be the one that is blocked.

create or replace function public.decline_family_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  seat public.app_members%rowtype;
  family_name text;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select lower(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = caller
    and auth_user.email_confirmed_at is not null;

  if caller_email is null or caller_email = '' then
    raise exception 'Confirm your email address first' using errcode = '42501';
  end if;

  select * into seat
  from public.app_members m
  where m.id = p_invitation_id
    and m.user_id is null
    and m.active = true
    and m.declined_at is null
    and lower(m.email) = caller_email;

  if seat.id is null then
    raise exception 'That invitation is not yours.' using errcode = '42501';
  end if;

  select a.name into family_name from public.areas a where a.id = seat.area_id;

  -- `user_id` STAYS NULL. Declining is not a membership that was immediately
  -- removed; it is an offer that was never taken up.
  update public.app_members
  set active = false,
      declined_at = now(),
      updated_at = now()
  where id = seat.id;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_members', seat.id, 'removed', caller, null,
    format('Declined the invitation to %s', coalesce(family_name, 'the family')),
    null, null, null, '{}'::jsonb,
    seat.area_id, null, false
  );
end;
$$;

revoke all on function public.decline_family_invitation(uuid) from public, anon;
grant execute on function public.decline_family_invitation(uuid) to authenticated;

comment on function public.decline_family_invitation(uuid) is
  'Refuses ONE named invitation without joining, for the account whose own confirmed email '
  'address it is addressed to. Same single refusal sentence as accept. Leaves user_id null, '
  'so no membership exists at any point. Permitted for rejected and suspended accounts, '
  'because declining only ever reduces access (053).';


-- ---------------------------------------------------------------------------
-- 4. THE NARROW AUDIT BOUNDARY
--
-- The Family Access route needs to record that an invitation was issued and
-- whether the invitee can act on it. It does NOT get generic audit-writing
-- power, and it does not use the service role to do this: it calls this routine
-- with the ADMINISTRATOR'S OWN SESSION, and the routine authorises itself
-- exactly as `grant_area_access` does.
--
-- The caller supplies a person and one of two words. It does not supply the
-- Area, the table name, the action word, the summary or the actor -- all five
-- are chosen here, so a wrong Area is not expressible and a forged entry is not
-- constructible.
--
-- THE VOCABULARY IS BRANCH-BLIND, AND THAT IS THE WHOLE POINT.
--
--   `audit_log` is readable by EVERY MEMBER of a family, not only by its
--   administrator. A delivery record that said "email sent" in one branch and
--   "no email needed" in the other would be an account-existence oracle --
--   slower than the screen, more durable, and visible to more people. An admin
--   could seat a person, point an invitation at any address, and read the answer
--   out of the activity log a week later.
--
--     ready        the invitation is issued and the invitee can act on it.
--                  BOTH success branches produce this: an account already
--                  existed, OR the setup email was sent successfully.
--     undelivered  an email was needed and the send failed.
--
--   `ready` is the honest common outcome and the one the administrator actually
--   needs. The two branches produce byte-identical rows.
--
-- NEVER STORED HERE, OR ANYWHERE: the email address in any form INCLUDING ITS
-- DOMAIN, the message body, the setup or action URL, any token, any provider
-- key. The `record_id` is the seat, and the seat already carries the address for
-- the one person entitled to see it.
-- ---------------------------------------------------------------------------

create or replace function public.record_invitation_delivery(p_person_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_area uuid;
  seat public.app_members%rowtype;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  -- CLOSED VOCABULARY, CHECKED FIRST. Anything else is a caller trying to write
  -- its own sentence into a family's activity log.
  if p_outcome is null or p_outcome not in ('ready', 'undelivered') then
    raise exception 'That is not a delivery outcome we record' using errcode = '22023';
  end if;

  -- The Area comes from the PERSON, exactly as `grant_area_access` derives it,
  -- so a person in another family lands on `require_acting_area` and gets the
  -- same sentence whether or not the row exists.
  target_area := public.area_of_person(p_person_id);
  if target_area is null then
    raise exception 'No such person' using errcode = 'P0002';
  end if;

  perform public.require_acting_area(target_area);

  if not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can record an invitation'
      using errcode = '42501';
  end if;

  select * into seat
  from public.app_members m
  where m.person_id = p_person_id and m.area_id = target_area;

  -- ONLY AN OPEN INVITATION. Not a membership, not a revoked seat, not a
  -- declined one, and never the administrator's own -- so this cannot be used to
  -- narrate anything about a person who is already in the family.
  if seat.id is null
     or seat.user_id is not null
     or seat.active is not true
     or seat.declined_at is not null
     or seat.role = 'admin' then
    raise exception 'That family member has no open invitation' using errcode = 'P0002';
  end if;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details,
    area_id, celebrant_person_id, birthday_privacy_unknown
  ) values (
    'app_members', seat.id, 'added', caller, null,
    'Invitation delivery recorded',
    null, null, null,
    jsonb_build_object('outcome', p_outcome),
    target_area, null, false
  );
end;
$$;

revoke all on function public.record_invitation_delivery(uuid, text) from public, anon;
grant execute on function public.record_invitation_delivery(uuid, text) to authenticated;

comment on function public.record_invitation_delivery(uuid, text) is
  'Records ONE invitation-delivery event for ONE open invitation in the acting Area, called '
  'with the administrator''s own session and authorised exactly as grant_area_access is. The '
  'caller chooses neither the Area, the table, the action word, the summary nor the actor. '
  'The outcome vocabulary is branch-blind on purpose -- ready covers both success paths -- so '
  'the activity log cannot become an account-existence oracle. Stores no address, no domain, '
  'no link, no token (053).';


-- ---------------------------------------------------------------------------
-- 5. THE ADMINISTRATOR'S SIDE, TAUGHT ABOUT DECLINE
--
-- Two redefinitions, both minimal.
-- ---------------------------------------------------------------------------

-- 5a. `grant_area_access` -- 052's body, with `declined_at = null` added to the
--     two update branches and NOTHING ELSE CHANGED.
--
--     A decline answers one asking, not all of them. Inviting again clears it
--     and sets `active = true`, which restores an INVITATION -- the invitee must
--     Accept again, because `user_id` was never written. The reissue is audited:
--     `record_audit_event` reports the inactive-to-active crossing as
--     `restored`, Area-attributed by `stamp_audit_area` step 1.

create or replace function public.grant_area_access(p_person_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_area uuid;
  normalised text;
  seat public.app_members%rowtype;
  linked_email text;
begin
  if caller is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  -- The Area comes from the PERSON, never from the caller. A person in another
  -- family therefore lands on `require_acting_area` below, which answers the
  -- same sentence whether or not the row exists.
  target_area := public.area_of_person(p_person_id);
  if target_area is null then
    raise exception 'No such person' using errcode = 'P0002';
  end if;

  perform public.require_acting_area(target_area);

  if not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can give access'
      using errcode = '42501';
  end if;

  normalised := lower(btrim(coalesce(p_email, '')));
  if normalised = '' then
    raise exception 'An email address is needed' using errcode = '22023';
  end if;
  -- The same shape `app_members_email_safe_check` enforces, checked here so the
  -- refusal is a sentence rather than a constraint name.
  if length(normalised) < 3
     or length(normalised) > 254
     or normalised ~ '[[:space:][:cntrl:]]'
     or normalised !~ '^[^@]+@[^@]+\.[^@]+$' then
    raise exception 'That is not an email address we can invite' using errcode = '22023';
  end if;

  select * into seat
  from public.app_members m
  where m.person_id = p_person_id and m.area_id = target_area;

  -- THE ADMINISTRATOR'S OWN SEAT IS NOT EDITABLE HERE, BY ANYBODY INCLUDING
  -- THEMSELVES. Administration moves through `transfer_area_admin` and departs
  -- through `leave_area`; both keep the "exactly one active administrator"
  -- invariant that this routine has no idea about.
  if seat.id is not null and seat.role = 'admin' then
    raise exception 'The family administrator''s access is changed by handing over the family, not here'
      using errcode = '42501';
  end if;

  -- The unique index on (area_id, lower(email)) would refuse this anyway; said
  -- out loud so the caller learns why rather than reading a constraint name.
  if exists (
    select 1 from public.app_members m
    where m.area_id = target_area
      and lower(m.email) = normalised
      and (seat.id is null or m.id <> seat.id)
  ) then
    raise exception 'Somebody else in this family already uses that email address'
      using errcode = '23505';
  end if;

  if seat.id is null then
    -- A SEAT NOBODY HAS SAT IN YET. `user_id` is left null on purpose and is
    -- not in the column list at all.
    insert into public.app_members (area_id, person_id, email, role, active)
    values (target_area, p_person_id, normalised, 'member', true);
    return;
  end if;

  if seat.user_id is null then
    -- STILL AN INVITATION -- possibly a declined or a revoked one. Re-addressing
    -- it is the whole point: a mistyped address is fixed here, and nothing is
    -- attached to a login yet.
    --
    -- MIGRATION 053: `declined_at = null`. This is a REISSUE, not a revival of
    -- consent. The row goes back to being an open invitation and the invitee
    -- must accept it; there is no path from here to a membership that does not
    -- go through `accept_family_invitation`.
    update public.app_members
    set email = normalised, active = true, declined_at = null, updated_at = now()
    where id = seat.id;
    return;
  end if;

  -- FROM HERE THE SEAT IS CLAIMED, AND `user_id` IS THE IDENTITY -- not the
  -- email column beside it, which is a cache of what the address was when the
  -- claim happened and may be years stale.
  select lower(u.email) into linked_email
  from auth.users u
  where u.id = seat.user_id
    and u.email_confirmed_at is not null;

  if linked_email is null then
    raise exception 'The account holding this seat has no confirmed email address'
      using errcode = '42501';
  end if;

  if linked_email <> normalised then
    -- REFUSED, NOT TRANSFERRED. Moving a claimed seat to a different address
    -- would move a family membership to a different person on an
    -- administrator's say-so. Revoke with p_unlink, and let the new address
    -- claim the empty seat itself.
    raise exception 'That seat already belongs to a different account. Remove its access first.'
      using errcode = '42501';
  end if;

  -- The address matches the live, confirmed one: restore the seat, and heal the
  -- cached column if the account has since changed address. `declined_at` is
  -- already null here by the CHECK constraint -- a claimed row cannot carry one
  -- -- and is written anyway so the statement states its end state rather than
  -- assuming it.
  update public.app_members
  set email = normalised, active = true, declined_at = null, updated_at = now()
  where id = seat.id;
end;
$$;

revoke all on function public.grant_area_access(uuid, text) from public, anon;
grant execute on function public.grant_area_access(uuid, text) to authenticated;

comment on function public.grant_area_access(uuid, text) is
  'Invites or restores one family member''s access, in the acting Area only, as that Area''s '
  'administrator. NEVER writes user_id: only accept_family_invitation attaches a login. '
  'Clears declined_at, so inviting again after a decline restores an INVITATION and never a '
  'membership. Refuses the administrator''s own seat and any email that belongs to a '
  'different account (053).';


-- 5b. `list_area_access` -- 052's body plus ONE column, `declined_at`, so the
--     screen can tell `Declined` from `Revoked`.
--
--     ENUMERATION RESISTANCE IS UNCHANGED AND MUST STAY THAT WAY. For an
--     unclaimed seat, `account_status` and `email_confirmed` are both null
--     WHETHER OR NOT an account exists for its address, because both are reached
--     only through `m.user_id`. The new column is null-or-a-timestamp and is a
--     fact about what the INVITEE DID, never about what they have. There is no
--     column in this result that varies with account existence for an unclaimed
--     seat, and there must never be one.
--
--     DROPPED AND RECREATED, not replaced: `create or replace` cannot change a
--     function's return type, and this one gains a column. Nothing depends on
--     it -- no view, no policy, no other routine -- so the drop is not
--     cascading anything, and the grants below are reissued explicitly because
--     a drop takes them with it.

drop function if exists public.list_area_access();

create or replace function public.list_area_access()
returns table (
  person_id uuid,
  person_name text,
  app_member_id uuid,
  email text,
  role text,
  active boolean,
  claimed boolean,
  account_status text,
  email_confirmed boolean,
  declined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  acting uuid := public.acting_area();
begin
  -- NO AREA PARAMETER, ON PURPOSE. A routine that took one would be a routine an
  -- administrator of one family could point at another; the acting Area is
  -- already checked by the hook that set it.
  if acting is null then
    raise exception 'Say which family you are working in.' using errcode = '42501';
  end if;

  if not public.is_area_admin(acting) then
    raise exception 'Only this family''s administrator can see who has access'
      using errcode = '42501';
  end if;

  -- auth.users and app_accounts are joined ONLY through a membership row that is
  -- already in this Area, so there is no way to reach an account this family has
  -- nothing to do with, and no way to ask about an address at all.
  return query
    select
      p.id,
      p.name,
      m.id,
      m.email,
      m.role,
      coalesce(m.active, false),
      (m.user_id is not null),
      case when m.user_id is null then null else coalesce(a.status, 'pending')::text end,
      case when m.user_id is null then null else (u.email_confirmed_at is not null) end,
      m.declined_at
    from public.people p
    left join public.app_members m on m.person_id = p.id and m.area_id = acting
    left join auth.users u on u.id = m.user_id
    left join public.app_accounts a on a.user_id = m.user_id
    where p.area_id = acting
    order by p.name, p.id;
end;
$$;

revoke all on function public.list_area_access() from public, anon;
grant execute on function public.list_area_access() to authenticated;

comment on function public.list_area_access() is
  'Who can reach the ACTING Area, for that Area''s administrator only. No Area parameter and '
  'no email parameter, so it cannot be pointed at another family or used to probe whether an '
  'address has an account. For an UNCLAIMED seat every account-shaped column is null whether '
  'or not an account exists for its address; declined_at reports what the invitee did, never '
  'what they have (053).';


-- ---------------------------------------------------------------------------
-- 6. THE AUTO-JOIN, RETIRED
--
-- Retired in behaviour, retained in name. The body IS the auto-join -- there is
-- nothing in it to narrow, because narrowing it to "claim only the invitation
-- you name" would BE `accept_family_invitation`, and keeping both would be two
-- names for one thing and two places to get the barrier exemption wrong.
--
-- `language sql` and `immutable`, so PostgreSQL folds it away entirely. Every
-- existing caller already treats `false` as the ordinary case -- "nothing was
-- waiting on this address" -- so the pre-053 runtime keeps working through the
-- upgrade and simply stops joining anybody. The EXECUTE grant stays for the same
-- reason: an in-flight browser session must not start erroring mid-deploy.
--
-- It is dropped in a later migration once no caller remains.
--
-- AFTER THIS POINT there is no code path anywhere in which confirming an email
-- address, or signing in, changes any row of `app_members`. That is the whole
-- product requirement, in one sentence, and it is enforced by the ABSENCE of an
-- UPDATE rather than by a condition on one.
-- ---------------------------------------------------------------------------

create or replace function public.claim_app_member()
returns boolean
language sql
immutable
set search_path = ''
as $$ select false $$;

revoke all on function public.claim_app_member() from public, anon;
grant execute on function public.claim_app_member() to authenticated;

comment on function public.claim_app_member() is
  'RETIRED BY MIGRATION 053, and kept only so a pre-053 runtime does not error mid-deploy. '
  'Always returns false and touches nothing. Joining a family goes through '
  'accept_family_invitation, which requires the invitee to say yes. Dropped once no caller '
  'remains (053).';


-- ---------------------------------------------------------------------------
-- 7. END STATE
--
-- Says out loud what is now true, and refuses to finish if it is not.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  fn_oid oid;
  declined_rows integer;
begin
  -- The column, the constraint, the index.
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.app_members'::regclass
      and attname = 'declined_at' and not attisdropped
  ) then
    problems := problems || 'app_members.declined_at was not added'::text;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_members'::regclass
      and conname = 'app_members_declined_is_unclaimed'
  ) then
    problems := problems || 'app_members_declined_is_unclaimed is missing'::text;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'app_members_open_invitation_idx'
  ) then
    problems := problems || 'app_members_open_invitation_idx is missing'::text;
  end if;

  -- The four new routines exist, are SECURITY DEFINER, pin `search_path`, and
  -- are not reachable by `anon`. A definer routine with an unpinned search_path
  -- is the classic privilege-escalation shape and there must not be one here.
  foreach fn in array array[
    'list_my_family_invitations', 'accept_family_invitation',
    'decline_family_invitation', 'record_invitation_delivery'
  ] loop
    select oid into fn_oid from pg_proc
    where proname = fn and pronamespace = 'public'::regnamespace;

    if fn_oid is null then
      problems := problems || format('%s is missing', fn);
      continue;
    end if;

    if not (select prosecdef from pg_proc where oid = fn_oid) then
      problems := problems || format('%s is not SECURITY DEFINER', fn);
    end if;

    if not exists (
      select 1 from pg_proc
      where oid = fn_oid and 'search_path=""' = any(coalesce(proconfig, array[]::text[]))
    ) then
      problems := problems || format('%s does not pin search_path to the empty string', fn);
    end if;

    if has_function_privilege('anon', fn_oid, 'execute') then
      problems := problems || format('anon can execute %s', fn);
    end if;

    if not has_function_privilege('authenticated', fn_oid, 'execute') then
      problems := problems || format('authenticated cannot execute %s', fn);
    end if;
  end loop;

  -- NOT ONE of the three invitee routines may take an email address or a user
  -- id. Their only parameter is an invitation id, or nothing at all -- those are
  -- the parameter shapes that cannot be pointed at somebody else.
  if exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in (
        'list_my_family_invitations', 'accept_family_invitation',
        'decline_family_invitation')
      and pg_get_function_identity_arguments(oid) not in ('', 'p_invitation_id uuid')
  ) then
    problems := problems || 'an invitee routine takes a parameter other than one invitation id'::text;
  end if;

  -- The auto-join is gone in fact, not merely in intent.
  if (select public.claim_app_member()) is distinct from false then
    problems := problems || 'claim_app_member did not return false'::text;
  end if;

  if exists (
    select 1 from pg_proc
    where proname = 'claim_app_member' and pronamespace = 'public'::regnamespace
      and lower(pg_get_functiondef(oid)) like '%update %'
  ) then
    problems := problems || 'claim_app_member still contains an UPDATE'::text;
  end if;

  -- The barrier carries the decline exemption.
  if not exists (
    select 1 from pg_proc
    where proname = 'refuse_foreign_area_write' and pronamespace = 'public'::regnamespace
      and pg_get_functiondef(oid) like '%declined_at%'
  ) then
    problems := problems || 'refuse_foreign_area_write did not learn the decline branch'::text;
  end if;

  -- The administrator's routines.
  if not exists (
    select 1 from pg_proc
    where proname = 'grant_area_access' and pronamespace = 'public'::regnamespace
      and pg_get_functiondef(oid) like '%declined_at = null%'
  ) then
    problems := problems || 'grant_area_access does not clear declined_at'::text;
  end if;

  if not exists (
    select 1 from pg_proc
    where proname = 'list_area_access' and pronamespace = 'public'::regnamespace
      and pg_get_function_result(oid) like '%declined_at%'
  ) then
    problems := problems || 'list_area_access does not return declined_at'::text;
  end if;

  -- NO BACKFILL HAPPENED, and none should have.
  select count(*) into declined_rows
  from public.app_members where declined_at is not null;
  if declined_rows <> 0 then
    problems := problems || format('%s rows already carry declined_at -- 053 writes none', declined_rows);
  end if;

  -- No new policy on app_members: the two 052 left behind, and no third.
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'app_members') <> 2 then
    problems := problems || 'app_members no longer has exactly its two 052 policies'::text;
  end if;

  if array_length(problems, 1) > 0 then
    raise exception 'Migration 053 end state failed: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Migration 053 complete: invitations are answered, never assumed.';
end $$;
