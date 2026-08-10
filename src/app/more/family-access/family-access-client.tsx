"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { formatPennies } from "@/lib/currency";
import { INPUT_LIMITS, validateEmail } from "@/lib/input-validation";

type AccountStatus = "no_account" | "pending" | "active" | "disabled";
type AccountRole = "admin" | "member" | null;

type FamilyContributor = {
  contributorId: string;
  personId: string;
  name: string;
  email: string | null;
  role: AccountRole;
  active: boolean | null;
  status: AccountStatus;
  isCurrentUser: boolean;
  plannedAmountPennies: number;
};

type AvailablePerson = { personId: string; name: string };

type FamilyAccessResponse = {
  contributors: FamilyContributor[];
  availablePeople: AvailablePerson[];
  currentEvent: { id: string; year: number; name: string };
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
  | "update-email"
  | "add-contributor"
  | "remove-contributor";

type ActionResponse = {
  ok?: boolean;
  message?: string;
  link?: string;
  error?: string;
};

type Filter = "all" | AccountStatus;
type DialogState =
  | { kind: "create"; personId: string }
  | { kind: "email"; person: FamilyContributor }
  | { kind: "contributor" }
  | null;

const filters: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "no_account", label: "No account" },
  { value: "pending", label: "Setup pending" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

export function FamilyAccessClient() {
  const [contributors, setContributors] = useState<FamilyContributor[]>([]);
  const [availablePeople, setAvailablePeople] = useState<AvailablePerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadContributors = useCallback(async (quiet = false) => {
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
        setContributors([]);
        setAvailablePeople([]);
        return;
      }
      if (!response.ok || !payload || !("contributors" in payload)) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : "Family access could not be loaded.");
      }

      setForbidden(false);
      setContributors(payload.contributors);
      setAvailablePeople(payload.availablePeople);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Family access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadContributors();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadContributors]);

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setDialog(null);
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [dialog, busy]);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = {
      all: contributors.length,
      no_account: 0,
      pending: 0,
      active: 0,
      disabled: 0,
    };
    contributors.forEach((person) => {
      result[person.status] += 1;
    });
    return result;
  }, [contributors]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return contributors.filter((person) => {
      const matchesFilter = filter === "all" || person.status === filter;
      const matchesQuery =
        !normalizedQuery ||
        person.name.toLowerCase().includes(normalizedQuery) ||
        person.email?.toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [filter, contributors, query]);

  const noAccountPeople = useMemo(
    () => contributors.filter((person) => person.status === "no_account").sort((a, b) => a.name.localeCompare(b.name)),
    [contributors],
  );

  const runAction = async (
    action: ActionName,
    person: Pick<FamilyContributor, "personId" | "name"> | AvailablePerson,
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
          await loadContributors(true);
          setError(copyError instanceof Error ? copyError.message : "The secure link was created, but this browser could not copy it.");
          return false;
        }
      }

      const defaultMessage = actionMessage(action, person.name, options?.delivery);
      setNotice(copiesLink ? defaultMessage : payload?.message ?? defaultMessage);
      setDialog(null);
      await loadContributors(true);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That Family Access change could not be saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const confirmDisable = async (person: FamilyContributor) => {
    if (!window.confirm(`Disable app access for ${person.name}? Their Christmas information will not be deleted.`)) return;
    await runAction("disable", person);
  };

  const confirmRemoveContributor = async (person: FamilyContributor) => {
    if (!window.confirm(`Remove ${person.name} as an active contributor? Their account, recipient entry, and history will be kept.`)) return;
    await runAction("remove-contributor", person);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8 lg:px-12" role="status">
        <p className="text-sm font-semibold text-[#75807c]">Checking Family Access permission...</p>
        <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading family access">
          {[0, 1, 2, 3, 4, 5].map((item) => <AccountSkeleton key={item} />)}
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center px-5 py-12 text-center sm:px-8">
        <section className="w-full rounded-3xl border border-[#e4e9e6] bg-white p-7 shadow-sm sm:p-10">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f7e7df] text-[#9a513d]">
            <LockIcon />
          </span>
          <h1 className="mt-5 text-3xl font-bold">Global Admin access only</h1>
          <p className="mt-3 text-sm leading-6 text-[#75807c]">
            Your account can use the Christmas app, but it cannot manage other family accounts.
          </p>
          <Link href="/more" className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-[#1f5b50] px-5 font-bold text-white">
            Back to More
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-7 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
      <Link href="/more" className="inline-flex min-h-10 items-center gap-2 text-sm font-bold text-[#28685c]">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 18-6-6 6-6" />
        </svg>
        More
      </Link>

      <header className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[#28685c]">
            <ShieldIcon />
            Global Admin
          </div>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">Family Access</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75807c] sm:text-base">
            Manage Christmas contributors and control who can open the app.
          </p>
        </div>
        <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
          <button
            type="button"
            disabled={loading || availablePeople.length === 0}
            onClick={() => setDialog({ kind: "contributor" })}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[#a8c8be] bg-white px-5 text-sm font-bold text-[#28685c] shadow-sm transition hover:bg-[#f2f8f6] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <PlusIcon />
            Add Contributor
          </button>
          <button
            type="button"
            disabled={loading || noAccountPeople.length === 0}
            onClick={() => setDialog({ kind: "create", personId: noAccountPeople[0]?.personId ?? "" })}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#1f5b50] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#184b42] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <PlusIcon />
            Add account
          </button>
        </div>
      </header>

      <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Account summary">
        <Summary label="Contributors" value={counts.all} />
        <Summary label="Active account" value={counts.active} accent />
        <Summary label="Setup pending" value={counts.pending} />
        <Summary label="No account" value={counts.no_account} />
      </section>

      <div className="mt-7 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <label className="relative block w-full xl:max-w-sm">
          <span className="sr-only">Search family access</span>
          <SearchIcon />
          <input
            type="search"
            maxLength={INPUT_LIMITS.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or email"
            className="h-12 w-full rounded-xl border border-[#dfe5e2] bg-white pl-11 pr-4 text-sm outline-none transition placeholder:text-[#9aa39f] focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]"
          />
        </label>

        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Filter accounts">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              aria-pressed={filter === item.value}
              className={`min-h-10 shrink-0 rounded-full px-4 text-xs font-bold transition ${
                filter === item.value
                  ? "bg-[#1f5b50] text-white"
                  : "border border-[#e1e6e3] bg-white text-[#66716d] hover:border-[#bfd0ca]"
              }`}
            >
              {item.label} <span className={filter === item.value ? "text-white/75" : "text-[#9aa39f]"}>{counts[item.value]}</span>
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true">
        {notice && (
          <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-[#cfe3dc] bg-[#f1f8f5] p-4 text-sm text-[#225f54]">
            <p>{notice}</p>
            <button type="button" onClick={() => setNotice(null)} className="shrink-0 font-bold" aria-label="Dismiss message">×</button>
          </div>
        )}
        {error && (
          <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-[#ecd4ca] bg-[#fff7f3] p-4 text-sm text-[#934d3b]">
            <p>{error}</p>
            <button type="button" onClick={() => setError(null)} className="shrink-0 font-bold" aria-label="Dismiss error">×</button>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="mt-7 rounded-2xl border border-dashed border-[#d7ded9] bg-white px-5 py-12 text-center">
          <h2 className="font-bold">No matching contributors</h2>
          <p className="mt-2 text-sm text-[#75807c]">Try a different name or account filter.</p>
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
              onDisable={() => void confirmDisable(person)}
              onRemoveContributor={() => void confirmRemoveContributor(person)}
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

      {dialog?.kind === "contributor" && (
        <AddContributorDialog
          people={availablePeople}
          busy={busy !== null}
          onClose={() => setDialog(null)}
          onAdd={async (person) => runAction("add-contributor", person)}
        />
      )}
    </div>
  );
}

function AccountCard({
  person,
  busy,
  onAdd,
  onEditEmail,
  onAction,
  onDisable,
  onRemoveContributor,
}: {
  person: FamilyContributor;
  busy: string | null;
  onAdd: () => void;
  onEditEmail: () => void;
  onAction: (action: ActionName) => void;
  onDisable: () => void;
  onRemoveContributor: () => void;
}) {
  const working = busy?.endsWith(`:${person.personId}`) ?? false;
  const isProtectedAdmin = person.role === "admin";

  return (
    <article className="overflow-hidden rounded-2xl border border-[#e3e8e5] bg-white shadow-sm">
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-base font-bold ${isProtectedAdmin ? "bg-[#1f5b50] text-white" : "bg-[#eaf3f0] text-[#28685c]"}`}>
            {initials(person.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="truncate text-lg font-bold">{person.name}</h2>
              <StatusBadge status={person.status} />
            </div>
            <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-[#60706a]">
              {person.role === "admin" ? "Global Admin" : person.role === "member" ? "User" : "No account"}
            </p>
          </div>
        </div>

        <div className="mt-5 min-h-11 rounded-xl bg-[#f7f9f7] px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#8a9590]">Login email</p>
          <p className={`mt-0.5 break-all text-sm ${person.email ? "font-semibold text-[#34413d]" : "text-[#8a9590]"}`}>
            {person.email ?? "Not added yet"}
          </p>
        </div>

        <div className="mt-3 flex min-h-11 items-center justify-between rounded-xl bg-[#edf7f3] px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#60706a]">Planned contribution</p>
          <p className="text-base font-bold text-[#28685c]">{formatPennies(person.plannedAmountPennies)}</p>
        </div>

        <div className="mt-5">
          {person.status === "no_account" && (
            <button type="button" onClick={onAdd} disabled={working} className="min-h-11 w-full rounded-xl bg-[#1f5b50] px-4 text-sm font-bold text-white disabled:opacity-50">
              Add account
            </button>
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
            <div className="flex min-h-11 items-center gap-2 rounded-xl bg-[#eef6f3] px-3 text-xs font-semibold leading-5 text-[#346b60]">
              <ShieldIcon />
              The Global Admin account is protected.
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

          {!isProtectedAdmin && (
            <button
              type="button"
              onClick={onRemoveContributor}
              disabled={working}
              className="mt-4 min-h-11 w-full border-t border-[#ece1dc] pt-4 text-sm font-bold text-[#9a503c] disabled:opacity-50"
            >
              Remove Contributor
            </button>
          )}

          {working && <p role="status" className="mt-3 text-center text-xs font-semibold text-[#60706a]">Saving change...</p>}
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
  people: FamilyContributor[];
  initialPersonId: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (person: FamilyContributor, email: string, delivery: "email" | "link") => Promise<boolean>;
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
        <label className="block text-sm font-bold">
          Person
          <select autoFocus required value={personId} onChange={(event) => setPersonId(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] bg-white px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]">
            <option value="">Choose a person</option>
            {people.map((item) => <option key={item.personId} value={item.personId}>{item.name}</option>)}
          </select>
        </label>

        <label className="mt-4 block text-sm font-bold">
          Email address
          <input required type="email" autoComplete="off" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>

        <div className="mt-4 rounded-xl bg-[#f5f8f6] p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-[#7a8580]">Role</p>
          <p className="mt-1 font-bold">User</p>
          <p className="mt-1 text-xs leading-5 text-[#75807c]">They can use the Christmas app but cannot manage family accounts.</p>
        </div>

        {validation && <p className="mt-4 text-sm font-semibold text-[#984d3a]">{validation}</p>}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="submit" disabled={busy} className="min-h-12 rounded-xl bg-[#1f5b50] px-4 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Creating…" : "Create & send invite"}
          </button>
          <button type="button" disabled={busy} onClick={() => void createAccount("link")} className="min-h-12 rounded-xl border border-[#b8ccc5] bg-white px-4 text-sm font-bold text-[#28685c] disabled:opacity-50">
            Create & copy setup link
          </button>
        </div>
        <button type="button" disabled={busy} onClick={onClose} className="mt-3 min-h-11 w-full rounded-xl text-sm font-bold text-[#69746f] disabled:opacity-50">Cancel</button>
      </form>
    </DialogFrame>
  );
}

function AddContributorDialog({
  people,
  busy,
  onClose,
  onAdd,
}: {
  people: AvailablePerson[];
  busy: boolean;
  onClose: () => void;
  onAdd: (person: AvailablePerson) => Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(people[0]?.personId ?? "");
  const [validation, setValidation] = useState<string | null>(null);
  const person = people.find((item) => item.personId === personId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!person) {
      setValidation("Choose an existing person.");
      return;
    }
    setValidation(null);
    await onAdd(person);
  };

  return (
    <DialogFrame
      title="Add Contributor"
      description="Choose an existing person for the current Christmas. This does not create an account or change any allocations."
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="block text-sm font-bold">
          Person
          <select
            autoFocus
            required
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] bg-white px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]"
          >
            <option value="">Choose a person</option>
            {people.map((item) => (
              <option key={item.personId} value={item.personId}>{item.name}</option>
            ))}
          </select>
        </label>

        <div className="mt-4 rounded-xl bg-[#f5f8f6] p-4 text-sm leading-6 text-[#60706a]">
          Their planned contribution starts at {formatPennies(0)}. Use each recipient&apos;s contributor editor to assign money later.
        </div>

        {validation && <p className="mt-4 text-sm font-semibold text-[#984d3a]">{validation}</p>}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-12 rounded-xl border border-[#d9dfdc] font-bold disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy || people.length === 0} className="min-h-12 rounded-xl bg-[#1f5b50] font-bold text-white disabled:opacity-50">
            {busy ? "Adding..." : "Add Contributor"}
          </button>
        </div>
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
  person: FamilyContributor;
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
        <label className="block text-sm font-bold">
          Login email
          <input autoFocus required type="email" autoComplete="off" maxLength={INPUT_LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-[#dbe2de] px-3 outline-none focus:border-[#75a99a] focus:ring-4 focus:ring-[#dcece7]" />
        </label>
        {validation && <p className="mt-4 text-sm font-semibold text-[#984d3a]">{validation}</p>}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-12 rounded-xl border border-[#d9dfdc] font-bold disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy} className="min-h-12 rounded-xl bg-[#1f5b50] font-bold text-white disabled:opacity-50">{busy ? "Saving…" : "Save email"}</button>
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#17211e]/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="family-access-dialog-title" className="max-h-[94vh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="family-access-dialog-title" className="text-2xl font-bold">{title}</h2>
            <p className="mt-2 text-sm leading-5 text-[#75807c]">{description}</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f2f5f3] text-2xl text-[#55615c] disabled:opacity-50">×</button>
        </div>
        <div className="mt-6">{children}</div>
      </section>
    </div>
  );
}

function Summary({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 sm:p-5 ${accent ? "border-[#cde1da] bg-[#edf7f3]" : "border-[#e4e9e6] bg-white"}`}>
      <p className={`text-2xl font-bold sm:text-3xl ${accent ? "text-[#28685c]" : "text-[#1d2926]"}`}>{value}</p>
      <p className="mt-1 text-xs font-semibold text-[#75807c] sm:text-sm">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: AccountStatus }) {
  const styles: Record<AccountStatus, string> = {
    no_account: "border-[#dfe4e1] bg-[#f5f7f6] text-[#69736f]",
    pending: "border-[#ead9aa] bg-[#fff8e4] text-[#816517]",
    active: "border-[#cce2da] bg-[#edf7f3] text-[#28685c]",
    disabled: "border-[#ebd2c8] bg-[#fff2ed] text-[#9a503c]",
  };
  const labels: Record<AccountStatus, string> = {
    no_account: "No account",
    pending: "Setup pending",
    active: "Active",
    disabled: "Disabled",
  };
  return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${styles[status]}`}>{labels[status]}</span>;
}

function ActionButton({ children, disabled, onClick, primary = false, danger = false }: { children: React.ReactNode; disabled: boolean; onClick: () => void; primary?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-xl border px-2 text-xs font-bold leading-4 transition disabled:cursor-wait disabled:opacity-50 ${
        primary
          ? "border-[#b9d3ca] bg-[#edf7f3] text-[#28685c] hover:bg-[#e2f1ec]"
          : danger
            ? "border-[#ead1c7] bg-white text-[#9a503c] hover:bg-[#fff5f1]"
            : "border-[#dce2df] bg-white text-[#52605b] hover:bg-[#f6f8f7]"
      }`}
    >
      {children}
    </button>
  );
}

function AccountSkeleton() {
  return (
    <div className="h-64 animate-pulse rounded-2xl border border-[#e8ecea] bg-white p-6">
      <div className="flex gap-3"><div className="h-12 w-12 rounded-2xl bg-[#edf1ef]" /><div className="flex-1"><div className="h-4 w-28 rounded bg-[#edf1ef]" /><div className="mt-3 h-3 w-16 rounded bg-[#edf1ef]" /></div></div>
      <div className="mt-6 h-14 rounded-xl bg-[#f1f4f2]" />
      <div className="mt-5 h-11 rounded-xl bg-[#edf1ef]" />
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function actionMessage(action: ActionName, name: string, delivery?: "email" | "link") {
  if (action === "add-contributor") return `${name} is now an active contributor.`;
  if (action === "remove-contributor") return `${name} is no longer an active contributor.`;
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

function SearchIcon() {
  return <svg className="pointer-events-none absolute left-4 top-3.5 text-[#8a9590]" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}

function PlusIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>;
}

function ShieldIcon() {
  return <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3 5 6v5c0 4.6 2.8 8.5 7 10 4.2-1.5 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
}

function LockIcon() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}
