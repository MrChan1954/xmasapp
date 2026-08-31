"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { signOut } from "@/utils/supabase/sign-out";
import { IconSearch, IconShield } from "../../components/icons";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  FilterChip,
  Input,
  Notice,
  Skeleton,
  Textarea,
  cx,
  type BadgeTone,
} from "../../components/ui";

/**
 * WHO MAY USE GIFT PLANNER, DECIDED HERE AND NOWHERE ELSE.
 *
 * EVERY READ AND EVERY WRITE ON THIS SCREEN IS AN RPC. `app_accounts` holds no
 * privilege for `anon` or `authenticated` and has zero policies, so
 * `db.from("app_accounts")` is not a thing that can be written -- it would fail
 * from a browser whatever this file said. The four routines below are the whole
 * surface, each `SECURITY DEFINER` with `search_path` pinned and each asking
 * `is_global_admin()` again for itself:
 *
 *   list_accounts(status?)   the queue. Carries no family data of any kind: no
 *                            person, no Area, no amount, no name.
 *   set_account_status()     approve / reject / suspend / re-open.
 *   grant_global_admin()     appoint another. Creates NO family membership.
 *   revoke_global_admin()    stand one down. Refuses the last one.
 *
 * THE WHOLE LIST IS FETCHED ONCE, AND FILTERED IN THE BROWSER. `list_accounts`
 * takes an optional status, and calling it five times to fill in five counts
 * would be five queries where one already carries every row the counts are
 * made of. Filtering here is presentation; it is not narrowing anything a
 * caller was not already entitled to read.
 */

type AccountRow = {
  user_id: string;
  email: string | null;
  email_confirmed: boolean;
  status: string;
  is_global_admin: boolean;
  signed_up_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
};

type Decision = "approved" | "rejected" | "suspended";
type Filter = "pending" | "approved" | "rejected" | "suspended" | "all";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "suspended", label: "Suspended" },
  { value: "all", label: "All" },
];

/** The same 500 the routine enforces, so the field stops before the round trip. */
const NOTE_LIMIT = 500;

const STATUS_TONES: Record<string, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  suspended: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  suspended: "Suspended",
};

type DialogState =
  | { kind: "decision"; row: AccountRow; decision: Decision }
  | { kind: "grant-admin"; row: AccountRow }
  | { kind: "revoke-admin"; row: AccountRow }
  | null;

export function GlobalAccountsScreen() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [self, setSelf] = useState<string | null>(null);

  // Which row is the reader's own. `set_account_status` refuses a caller who
  // names themselves -- the reviewer and the reviewed being the same person is
  // the one case an audit trail cannot make sense of -- so offering the control
  // would be offering a button that is going to be refused.
  useEffect(() => {
    void createClient().auth.getUser().then(({ data }) => setSelf(data.user?.id ?? null));
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await createClient().rpc("list_accounts", { p_status: null });
      if (result.error) {
        setError(describeSupabaseError(result.error, "The account queue could not be loaded."));
        return;
      }
      setError(null);
      setRows((result.data ?? []) as AccountRow[]);
    } catch (thrown) {
      setError(describeThrown(thrown, "The account queue could not be loaded. Check your connection and try again."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = { pending: 0, approved: 0, rejected: 0, suspended: 0, all: rows.length };
    for (const row of rows) {
      if (row.status === "pending" || row.status === "approved" || row.status === "rejected" || row.status === "suspended") {
        result[row.status] += 1;
      }
    }
    return result;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesFilter = filter === "all" || row.status === filter;
      const matchesQuery = !needle || (row.email ?? "").toLowerCase().includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, rows]);

  const closeDialog = () => { setDialog(null); setNote(""); };

  const runDecision = async (row: AccountRow, decision: Decision) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const trimmed = note.trim();
      const result = await createClient().rpc("set_account_status", {
        p_user_id: row.user_id,
        p_status: decision,
        p_note: trimmed.length > 0 ? trimmed : null,
      });
      if (result.error) {
        setError(describeSupabaseError(result.error, "That decision could not be saved."));
        return;
      }
      setNotice(`${row.email ?? "That account"} is now ${STATUS_LABELS[decision].toLowerCase()}.`);
      closeDialog();
      await load(true);
    } catch (thrown) {
      setError(describeThrown(thrown, "That decision could not be saved. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  const runAdminChange = async (row: AccountRow, grant: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createClient().rpc(
        grant ? "grant_global_admin" : "revoke_global_admin",
        { p_user_id: row.user_id },
      );
      if (result.error) {
        setError(describeSupabaseError(
          result.error,
          grant
            ? "That account could not be made an administrator."
            : "That administrator could not be stood down.",
        ));
        return;
      }
      setNotice(grant
        ? `${row.email ?? "That account"} now administers Gift Planner.`
        : `${row.email ?? "That account"} no longer administers Gift Planner.`);
      closeDialog();
      await load(true);
      /*
       * STANDING YOURSELF DOWN TAKES THIS SCREEN WITH IT. `revoke_global_admin`
       * lets you do it -- it only refuses the LAST administrator -- and the
       * moment it succeeds `list_accounts` starts raising 42501 for this
       * session. A full load re-runs the server guard, which answers the 404
       * this account is now entitled to.
       */
      if (!grant && row.user_id === self) {
        window.location.assign(new URL("/", window.location.origin).toString());
      }
    } catch (thrown) {
      setError(describeThrown(thrown, "That change could not be saved. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-[1080px] px-[calc(1rem+env(safe-area-inset-left))] pt-6 pb-16 sm:px-6 sm:pt-8 lg:px-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-eyebrow text-gold uppercase">
            <IconShield size={16} className="text-gold" />
            Gift Planner administration
          </div>
          <h1 className="mt-2 font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.08] font-semibold tracking-tight">
            Accounts
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-600">
            Who may use Gift Planner at all. Approving somebody here does not put them in a
            family, and it shows you nothing about the families they are in.
          </p>
        </div>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => { void signOut(); }}
          className="w-full sm:w-auto"
        >
          Sign out
        </Button>
      </header>

      <div className="mt-7 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <label className="relative block w-full xl:max-w-sm">
          <span className="sr-only">Search accounts by email</span>
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400">
            <IconSearch size={18} />
          </span>
          <Input
            type="search"
            maxLength={INPUT_LIMITS.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by email"
            className="pl-10 text-sm"
          />
        </label>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Filter accounts">
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

      {loading ? (
        <div role="status" className="mt-7 grid gap-4 md:grid-cols-2">
          <p className="sr-only">Loading the account queue…</p>
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-3 h-3 w-32" />
              <Skeleton className="mt-6 h-11" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-7 rounded-2xl border border-dashed border-line-strong bg-surface-2 px-5 py-12 text-center">
          <h2 className="font-display text-lg font-semibold">Nothing to review</h2>
          <p className="mt-2 text-sm text-ink-600">No account matches that filter.</p>
        </div>
      ) : (
        <div className="mt-7 grid items-start gap-4 md:grid-cols-2">
          {visible.map((row) => (
            <AccountCard
              key={row.user_id}
              row={row}
              isSelf={row.user_id === self}
              busy={busy}
              onDecide={(decision) => { setNote(""); setDialog({ kind: "decision", row, decision }); }}
              onGrantAdmin={() => { setNote(""); setDialog({ kind: "grant-admin", row }); }}
              onRevokeAdmin={() => { setNote(""); setDialog({ kind: "revoke-admin", row }); }}
            />
          ))}
        </div>
      )}

      {dialog?.kind === "decision" && (
        <ConfirmDialog
          title={decisionTitle(dialog.decision, dialog.row.email)}
          body={
            <>
              <p>{decisionBody(dialog.decision)}</p>
              <Field label="Note (optional)" className="mt-4">
                <Textarea
                  rows={3}
                  maxLength={NOTE_LIMIT}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why, for the record. Only administrators see this."
                />
              </Field>
              <p className="mt-1.5 text-xs text-ink-600">{note.length} of {NOTE_LIMIT} characters.</p>
            </>
          }
          confirmLabel={decisionConfirmLabel(dialog.decision)}
          busyLabel="Saving…"
          busy={busy}
          danger={dialog.decision !== "approved"}
          onCancel={closeDialog}
          onConfirm={() => void runDecision(dialog.row, dialog.decision)}
        />
      )}

      {dialog?.kind === "grant-admin" && (
        <ConfirmDialog
          title={`Make ${dialog.row.email ?? "this account"} a Gift Planner administrator?`}
          body="They will be able to approve, reject and suspend every account, including making other administrators. It puts them in no family and shows them no family data."
          confirmLabel="Make administrator"
          busyLabel="Saving…"
          busy={busy}
          danger={false}
          onCancel={closeDialog}
          onConfirm={() => void runAdminChange(dialog.row, true)}
        />
      )}

      {dialog?.kind === "revoke-admin" && (
        <ConfirmDialog
          title={
            dialog.row.user_id === self
              ? "Stand yourself down as a Gift Planner administrator?"
              : `Stand ${dialog.row.email ?? "this account"} down?`
          }
          body={
            dialog.row.user_id === self
              ? "You will lose this screen immediately, and only another administrator can give it back. Their account, and yours, stay approved."
              : "Their account stays approved and their families are untouched. They simply stop being able to review accounts."
          }
          confirmLabel="Stand down"
          busyLabel="Saving…"
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void runAdminChange(dialog.row, false)}
        />
      )}
    </main>
  );
}

function AccountCard({
  row,
  isSelf,
  busy,
  onDecide,
  onGrantAdmin,
  onRevokeAdmin,
}: {
  row: AccountRow;
  isSelf: boolean;
  busy: boolean;
  onDecide: (decision: Decision) => void;
  onGrantAdmin: () => void;
  onRevokeAdmin: () => void;
}) {
  /*
   * APPROVAL REQUIRES A CONFIRMED EMAIL, and the database says so
   * (`set_account_status` raises 42501 for an unconfirmed one). Withholding the
   * button is the courtesy; the refusal is the rule.
   */
  const canApprove = row.email_confirmed && row.status !== "approved" && !isSelf;

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 flex-1 break-all font-display text-base font-semibold sm:text-lg">
          {row.email ?? "No email on record"}
        </h2>
        <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>
          {STATUS_LABELS[row.status] ?? row.status}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.is_global_admin && <Badge tone="gold">Gift Planner admin</Badge>}
        {isSelf && <Badge tone="pine">You</Badge>}
        <span
          className={cx(
            "text-xs font-semibold",
            row.email_confirmed ? "text-ink-600" : "text-berry",
          )}
        >
          {row.email_confirmed ? "Email confirmed" : "Email not confirmed"}
        </span>
      </div>

      <dl className="mt-4 space-y-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="font-medium text-ink-600">Signed up</dt>
          <dd className="font-semibold tabular-nums">{formatDate(row.signed_up_at)}</dd>
        </div>
        {row.decided_at && (
          <div className="flex justify-between gap-3">
            <dt className="font-medium text-ink-600">Decided</dt>
            <dd className="font-semibold tabular-nums">{formatDate(row.decided_at)}</dd>
          </div>
        )}
      </dl>

      {row.decision_note && (
        <p className="mt-3 rounded-xl border border-line bg-surface px-3 py-2 text-xs leading-5 text-ink-600">
          <span className="font-semibold text-ink-900">Note: </span>
          {row.decision_note}
        </p>
      )}

      {isSelf ? (
        <p className="mt-5 min-h-11 rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-5 font-medium text-accent">
          Nobody decides their own account. Another administrator has to.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-2">
          {canApprove && (
            <Button variant="tonal" size="md" disabled={busy} onClick={() => onDecide("approved")} className="text-xs">
              {row.status === "pending" ? "Approve" : "Re-approve"}
            </Button>
          )}
          {row.status !== "rejected" && (
            <Button variant="dangerGhost" size="md" disabled={busy} onClick={() => onDecide("rejected")} className="border border-berry-soft-border text-xs">
              Reject
            </Button>
          )}
          {row.status !== "suspended" && (
            <Button variant="secondary" size="md" disabled={busy} onClick={() => onDecide("suspended")} className="text-xs">
              Suspend
            </Button>
          )}
        </div>
      )}

      {/* APPOINTING CREATES NO FAMILY MEMBERSHIP. Offered only for an approved
          account, because `grant_global_admin` requires one and the CHECK
          `app_accounts_admin_must_be_approved` makes any other kind
          unreachable even by direct SQL. Standing DOWN is offered on your own
          row on purpose: it is a legitimate thing to do, right up until you are
          the last one, which the database refuses. */}
      {row.status === "approved" && (
        <div className="mt-2">
          {row.is_global_admin ? (
            <Button variant="ghost" size="md" disabled={busy} onClick={onRevokeAdmin} className="w-full text-xs">
              Stand down as administrator
            </Button>
          ) : (
            <Button variant="ghost" size="md" disabled={busy} onClick={onGrantAdmin} className="w-full text-xs">
              Make administrator
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function decisionTitle(decision: Decision, email: string | null) {
  const who = email ?? "this account";
  if (decision === "approved") return `Approve ${who}?`;
  if (decision === "rejected") return `Reject ${who}?`;
  return `Suspend ${who}?`;
}

function decisionBody(decision: Decision) {
  if (decision === "approved") {
    return "They will be able to open Gift Planner, create a family of their own, and take up any family access already waiting for them.";
  }
  if (decision === "rejected") {
    return "They will be able to sign in and will see nothing. Every family they are in becomes unreadable to them, and they are not told which decision was taken.";
  }
  return "Their access stops immediately and every family they are in becomes unreadable. Re-approving later restores the families but not any administrator role.";
}

function decisionConfirmLabel(decision: Decision) {
  if (decision === "approved") return "Approve account";
  if (decision === "rejected") return "Reject account";
  return "Suspend account";
}

/**
 * A date a person can read, in the reader's own locale settings but always the
 * British day-month order the rest of the app uses.
 */
function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
