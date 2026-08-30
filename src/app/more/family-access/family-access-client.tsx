"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";
import { IconPlus, IconSearch, IconShield } from "../../components/icons";
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
  Select,
  Skeleton,
  ToggleChip,
  cx,
  type BadgeTone,
} from "../../components/ui";
import { useRealtimeRefresh } from "../../components/use-realtime-refresh";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";

type AccountStatus = "no_account" | "pending" | "active" | "disabled";
type AccountRole = "admin" | "member" | null;

type FamilyMember = {
  personId: string;
  name: string;
  /** In the family's contributor pool. Eligibility, not an amount. */
  isFamilyContributor: boolean;
  email: string | null;
  role: AccountRole;
  active: boolean | null;
  status: AccountStatus;
  isCurrentUser: boolean;
};

type FamilyAccessResponse = {
  members: FamilyMember[];
  currentUser: {
    personId: string;
    role: "admin";
  };
};

type ActionName =
  | "create"
  | "send-invite"
  | "copy-setup-link"
  | "send-reset"
  | "copy-reset-link"
  | "disable"
  | "reactivate"
  | "update-email";

type ActionResponse = {
  ok?: boolean;
  message?: string;
  link?: string;
  error?: string;
};

type Filter = "all" | AccountStatus;
type DialogState =
  | { kind: "create"; personId: string }
  | { kind: "email"; person: FamilyMember }
  | { kind: "confirm-disable"; person: FamilyMember }
  | null;

const filters: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "no_account", label: "No account" },
  { value: "pending", label: "Setup pending" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

export function FamilyAccessClient() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadMembers = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/family-access", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | FamilyAccessResponse
        | { error?: string }
        | null;

      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        setMembers([]);
        return;
      }
      if (!response.ok || !payload || !("members" in payload)) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : "Family access could not be loaded.");
      }

      setForbidden(false);
      setMembers(payload.members);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Family access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMembers();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadMembers]);

  // This screen is family-global, so it watches the one family-global table it
  // shows: `people`. It no longer watches `contributors`, because contributor
  // membership is per-event and is edited in Event Settings, and no longer
  // watches `recipient_contributions`, because no money is shown here. The
  // refetch goes back through the admin route, so the Global Admin check still
  // runs on every refresh.
  useRealtimeRefresh(
    ["people"],
    () => loadMembers(true),
    { enabled: !forbidden },
  );

  const counts = useMemo(() => {
    const result: Record<Filter, number> = {
      all: members.length,
      no_account: 0,
      pending: 0,
      active: 0,
      disabled: 0,
    };
    members.forEach((person) => {
      result[person.status] += 1;
    });
    return result;
  }, [members]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return members.filter((person) => {
      const matchesFilter = filter === "all" || person.status === filter;
      const matchesQuery =
        !normalizedQuery ||
        person.name.toLowerCase().includes(normalizedQuery) ||
        person.email?.toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [filter, members, query]);

  const noAccountPeople = useMemo(
    () => members.filter((person) => person.status === "no_account").sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  const runAction = async (
    action: ActionName,
    person: Pick<FamilyMember, "personId" | "name">,
    options?: { email?: string; delivery?: "email" | "link" },
  ) => {
    const busyKey = `${action}:${person.personId}`;
    setBusy(busyKey);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/family-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          personId: person.personId,
          ...(options?.email ? { email: options.email } : {}),
          ...(options?.delivery ? { delivery: options.delivery } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as ActionResponse | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "That Family Access change could not be saved.");
      }

      const copiesLink = action === "copy-setup-link" || action === "copy-reset-link" || options?.delivery === "link";
      if (copiesLink) {
        if (!payload?.link) throw new Error("Supabase did not return a setup link.");
        try {
          await copySensitiveLink(payload.link);
        } catch (copyError) {
          // The server action may already have created or updated the account.
          // Refresh before reporting the separate clipboard failure.
          setDialog(null);
          await loadMembers(true);
          setError(copyError instanceof Error ? copyError.message : "The secure link was created, but this browser could not copy it.");
          return false;
        }
      }

      const defaultMessage = actionMessage(action, person.name, options?.delivery);
      setNotice(copiesLink ? defaultMessage : payload?.message ?? defaultMessage);
      setDialog(null);
      await loadMembers(true);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That Family Access change could not be saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

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
            Who can open the app, and what they are allowed to do. This is the whole family,
            not one event. To choose who receives or who chips in for a particular event,
            open that event and use its settings.
          </p>
        </div>
        <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
          <Button
            size="lg"
            disabled={loading || noAccountPeople.length === 0}
            onClick={() => setDialog({ kind: "create", personId: noAccountPeople[0]?.personId ?? "" })}
          >
            <IconPlus size={17} />
            Add account
          </Button>
        </div>
      </header>

      <ContributorPool
        members={members}
        busy={busy !== null}
        onError={setError}
        onChanged={() => void loadMembers(true)}
      />

      <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Account summary">
        <Summary label="Family" value={counts.all} />
        <Summary label="Active account" value={counts.active} accent />
        <Summary label="Setup pending" value={counts.pending} />
        <Summary label="No account" value={counts.no_account} />
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

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Filter accounts">
          {filters.map((item) => (
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
          <p className="mt-2 text-sm text-ink-600">Try a different name or account filter.</p>
        </div>
      ) : (
        <div className="mt-7 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((person) => (
            <AccountCard
              key={person.personId}
              person={person}
              busy={busy}
              onAdd={() => setDialog({ kind: "create", personId: person.personId })}
              onEditEmail={() => setDialog({ kind: "email", person })}
              onAction={(action) => void runAction(action, person)}
              onDisable={() => setDialog({ kind: "confirm-disable", person })}
            />
          ))}
        </div>
      )}

      {dialog?.kind === "create" && (
        <CreateAccountDialog
          people={noAccountPeople}
          initialPersonId={dialog.personId}
          busy={busy !== null}
          onClose={() => setDialog(null)}
          onCreate={async (person, email, delivery) => runAction("create", person, { email, delivery })}
        />
      )}

      {dialog?.kind === "email" && (
        <EmailDialog
          person={dialog.person}
          busy={busy !== null}
          onClose={() => setDialog(null)}
          onSave={async (email) => runAction("update-email", dialog.person, { email })}
        />
      )}

      {dialog?.kind === "confirm-disable" && (
        <ConfirmDialog
          title={`Disable app access for ${dialog.person.name}?`}
          body="Their Christmas information will not be deleted."
          confirmLabel="Disable access"
          busyLabel="Disabling…"
          busy={busy !== null}
          onCancel={() => setDialog(null)}
          onConfirm={() => void runAction("disable", dialog.person).then(() => setDialog(null))}
        />
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
 *   Global Admin edits that event on purpose. `set_family_contributor` writes
 *   one boolean and nothing else, and checks Global Admin itself — so hiding
 *   this section is a courtesy, not the boundary.
 */
function ContributorPool({
  members,
  busy,
  onError,
  onChanged,
}: {
  members: FamilyMember[];
  busy: boolean;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const eligible = members.filter((member) => member.isFamilyContributor);

  const toggle = async (member: FamilyMember) => {
    onError(null);
    setSaving(member.personId);
    try {
      const result = await createClient().rpc("set_family_contributor", {
        p_person_id: member.personId,
        p_eligible: !member.isFamilyContributor,
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
          {eligible.length} of {members.length} {members.length === 1 ? "person" : "people"}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {members.map((member) => {
            const on = member.isFamilyContributor;
            return (
              <ToggleChip
                key={member.personId}
                on={on}
                disabled={busy || saving !== null}
                onClick={() => void toggle(member)}
              >
                {member.name}{on ? " ✓" : ""}
              </ToggleChip>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AccountCard({
  person,
  busy,
  onAdd,
  onEditEmail,
  onAction,
  onDisable,
}: {
  person: FamilyMember;
  busy: string | null;
  onAdd: () => void;
  onEditEmail: () => void;
  onAction: (action: ActionName) => void;
  onDisable: () => void;
}) {
  const working = busy?.endsWith(`:${person.personId}`) ?? false;
  const isProtectedAdmin = person.role === "admin";

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className={cx(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl font-display text-base font-semibold",
            isProtectedAdmin ? "bg-pine-800 text-gold-fill" : "bg-accent-soft text-accent",
          )}>
            {initials(person.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="truncate font-display text-lg font-semibold">{person.name}</h2>
              <StatusBadge status={person.status} />
            </div>
            <p className="mt-1 text-xs font-semibold text-ink-600">
              {person.role === "admin" ? "Admin of this family" : person.role === "member" ? "Member" : "No account"}
            </p>
            {/* THE PERSON BEHIND THE ACCOUNT.
                This screen is about LOGINS; the profile is about the person --
                their name, their birthday, whether they chip in, and everything
                ever bought for them. They are two views of one human being and
                each should be one tap from the other, so nobody has to go
                looking for the directory to answer "who is this?". */}
            <a
              href={`/people/${person.personId}`}
              className="mt-1 inline-block text-xs font-semibold text-accent hover:underline"
            >
              Open {person.name}&rsquo;s profile →
            </a>
          </div>
        </div>

        <div className="mt-5 min-h-11 rounded-xl bg-surface-2 px-3 py-2.5">
          <p className="text-xs font-medium text-ink-600">Login email</p>
          <p className={cx("mt-0.5 break-all text-sm", person.email ? "font-semibold text-ink-900" : "text-ink-400")}>
            {person.email ?? "Not added yet"}
          </p>
        </div>

        <div className="mt-5">
          {person.status === "no_account" && (
            <Button onClick={onAdd} disabled={working} className="w-full">Add account</Button>
          )}

          {person.status === "pending" && (
            <div className="grid grid-cols-2 gap-2">
              <ActionButton disabled={working} onClick={() => onAction("send-invite")} primary>Send setup email</ActionButton>
              <ActionButton disabled={working} onClick={() => onAction("copy-setup-link")}>Copy setup link</ActionButton>
              <ActionButton disabled={working} onClick={onEditEmail}>Change email</ActionButton>
              <ActionButton disabled={working} onClick={onDisable} danger>Disable access</ActionButton>
            </div>
          )}

          {person.status === "active" && isProtectedAdmin && (
            <div className="flex min-h-11 items-center gap-2 rounded-xl bg-accent-soft px-3 text-xs leading-5 font-medium text-accent">
              <IconShield size={17} className="shrink-0 text-accent" />
              This family’s admin is protected. Hand the family over to change who runs it.
            </div>
          )}

          {person.status === "active" && !isProtectedAdmin && (
            <div className="grid grid-cols-2 gap-2">
              <ActionButton disabled={working} onClick={() => onAction("send-reset")} primary>Send password reset</ActionButton>
              <ActionButton disabled={working} onClick={() => onAction("copy-reset-link")}>Copy reset link</ActionButton>
              <ActionButton disabled={working} onClick={onEditEmail}>Change email</ActionButton>
              <ActionButton disabled={working} onClick={onDisable} danger>Disable access</ActionButton>
            </div>
          )}

          {person.status === "disabled" && (
            <div className="grid grid-cols-2 gap-2">
              <ActionButton disabled={working} onClick={() => onAction("reactivate")} primary>Reactivate</ActionButton>
              <ActionButton disabled={working} onClick={onEditEmail}>Change email</ActionButton>
            </div>
          )}

          {working && <p role="status" className="mt-3 text-center text-xs font-medium text-ink-600">Saving change…</p>}
        </div>
      </div>
    </article>
  );
}

function CreateAccountDialog({
  people,
  initialPersonId,
  busy,
  onClose,
  onCreate,
}: {
  people: FamilyMember[];
  initialPersonId: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (person: FamilyMember, email: string, delivery: "email" | "link") => Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(initialPersonId);
  const [email, setEmail] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const person = people.find((item) => item.personId === personId);

  const createAccount = async (delivery: "email" | "link") => {
    if (!person) {
      setValidation("Choose a family member.");
      return;
    }
    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail.ok) { setValidation(normalizedEmail.error); return; }
    setValidation(null);
    await onCreate(person, normalizedEmail.value, delivery);
  };

  return (
    <DialogFrame title="Add family account" description="Choose an existing person. This will not create another person record." busy={busy} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void createAccount("email"); }}>
        <Field label="Person" required>
          <Select autoFocus required value={personId} onChange={(event) => setPersonId(event.target.value)}>
            <option value="">Choose a person</option>
            {people.map((item) => <option key={item.personId} value={item.personId}>{item.name}</option>)}
          </Select>
        </Field>

        <Field label="Email address" className="mt-4" required>
          <Input required type="email" autoComplete="off" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
        </Field>

        <div className="mt-4 rounded-xl border border-line bg-surface-2 p-4">
          <p className="text-xs font-medium text-ink-600">Role</p>
          <p className="mt-1 font-semibold">User</p>
          <p className="mt-1 text-xs leading-5 text-ink-600">They can use the Christmas app but cannot manage family accounts.</p>
        </div>

        {validation && <p className="mt-4 text-sm font-semibold text-berry">{validation}</p>}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button type="submit" size="lg" disabled={busy}>{busy ? "Creating…" : "Create & send invite"}</Button>
          <Button variant="secondary" size="lg" disabled={busy} onClick={() => void createAccount("link")}>Create & copy setup link</Button>
        </div>
        <Button variant="ghost" disabled={busy} onClick={onClose} className="mt-3 w-full">Cancel</Button>
      </form>
    </DialogFrame>
  );
}

function EmailDialog({
  person,
  busy,
  onClose,
  onSave,
}: {
  person: FamilyMember;
  busy: boolean;
  onClose: () => void;
  onSave: (email: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState(person.email ?? "");
  const [validation, setValidation] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = validateEmail(email);
    if (!normalizedEmail.ok) { setValidation(normalizedEmail.error); return; }
    setValidation(null);
    await onSave(normalizedEmail.value);
  };

  return (
    <DialogFrame title={`Change ${person.name}'s email`} description="This becomes the email they use to sign in." busy={busy} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Login email" required>
          <Input autoFocus required type="email" autoComplete="off" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        {validation && <p className="mt-4 text-sm font-semibold text-berry">{validation}</p>}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button variant="secondary" size="lg" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" size="lg" disabled={busy}>{busy ? "Saving…" : "Save email"}</Button>
        </div>
      </form>
    </DialogFrame>
  );
}

function DialogFrame({
  title,
  description,
  busy,
  onClose,
  children,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal labelledBy="family-access-dialog-title" onClose={onClose} size="md" surface="white" dismissible={!busy}>
      <ModalHeader
        id="family-access-dialog-title"
        title={title}
        description={description}
        onClose={onClose}
      />
      <div className="px-5 pb-6 sm:px-7 sm:pb-7">{children}</div>
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

function StatusBadge({ status }: { status: AccountStatus }) {
  const tones: Record<AccountStatus, BadgeTone> = {
    no_account: "neutral",
    pending: "warning",
    active: "success",
    disabled: "danger",
  };
  const labels: Record<AccountStatus, string> = {
    no_account: "No account",
    pending: "Setup pending",
    active: "Active",
    disabled: "Disabled",
  };
  return <Badge tone={tones[status]}>{labels[status]}</Badge>;
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

function actionMessage(action: ActionName, name: string, delivery?: "email" | "link") {
  if (action === "create") return delivery === "link" ? `${name}'s account was created and the setup link was copied.` : `${name}'s account was created and the invite was sent.`;
  if (action === "send-invite") return `A new setup email was sent to ${name}.`;
  if (action === "copy-setup-link") return `${name}'s setup link was copied.`;
  if (action === "send-reset") return `A password reset email was sent to ${name}.`;
  if (action === "copy-reset-link") return `${name}'s password reset link was copied.`;
  if (action === "disable") return `${name}'s access was disabled.`;
  if (action === "reactivate") return `${name}'s access was reactivated.`;
  return `${name}'s login email was updated.`;
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
