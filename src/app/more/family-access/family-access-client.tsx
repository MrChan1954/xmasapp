"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import {
  AREA_ACCESS_EXPLANATIONS,
  AREA_ACCESS_LABELS,
  areaAccessStatus,
  canGrantAccess,
  canReissueInvitation,
  canRevokeAccess,
  isAdminSeat,
  type AreaAccessRow,
  type AreaAccessStatus,
} from "@/lib/family-access";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { IconSearch, IconShield } from "../../components/icons";
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  EmptyState,
  Field,
  FilterChip,
  Input,
  Modal,
  ModalHeader,
  Notice,
  Skeleton,
  ToggleChip,
  cx,
  type BadgeTone,
} from "../../components/ui";
import { useRealtimeRefresh } from "../../components/use-realtime-refresh";

/**
 * WHO CAN OPEN THIS FAMILY.
 *
 * ==========================================================================
 *  EVERY READ AND EVERY ACCESS WRITE ON THIS SCREEN IS AN RPC NOW.
 * ==========================================================================
 *
 * This screen used to fetch `/api/admin/family-access`, which used the SERVICE
 * ROLE to read every person, every membership and EVERY AUTH ACCOUNT IN THE
 * PROJECT -- up to a hundred pages of them -- to answer a question about one
 * family. Migration 052 replaced that with three routines that authorise
 * themselves:
 *
 *   list_area_access()                 no Area parameter and no email
 *                                      parameter, so it cannot be pointed at
 *                                      another family and cannot be used to
 *                                      probe whether an address has an account.
 *   grant_area_access(person, email)   creates or restores an invitation, and
 *                                      NEVER writes `user_id`.
 *   revoke_area_access(person, unlink) keeps the seat unless explicitly told to
 *                                      empty it.
 *
 * WHY `grant_area_access` NOT WRITING `user_id` IS THE IMPORTANT ONE. Attaching
 * a login to an invitation is `accept_family_invitation`'s job and nothing
 * else's, because only the invitee can prove which login is theirs and only
 * they can consent. An administrator who could write `user_id` could hand any
 * family seat to any account.
 *
 * WHAT STILL GOES THROUGH THE SERVER ROUTE is what the Supabase Admin API is
 * the only way to do -- talk to Auth. No SQL routine sends an email or mints a
 * link.
 *
 * `awaiting_global_approval` is somebody who HAS claimed their seat and whose
 * Gift Planner account has not been approved. The family administrator can do
 * nothing about it, and this screen says so plainly -- otherwise they resend
 * the invitation, change the address, and eventually ask the person to sign up
 * again, none of which can possibly help.
 *
 * ==========================================================================
 *  INVITING IS ONE PRESS, AND THE SCREEN IS NOT TOLD WHAT HAPPENED (053).
 * ==========================================================================
 *
 * It used to be two. `grant_area_access` from here, then a SECOND button --
 * "Send invitation" -- offered only on a seat this screen had labelled
 * "Awaiting sign-up", which is a label that exists to say the address has no
 * account. The two-step was an account-existence oracle with a state machine
 * around it.
 *
 * Now: type the address, press once, read `Invitation created.` The browser
 * posts to `/api/admin/family-access`, which creates the invitation and does
 * whatever that address needs behind a trusted boundary -- an account-setup
 * email if there is no account, and NOTHING AT ALL if there is one, because
 * that person will be offered the invitation inside the app. The response is
 * the same sentence, the same status and the same two fields either way, and
 * this file could not tell the branches apart if it tried.
 *
 * SO THE GRANT LEFT THE BROWSER, and only the grant. Reading, revoking and the
 * contributor pool are still RPCs called through the caller's own session,
 * because none of them needs anything the browser must not have. The invitation
 * does: it needs to talk to Auth, and it needs the answer thrown away.
 */

type PersonFlags = { isFamilyContributor: boolean };

type Row = AreaAccessRow & PersonFlags;

type Filter = "all" | AreaAccessStatus;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "no_access", label: AREA_ACCESS_LABELS.no_access },
  { value: "invited", label: AREA_ACCESS_LABELS.invited },
  { value: "awaiting_global_approval", label: "Waiting for approval" },
  { value: "active", label: AREA_ACCESS_LABELS.active },
  { value: "declined", label: AREA_ACCESS_LABELS.declined },
  { value: "revoked", label: AREA_ACCESS_LABELS.revoked },
];

const STATUS_TONES: Record<AreaAccessStatus, BadgeTone> = {
  no_access: "neutral",
  invited: "warning",
  awaiting_global_approval: "gold",
  active: "success",
  declined: "danger",
  revoked: "danger",
};

type DialogState =
  | { kind: "invite"; row: Row }
  | { kind: "revoke"; row: Row }
  | { kind: "unlink"; row: Row }
  | null;

export function FamilyAccessClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const db = createClient();
      const access = await db.rpc("list_area_access");
      if (access.error) {
        /*
         * 42501 is the routine refusing somebody who is not this family's
         * administrator -- or who has not said which family they are in. It is
         * the same refusal for both, deliberately: telling them apart would let
         * somebody probe which families an account belongs to.
         */
        if (access.error.code === "42501") { setForbidden(true); setRows([]); return; }
        setError(describeSupabaseError(access.error, "Family access could not be loaded."));
        return;
      }

      const list = (access.data ?? []) as AreaAccessRow[];

      /*
       * THE CONTRIBUTOR FLAG, READ SEPARATELY AND SCOPED BY THE LIST ITSELF.
       *
       * `list_area_access` answers about ACCESS and carries no contributor
       * eligibility, which belongs to the person rather than to their login.
       * The ids come from the list the routine just returned, so this read is
       * confined to the acting Area by construction -- there is no Area filter
       * to get wrong and no way to widen it from the browser. `people` is
       * behind `is_area_member` either way.
       */
      const ids = list.map((row) => row.person_id);
      const people = ids.length
        ? await db.from("people").select("id,is_family_contributor").in("id", ids)
        : { data: [], error: null };
      const contributors = new Map(
        ((people.data ?? []) as Array<{ id: string; is_family_contributor: boolean }>)
          .map((row) => [row.id, Boolean(row.is_family_contributor)]),
      );

      setForbidden(false);
      setError(null);
      setRows(list.map((row) => ({ ...row, isFamilyContributor: contributors.get(row.person_id) ?? false })));
    } catch (thrown) {
      setError(describeThrown(thrown, "Family access could not be loaded. Check your connection and try again."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // This screen is family-global, so it watches the two family-global tables it
  // shows. `app_members` is new here: access is now changed by an RPC rather
  // than by a route this screen calls, so a second administrator's grant would
  // otherwise not appear until a manual refresh.
  useRealtimeRefresh(["people", "app_members"], () => load(true), { enabled: !forbidden });

  const counts = useMemo(() => {
    const result: Record<Filter, number> = {
      all: rows.length,
      no_access: 0,
      invited: 0,
      awaiting_global_approval: 0,
      active: 0,
      declined: 0,
      revoked: 0,
    };
    for (const row of rows) result[areaAccessStatus(row)] += 1;
    return result;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesFilter = filter === "all" || areaAccessStatus(row) === filter;
      const matchesQuery =
        !needle ||
        row.person_name.toLowerCase().includes(needle) ||
        (row.email ?? "").toLowerCase().includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, rows]);

  const closeDialog = () => setDialog(null);

  /**
   * ONE PRESS. THE BROWSER LEARNS NOTHING ABOUT THE ADDRESS IT JUST SENT.
   *
   * The server creates the invitation with `grant_area_access` -- through the
   * administrator's own session, so the database still decides -- and then does
   * whatever that address needs without saying which. The notice below is
   * whatever the server sent, and the server sends one sentence for both
   * branches on purpose. Nothing here inspects it, and nothing here should
   * start to.
   */
  const invite = async (row: Row, email: string) => {
    setBusy(`invite:${row.person_id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/family-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invite", personId: row.person_id, email }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (!response.ok) {
        setError(payload?.error ?? "That invitation could not be created.");
        await load(true);
        return false;
      }
      setNotice(payload?.message ?? "Invitation created.");
      closeDialog();
      await load(true);
      return true;
    } catch (thrown) {
      setError(describeThrown(thrown, "That invitation could not be created. Check your connection and try again."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** `revoke_area_access` — `unlink` empties the seat, and only when asked. */
  const revokeAccess = async (row: Row, unlink: boolean) => {
    setBusy(`revoke:${row.person_id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await createClient().rpc("revoke_area_access", {
        p_person_id: row.person_id,
        p_unlink: unlink,
      });
      if (result.error) {
        setError(describeSupabaseError(result.error, "That access could not be taken away."));
        return;
      }
      setNotice(unlink
        ? `${row.person_name}’s seat is empty again and can be invited to a different address.`
        : `${row.person_name}’s access is switched off.`);
      closeDialog();
      await load(true);
    } catch (thrown) {
      setError(describeThrown(thrown, "That access could not be taken away. Check your connection and try again."));
    } finally {
      setBusy(null);
    }
  };

  /**
   * The one link the Admin API still mints, for a seat that ALREADY has a login
   * on it. There is no setup link any more: `generateLink({ type: "invite" })`
   * is refused by GoTrue for an address that already has an account, so it
   * answered with a link for a stranger and an error for a member — an
   * account-existence oracle wearing a convenience feature's clothes.
   */
  const copyResetLink = async (row: Row) => {
    setBusy(`copy-reset-link:${row.person_id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/family-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "copy-reset-link", personId: row.person_id }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; link?: string; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "That Family Access change could not be saved.");
      }
      if (!payload?.link) throw new Error("Supabase did not return a link.");
      await copySensitiveLink(payload.link);
      setNotice(payload?.message ?? "Done.");
    } catch (thrown) {
      setError(describeThrown(thrown, "That Family Access change could not be saved."));
    } finally {
      setBusy(null);
    }
  };

  /** Somebody with no seat at all is who "Give access" can be offered for. */
  const grantable = useMemo(() => rows.filter((row) => canGrantAccess(row)), [rows]);

  if (loading) {
    return (
      <div role="status">
        <p className="text-sm font-medium text-ink-600">Checking Family Access permission…</p>
        <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading family access">
          {[0, 1, 2, 3, 4, 5].map((item) => <AccountSkeleton key={item} />)}
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <EmptyState
        className="mx-auto mt-10 max-w-xl"
        illustration="wreath"
        title="Family admin only"
        body="Your account can use the app, but only this family’s admin can manage who else gets in."
        action={<ButtonLink href="/" size="lg">Back to Events</ButtonLink>}
      />
    );
  }

  return (
    <div>
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-eyebrow text-gold uppercase">
            <IconShield size={16} className="text-gold" />
            Family admin
          </div>
          <h1 className="mt-2 font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.08] font-semibold tracking-tight">Family Access</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-600">
            Who can open this family, and with what role. This is the whole family, not one
            event. To choose who receives or who chips in for a particular event, open that
            event and use its settings.
          </p>
        </div>
      </header>

      {/*
        THE ONE THING A FAMILY ADMINISTRATOR CANNOT DO, said once at the top so
        it is read before anybody starts chasing a "waiting" badge.
      */}
      {counts.awaiting_global_approval > 0 && (
        <Notice tone="warning" className="mt-6">
          {counts.awaiting_global_approval === 1 ? "One person is" : `${counts.awaiting_global_approval} people are`}
          {" "}waiting for Gift Planner approval. Their access here is ready; only a Gift Planner
          administrator can approve the account itself, and nothing you do on this screen will
          speed it up.
        </Notice>
      )}

      <ContributorPool
        rows={rows}
        busy={busy !== null}
        onError={setError}
        onChanged={() => void load(true)}
      />

      <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Access summary">
        <Summary label="Family" value={counts.all} />
        <Summary label="Active" value={counts.active} accent />
        <Summary label="Invitation pending" value={counts.invited} />
        <Summary label="Waiting for approval" value={counts.awaiting_global_approval} />
      </section>

      <div className="mt-7 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <label className="relative block w-full xl:max-w-sm">
          <span className="sr-only">Search family access</span>
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400"><IconSearch size={18} /></span>
          <Input
            type="search"
            maxLength={INPUT_LIMITS.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or email"
            className="pl-10 text-sm"
          />
        </label>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Filter access">
          {FILTERS.map((item) => (
            <FilterChip
              key={item.value}
              active={filter === item.value}
              count={counts[item.value]}
              onClick={() => setFilter(item.value)}
              className="px-4 text-xs"
            >
              {item.label}
            </FilterChip>
          ))}
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true">
        {notice && <Notice tone="success" className="mt-5" onDismiss={() => setNotice(null)}>{notice}</Notice>}
        {error && <Notice tone="danger" className="mt-5" onDismiss={() => setError(null)}>{error}</Notice>}
      </div>

      {visible.length === 0 ? (
        <div className="mt-7 rounded-2xl border border-dashed border-line-strong bg-surface-2 px-5 py-12 text-center">
          <h2 className="font-display text-lg font-semibold">No matching people</h2>
          <p className="mt-2 text-sm text-ink-600">Try a different name or access filter.</p>
        </div>
      ) : (
        <div className="mt-7 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((row) => (
            <AccessCard
              key={row.person_id}
              row={row}
              busy={busy}
              onInvite={() => setDialog({ kind: "invite", row })}
              onRevoke={() => setDialog({ kind: "revoke", row })}
              onUnlink={() => setDialog({ kind: "unlink", row })}
              onCopyResetLink={() => void copyResetLink(row)}
            />
          ))}
        </div>
      )}

      {dialog?.kind === "invite" && (
        <InviteDialog
          row={dialog.row}
          busy={busy !== null}
          onClose={closeDialog}
          onInvite={(email) => invite(dialog.row, email)}
        />
      )}

      {dialog?.kind === "revoke" && (
        <ConfirmDialog
          title={`Switch off ${dialog.row.person_name}’s access?`}
          body="They stop being able to open this family straight away. Nothing they have planned or paid for is deleted, and their seat is kept — giving access back restores the same person rather than opening it to whoever asks."
          confirmLabel="Switch off access"
          busyLabel="Saving…"
          busy={busy !== null}
          onCancel={closeDialog}
          onConfirm={() => void revokeAccess(dialog.row, false)}
        />
      )}

      {dialog?.kind === "unlink" && (
        <ConfirmDialog
          title={`Empty ${dialog.row.person_name}’s seat?`}
          body={
            <>
              <p>
                This does two things. Their access is switched off, and the login attached to
                it is detached — so the seat becomes an empty chair that a DIFFERENT address
                can be invited to.
              </p>
              <p className="mt-3">
                It cannot be undone by giving access back: the next person to confirm the
                address you invite takes the seat. Use it when somebody’s address has changed
                or the wrong person was invited, and use “Switch off access” for everything
                else.
              </p>
            </>
          }
          confirmLabel="Empty the seat"
          busyLabel="Saving…"
          busy={busy !== null}
          onCancel={closeDialog}
          onConfirm={() => void revokeAccess(dialog.row, true)}
        />
      )}

      {grantable.length === 0 && rows.length > 0 && (
        <p className="mt-7 text-sm text-ink-600">Everybody in this family already has access.</p>
      )}
    </div>
  );
}

/**
 * Who may be asked to chip in.
 *
 * WHY THIS IS NOT "EVERYONE IN THE FAMILY"
 *   Nineteen people are in this family and four share the cost of gifts. A
 *   contributor selector that offers all nineteen makes the common case tedious
 *   and the mistake easy — and there was no way to express "no, not them"
 *   except by remembering every single time.
 *
 * WHAT REMOVING SOMEBODY DOES
 *   Stops them being OFFERED for new assignments. It rewrites no plan, no
 *   allocation and no payment: money already assigned stays assigned until the
 *   administrator edits that event on purpose. `set_family_contributor` writes
 *   one boolean and nothing else, and checks the Area's administrator itself —
 *   so hiding this section is a courtesy, not the boundary.
 *
 * IT IS ABOUT THE PERSON, NOT THEIR LOGIN. Somebody with no account at all can
 * be a contributor; somebody with access may not be. That is why it is a
 * separate section rather than another button on the cards below.
 */
function ContributorPool({
  rows,
  busy,
  onError,
  onChanged,
}: {
  rows: Row[];
  busy: boolean;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const eligible = rows.filter((row) => row.isFamilyContributor);

  const toggle = async (row: Row) => {
    onError(null);
    setSaving(row.person_id);
    try {
      const result = await createClient().rpc("set_family_contributor", {
        p_person_id: row.person_id,
        p_eligible: !row.isFamilyContributor,
      });
      if (result.error) {
        onError(describeSupabaseError(result.error, "That change could not be saved."));
        return;
      }
      onChanged();
    } catch (thrown) {
      onError(describeThrown(thrown, "That change could not be saved. Check your connection and try again."));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Contributors</h2>
      <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
        <p className="text-sm leading-6 text-ink-600">
          Who can be asked to share the cost of a gift. Everyone else stays a family member —
          they can still receive gifts and have a birthday — but they are not offered when
          planning who pays. Removing somebody here changes nothing already planned or paid.
        </p>
        <p className="mt-2 text-xs font-semibold text-ink-600">
          {eligible.length} of {rows.length} {rows.length === 1 ? "person" : "people"}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {rows.map((row) => {
            const on = row.isFamilyContributor;
            return (
              <ToggleChip
                key={row.person_id}
                on={on}
                disabled={busy || saving !== null}
                onClick={() => void toggle(row)}
              >
                {row.person_name}{on ? " ✓" : ""}
              </ToggleChip>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AccessCard({
  row,
  busy,
  onInvite,
  onRevoke,
  onUnlink,
  onCopyResetLink,
}: {
  row: Row;
  busy: string | null;
  onInvite: () => void;
  onRevoke: () => void;
  onUnlink: () => void;
  onCopyResetLink: () => void;
}) {
  const status = areaAccessStatus(row);
  const working = busy?.endsWith(`:${row.person_id}`) ?? false;
  const admin = isAdminSeat(row);

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className={cx(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl font-display text-base font-semibold",
            admin ? "bg-pine-800 text-gold-fill" : "bg-accent-soft text-accent",
          )}>
            {initials(row.person_name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="truncate font-display text-lg font-semibold">{row.person_name}</h2>
              <Badge tone={STATUS_TONES[status]}>{AREA_ACCESS_LABELS[status]}</Badge>
            </div>
            <p className="mt-1 text-xs font-semibold text-ink-600">
              {admin ? "Admin of this family" : row.app_member_id ? "Member" : "No account"}
            </p>
            {/* THE PERSON BEHIND THE ACCOUNT.
                This screen is about LOGINS; the profile is about the person --
                their name, their birthday, whether they chip in, and everything
                ever bought for them. They are two views of one human being and
                each should be one tap from the other. */}
            <a
              href={`/people/${row.person_id}`}
              className="mt-1 inline-block text-xs font-semibold text-accent hover:underline"
            >
              Open {row.person_name}&rsquo;s profile →
            </a>
          </div>
        </div>

        <div className="mt-5 min-h-11 rounded-xl bg-surface-2 px-3 py-2.5">
          <p className="text-xs font-medium text-ink-600">Login email</p>
          <p className={cx("mt-0.5 break-all text-sm", row.email ? "font-semibold text-ink-900" : "text-ink-400")}>
            {row.email ?? "Not added yet"}
          </p>
        </div>

        <p className="mt-3 text-xs leading-5 text-ink-600">{AREA_ACCESS_EXPLANATIONS[status]}</p>

        <div className="mt-5">
          {admin ? (
            <div className="flex min-h-11 items-center gap-2 rounded-xl bg-accent-soft px-3 text-xs leading-5 font-medium text-accent">
              <IconShield size={17} className="shrink-0 text-accent" />
              This family’s admin is protected. Hand the family over to change who runs it.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {/* ONE BUTTON, AND ITS LABEL IS NEUTRAL BY CONSTRUCTION.
                  "Resend the email" would be a guess about which branch this
                  invitation took, made on a screen that is not allowed to know.
                  It asks once more; the server decides what "again" means for
                  that address, and does not say. */}
              {(canGrantAccess(row) || canReissueInvitation(row)) && (
                <ActionButton
                  disabled={working}
                  onClick={onInvite}
                  primary={canGrantAccess(row)}
                >
                  {status === "no_access"
                    ? "Give access"
                    : status === "revoked"
                      ? "Give access back"
                      : "Invite again"}
                </ActionButton>
              )}

              {status === "active" && (
                <ActionButton disabled={working} onClick={onCopyResetLink}>Copy reset link</ActionButton>
              )}

              {canRevokeAccess(row) && (
                <ActionButton disabled={working} onClick={onRevoke} danger>Remove access</ActionButton>
              )}

              {/* THE ONLY UNLINK PATH THERE IS, AND IT IS EXPLICIT. Offered
                  only once access is already off, so it can never be the
                  accidental result of meaning to switch somebody off. */}
              {status === "revoked" && row.claimed === true && (
                <ActionButton disabled={working} onClick={onUnlink} danger>Empty the seat</ActionButton>
              )}
            </div>
          )}

          {working && <p role="status" className="mt-3 text-center text-xs font-medium text-ink-600">Saving change…</p>}
        </div>
      </div>
    </article>
  );
}

/**
 * TYPE THE ADDRESS, PRESS ONCE.
 *
 * THE HINT IS THE CAREFUL PART. It used to say "If they have not signed up yet,
 * the invitation waits for them" -- which invites the administrator to wonder
 * which of those this is, and the old screen then told them. This one describes
 * what is true of BOTH branches and offers no way to find out which: an
 * invitation is made, the person is asked, and the answer is theirs.
 */
function InviteDialog({
  row,
  busy,
  onClose,
  onInvite,
}: {
  row: Row;
  busy: boolean;
  onClose: () => void;
  onInvite: (email: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState(row.email ?? "");
  const [validation, setValidation] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = validateEmail(email);
    if (!normalized.ok) { setValidation(normalized.error); return; }
    setValidation(null);
    await onInvite(normalized.value);
  };

  return (
    <Modal labelledBy="family-access-dialog-title" onClose={onClose} size="md" surface="white" dismissible={!busy}>
      <ModalHeader
        id="family-access-dialog-title"
        title={`Invite ${row.person_name}`}
        description="They are asked whether they want to join this family, and they answer for themselves. Nobody is added until they accept."
        onClose={onClose}
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-7">
        <form onSubmit={(event) => void submit(event)}>
          <Field
            label="Email address"
            required
            error={validation}
            hint="Gift Planner sends them whatever this address needs, and does not report back which. Use the address they will sign in with."
          >
            <Input
              autoFocus
              required
              type="email"
              autoComplete="off"
              maxLength={INPUT_LIMITS.email}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </Field>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" size="lg" disabled={busy}>{busy ? "Saving…" : "Invite"}</Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function Summary({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={cx("rounded-2xl border p-4 shadow-card sm:p-5", accent ? "border-accent-soft-border bg-accent-soft" : "border-line bg-surface")}>
      <p className={cx("font-display text-2xl font-semibold tabular-nums sm:text-3xl", accent && "text-accent")}>{value}</p>
      <p className="mt-1 text-xs font-medium text-ink-600 sm:text-sm">{label}</p>
    </div>
  );
}

function ActionButton({ children, disabled, onClick, primary = false, danger = false }: { children: React.ReactNode; disabled: boolean; onClick: () => void; primary?: boolean; danger?: boolean }) {
  return (
    <Button
      variant={primary ? "tonal" : danger ? "dangerGhost" : "secondary"}
      size="md"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "border px-2 text-xs leading-4 disabled:cursor-wait",
        primary
          ? "border-accent-soft-border"
          : danger
            ? "border-berry-soft-border bg-surface"
            : "",
      )}
    >
      {children}
    </Button>
  );
}

function AccountSkeleton() {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <div className="flex gap-3"><Skeleton className="h-12 w-12 rounded-2xl" /><div className="flex-1"><Skeleton className="h-4 w-28" /><Skeleton className="mt-3 h-3 w-16" /></div></div>
      <Skeleton className="mt-6 h-14" />
      <Skeleton className="mt-5 h-11" />
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

async function copySensitiveLink(link: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(link);
      return;
    } catch {
      // HTTP LAN development is not always a secure Clipboard API context.
    }
  }

  const input = document.createElement("textarea");
  input.value = link;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(input);
  if (!copied) throw new Error("The link was created, but your browser could not copy it. Try again from a secure browser window.");
}
