import { NextRequest, NextResponse } from "next/server";
import { formatPennies } from "@/lib/currency";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { getRequestOrigin } from "@/utils/request-origin";

import {
  FamilyAccessError,
  type FamilyAccessAdminClient,
  listAllAuthUsers,
  normalizeEmail,
  passwordSetupRedirect,
  requireFamilyAccessAdmin,
  requirePersonId,
} from "@/utils/supabase/family-access-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MemberRole = "admin" | "member";
type AccountStatus = "no_account" | "pending" | "active" | "disabled";

type MembershipRow = {
  id: string;
  person_id: string | null;
  contributor_id: string | null;
  user_id: string | null;
  email: string | null;
  role: string;
  active: boolean;
};

type PersonRow = {
  id: string;
  name: string;
};

type ContributorRow = {
  id: string;
  person_id: string;
  active: boolean;
};

type Action =
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

const actions = new Set<Action>([
  "create",
  "send-invite",
  "copy-setup-link",
  "send-reset",
  "copy-reset-link",
  "disable",
  "reactivate",
  "update-email",
  "add-contributor",
  "remove-contributor",
]);

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
};

export async function GET() {
  try {
    // Route handlers are public entry points. Do not rely on Proxy or UI checks.
    const context = await requireFamilyAccessAdmin();
    const currentEvent = await loadCurrentChristmasEvent(context.admin);
    const [peopleResult, contributorResult, membershipResult, authUsers] =
      await Promise.all([
        context.admin.from("people").select("id, name").order("name"),
        context.admin
          .from("contributors")
          .select("id, person_id, active")
          .eq("christmas_event_id", currentEvent.id),
        context.admin
          .from("app_members")
          .select("id, person_id, contributor_id, user_id, email, role, active"),
        listAllAuthUsers(context.admin),
      ]);

    if (peopleResult.error || contributorResult.error || membershipResult.error) {
      throw new FamilyAccessError(
        502,
        "Christmas contributor access could not be loaded.",
      );
    }

    const people = peopleResult.data as PersonRow[];
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const allContributors = contributorResult.data as ContributorRow[];
    const activeContributors = allContributors.filter((row) => row.active);
    const activeContributorIds = activeContributors.map((row) => row.id);
    const contributionResult = activeContributorIds.length
      ? await context.admin
          .from("recipient_contributions")
          .select("contributor_id, planned_amount_pennies")
          .in("contributor_id", activeContributorIds)
      : { data: [], error: null };

    if (contributionResult.error) {
      throw new FamilyAccessError(
        502,
        "Planned contributor totals could not be loaded.",
      );
    }

    const plannedByContributor = new Map<string, number>();
    for (const row of contributionResult.data ?? []) {
      plannedByContributor.set(
        row.contributor_id,
        (plannedByContributor.get(row.contributor_id) ?? 0) +
          row.planned_amount_pennies,
      );
    }

    const membershipByPerson = new Map<string, MembershipRow>();
    for (const membership of membershipResult.data as MembershipRow[]) {
      if (!membership.person_id) continue;
      if (membershipByPerson.has(membership.person_id)) {
        throw new FamilyAccessError(
          409,
          "More than one account record is linked to the same person. No changes were made.",
        );
      }
      membershipByPerson.set(membership.person_id, membership);
    }

    const authUserById = new Map(authUsers.map((user) => [user.id, user]));
    const result = activeContributors.map((contributor) => {
      const person = peopleById.get(contributor.person_id);
      if (!person) {
        throw new FamilyAccessError(
          409,
          "An active contributor is not linked to a family person.",
        );
      }
      const membership = membershipByPerson.get(person.id);
      const authUser = membership?.user_id
        ? authUserById.get(membership.user_id)
        : undefined;
      const hasAccountDetails = Boolean(membership?.email || membership?.user_id);

      let status: AccountStatus = "no_account";
      if (membership && hasAccountDetails) {
        if (!membership.active) status = "disabled";
        else if (authUser?.email_confirmed_at) status = "active";
        else status = "pending";
      }

      const role: MemberRole | null = hasAccountDetails
        ? membership?.role === "admin"
          ? "admin"
          : "member"
        : null;

      return {
        contributorId: contributor.id,
        personId: person.id,
        name: person.name,
        email: membership?.email ?? authUser?.email ?? null,
        role,
        active: hasAccountDetails ? Boolean(membership?.active) : null,
        status,
        isCurrentUser: membership?.user_id === context.authUserId,
        plannedAmountPennies: plannedByContributor.get(contributor.id) ?? 0,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const activePersonIds = new Set(
      activeContributors.map((contributor) => contributor.person_id),
    );
    const availablePeople = people
      .filter((person) => !activePersonIds.has(person.id))
      .map((person) => ({ personId: person.id, name: person.name }));

    return NextResponse.json(
      {
        contributors: result,
        availablePeople,
        currentEvent,
        currentUser: {
          personId: context.personId,
          role: "admin" as const,
        },
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    // This authorization check is intentionally repeated for every mutation.
    const context = await requireFamilyAccessAdmin();
    const requestOrigin = assertSameOrigin(request);
    const body = await readBody(request);
    const action = requireAction(body.action);
    const personId = requirePersonId(body.personId);

    if (action === "add-contributor") {
      return await addContributor(context.admin, personId);
    }

    if (action === "remove-contributor") {
      return await removeContributor(
        context.admin,
        context.authUserId,
        personId,
      );
    }

    if (
      action === "create" ||
      action === "send-invite" ||
      action === "copy-setup-link"
    ) {
      return await createOrSetUpAccount(
        requestOrigin,
        context.admin,
        context.authUserId,
        personId,
        action,
        body,
      );
    }

    if (action === "send-reset" || action === "copy-reset-link") {
      return await resetAccount(
        requestOrigin,
        context.admin,
        personId,
        action,
      );
    }

    if (action === "disable" || action === "reactivate") {
      return await setAccountActive(
        context.admin,
        context.authUserId,
        personId,
        action === "reactivate",
      );
    }

    return await updateAccountEmail(
      context.admin,
      personId,
      normalizeEmail(body.email),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function loadCurrentChristmasEvent(admin: FamilyAccessAdminClient) {
  const { data, error } = await admin
    .from("christmas_events")
    .select("id, year, name")
    .order("year", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new FamilyAccessError(502, "The current Christmas event could not be loaded.");
  }
  if (!data) {
    throw new FamilyAccessError(404, "No Christmas event has been configured.");
  }
  return data;
}

async function addContributor(
  admin: FamilyAccessAdminClient,
  personId: string,
) {
  const [currentEvent, personResult] = await Promise.all([
    loadCurrentChristmasEvent(admin),
    admin.from("people").select("id, name").eq("id", personId).maybeSingle(),
  ]);
  if (personResult.error) {
    throw new FamilyAccessError(502, "This family person could not be checked.");
  }
  if (!personResult.data) {
    throw new FamilyAccessError(404, "This family person was not found.");
  }

  const contributorResult = await admin
    .from("contributors")
    .select("id, active")
    .eq("christmas_event_id", currentEvent.id)
    .eq("person_id", personId)
    .maybeSingle();
  if (contributorResult.error) {
    throw new FamilyAccessError(502, "Contributor status could not be checked.");
  }
  if (contributorResult.data?.active) {
    throw new FamilyAccessError(409, `${personResult.data.name} is already an active contributor.`);
  }

  const saved = contributorResult.data
    ? await admin
        .from("contributors")
        .update({ active: true })
        .eq("id", contributorResult.data.id)
    : await admin.from("contributors").insert({
        christmas_event_id: currentEvent.id,
        person_id: personId,
        active: true,
      });
  if (saved.error) {
    throw new FamilyAccessError(502, "This contributor could not be added.");
  }

  return NextResponse.json(
    {
      ok: true,
      message: `${personResult.data.name} is now a contributor. Their planned total is ${formatPennies(0)}.`,
    },
    { headers: noStoreHeaders },
  );
}

async function removeContributor(
  admin: FamilyAccessAdminClient,
  currentAuthUserId: string,
  personId: string,
) {
  const currentEvent = await loadCurrentChristmasEvent(admin);
  const { person, membership } = await loadTarget(admin, personId);
  if (membership?.role === "admin" || membership?.user_id === currentAuthUserId) {
    throw new FamilyAccessError(403, "The Global Admin contributor cannot be removed.");
  }

  const contributorResult = await admin
    .from("contributors")
    .select("id")
    .eq("christmas_event_id", currentEvent.id)
    .eq("person_id", personId)
    .eq("active", true)
    .maybeSingle();
  if (contributorResult.error) {
    throw new FamilyAccessError(502, "Contributor status could not be checked.");
  }
  if (!contributorResult.data) {
    throw new FamilyAccessError(409, `${person.name} is not an active contributor.`);
  }

  const allocationResult = await admin
    .from("recipient_contributions")
    .select("christmas_recipient_id, planned_amount_pennies")
    .eq("contributor_id", contributorResult.data.id)
    .gt("planned_amount_pennies", 0);
  if (allocationResult.error) {
    throw new FamilyAccessError(502, "Contributor allocations could not be checked safely.");
  }

  const allocatedPennies = allocationResult.data.reduce(
    (sum, row) => sum + row.planned_amount_pennies,
    0,
  );
  if (allocatedPennies > 0) {
    const recipientIds = [...new Set(allocationResult.data.map((row) => row.christmas_recipient_id))];
    const recipientResult = await admin
      .from("christmas_recipients")
      .select("id, person_id")
      .in("id", recipientIds);
    if (recipientResult.error) {
      throw new FamilyAccessError(502, "Affected Christmas recipients could not be loaded.");
    }
    const recipientPersonIds = [...new Set(recipientResult.data.map((row) => row.person_id))];
    const peopleResult = await admin
      .from("people")
      .select("id, name")
      .in("id", recipientPersonIds);
    if (peopleResult.error) {
      throw new FamilyAccessError(502, "Affected Christmas recipients could not be loaded.");
    }
    const names = peopleResult.data.map((row) => row.name).sort().join(", ");
    throw new FamilyAccessError(
      409,
      `${person.name} still has ${formatPennies(allocatedPennies)} allocated across Christmas recipients. Reassign those contributions before removing ${person.name}.${names ? ` Affected: ${names}.` : ""}`,
    );
  }

  const updated = await admin
    .from("contributors")
    .update({ active: false })
    .eq("id", contributorResult.data.id);
  if (updated.error) {
    throw new FamilyAccessError(502, "This contributor could not be removed.");
  }

  return NextResponse.json(
    {
      ok: true,
      message: `${person.name} is no longer an active contributor. Their account and history were kept.`,
    },
    { headers: noStoreHeaders },
  );
}

async function createOrSetUpAccount(
  requestOrigin: string,
  admin: FamilyAccessAdminClient,
  currentAuthUserId: string,
  personId: string,
  action: "create" | "send-invite" | "copy-setup-link",
  body: Record<string, unknown>,
) {
  const { person, membership } = await loadTarget(admin, personId);
  const existingAccount = Boolean(membership?.email || membership?.user_id);

  if (membership?.role === "admin" || membership?.user_id === currentAuthUserId) {
    throw new FamilyAccessError(
      409,
      "The Global Admin account cannot be changed with this action.",
    );
  }

  if (action === "create" && existingAccount) {
    throw new FamilyAccessError(
      409,
      "This person already has an account. Use the setup or reset actions instead.",
    );
  }

  if (existingAccount && membership && !membership.active) {
    throw new FamilyAccessError(
      409,
      "Reactivate this account before sending another setup link.",
    );
  }

  if (
    body.role !== undefined &&
    body.role !== "member" &&
    body.role !== "User"
  ) {
    throw new FamilyAccessError(
      400,
      "New family accounts can only have the User role.",
    );
  }

  const email = body.email
    ? normalizeEmail(body.email)
    : membership?.email
      ? normalizeEmail(membership.email)
      : normalizeEmail(undefined);

  if (membership?.email && normalizeEmail(membership.email) !== email) {
    throw new FamilyAccessError(
      409,
      "Change the account email before sending a setup link.",
    );
  }

  const delivery =
    action === "copy-setup-link"
      ? "link"
      : action === "send-invite"
        ? "email"
        : body.delivery === "link"
          ? "link"
          : "email";
  if (
    action === "create" &&
    body.delivery !== undefined &&
    body.delivery !== "email" &&
    body.delivery !== "link"
  ) {
    throw new FamilyAccessError(400, "Choose email or setup link delivery.");
  }

  const authUsers = await listAllAuthUsers(admin);
  const emailMatches = authUsers.filter(
    (user) => user.email?.trim().toLowerCase() === email,
  );
  if (emailMatches.length > 1) {
    throw new FamilyAccessError(
      409,
      "More than one Auth account uses this email. No changes were made.",
    );
  }

  const linkedAuthUser = membership?.user_id
    ? authUsers.find((user) => user.id === membership.user_id)
    : undefined;
  const emailAuthUser = emailMatches[0];
  if (
    linkedAuthUser &&
    emailAuthUser &&
    linkedAuthUser.id !== emailAuthUser.id
  ) {
    throw new FamilyAccessError(
      409,
      "This membership and email point to different Auth accounts. No changes were made.",
    );
  }
  if (
    linkedAuthUser?.email &&
    normalizeEmail(linkedAuthUser.email) !== email
  ) {
    throw new FamilyAccessError(
      409,
      "The linked Auth account uses a different email. Change the email first.",
    );
  }
  if (membership?.user_id && !linkedAuthUser) {
    throw new FamilyAccessError(
      409,
      "The membership is linked to an Auth account that no longer exists.",
    );
  }

  let authUser = linkedAuthUser ?? emailAuthUser;
  await ensureNoAccountCollision(admin, personId, email, authUser?.id ?? null);

  const redirectTo = passwordSetupRedirect(requestOrigin);
  let setupLink: string | undefined;

  if (!authUser) {
    if (delivery === "link") {
      const generated = await admin.auth.admin.generateLink({
        type: "invite",
        email,
        options: {
          data: { name: person.name },
          redirectTo,
        },
      });
      if (generated.error || !generated.data.user || !generated.data.properties) {
        throw new FamilyAccessError(
          502,
          "Supabase could not generate the setup link.",
        );
      }
      authUser = generated.data.user;
      setupLink = generated.data.properties.action_link;
    } else {
      const invited = await admin.auth.admin.inviteUserByEmail(email, {
        data: { name: person.name },
        redirectTo,
      });
      if (invited.error || !invited.data.user) {
        console.error(
          `[family-access] invite email failed | status=${invited.error?.status} code=${invited.error?.code} message=${invited.error?.message} redirectTo=${redirectTo}`,
        );
        throw new FamilyAccessError(
          502,
          "Supabase could not send the account invitation.",
        );
      }
      authUser = invited.data.user;
    }

    await ensureNoAccountCollision(admin, personId, email, authUser.id);
    await linkMembership(admin, personId, email, authUser.id, membership);
  } else {
    await linkMembership(admin, personId, email, authUser.id, membership);

    if (delivery === "link") {
      const generated = await admin.auth.admin.generateLink({
        type: authUser.email_confirmed_at ? "recovery" : "magiclink",
        email,
        options: { redirectTo },
      });
      if (generated.error || !generated.data.properties) {
        throw new FamilyAccessError(
          502,
          "Supabase could not generate the setup link.",
        );
      }
      setupLink = generated.data.properties.action_link;
    } else {
      const sent = await admin.auth.resetPasswordForEmail(email, { redirectTo });
      if (sent.error) {
        // Log the real reason server-side; the client message stays generic so
        // it cannot be used to probe which addresses exist. Without this, an
        // SMTP rate limit and a non-allowlisted redirect URL are
        // indistinguishable from the UI.
        console.error(
          `[family-access] setup email failed | status=${sent.error.status} code=${sent.error.code} message=${sent.error.message} redirectTo=${redirectTo}`,
        );
        throw new FamilyAccessError(
          502,
          "The account is linked, but Supabase could not send the setup email. You can retry or copy a setup link.",
        );
      }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      message:
        delivery === "link"
          ? `A secure setup link is ready for ${person.name}.`
          : `A secure setup email was sent to ${person.name}.`,
      ...(setupLink ? { link: setupLink } : {}),
    },
    { headers: noStoreHeaders },
  );
}

async function resetAccount(
  requestOrigin: string,
  admin: FamilyAccessAdminClient,
  personId: string,
  action: "send-reset" | "copy-reset-link",
) {
  const { person, membership } = await loadTarget(admin, personId);
  if (!membership?.active) {
    throw new FamilyAccessError(
      409,
      "Reactivate this account before resetting its password.",
    );
  }
  if (!membership.email || !membership.user_id) {
    throw new FamilyAccessError(
      409,
      "This person does not have a complete Auth account yet.",
    );
  }

  const email = normalizeEmail(membership.email);
  const authUsers = await listAllAuthUsers(admin);
  const emailMatches = authUsers.filter(
    (user) => user.email?.trim().toLowerCase() === email,
  );
  if (emailMatches.length !== 1 || emailMatches[0].id !== membership.user_id) {
    throw new FamilyAccessError(
      409,
      "The membership is not linked to exactly one matching Auth account.",
    );
  }

  const redirectTo = passwordSetupRedirect(requestOrigin);
  if (action === "send-reset") {
    const sent = await admin.auth.resetPasswordForEmail(email, { redirectTo });
    if (sent.error) {
      throw new FamilyAccessError(
        502,
        "Supabase could not send the password reset email.",
      );
    }
    return NextResponse.json(
      { ok: true, message: `A password reset email was sent to ${person.name}.` },
      { headers: noStoreHeaders },
    );
  }

  const generated = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  if (generated.error || !generated.data.properties) {
    throw new FamilyAccessError(
      502,
      "Supabase could not generate the password reset link.",
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: `A secure password reset link is ready for ${person.name}.`,
      link: generated.data.properties.action_link,
    },
    { headers: noStoreHeaders },
  );
}

async function setAccountActive(
  admin: FamilyAccessAdminClient,
  currentAuthUserId: string,
  personId: string,
  active: boolean,
) {
  const { person, membership } = await loadTarget(admin, personId);
  if (!membership?.email && !membership?.user_id) {
    throw new FamilyAccessError(409, "This person does not have an account.");
  }
  if (
    membership.role === "admin" ||
    membership.user_id === currentAuthUserId
  ) {
    throw new FamilyAccessError(
      403,
      "The Global Admin account cannot be disabled or reactivated here.",
    );
  }

  const { error } = await admin
    .from("app_members")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", membership.id);
  if (error) {
    throw new FamilyAccessError(
      502,
      active
        ? "This account could not be reactivated."
        : "This account could not be disabled.",
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: active
        ? `${person.name}'s access is active again.`
        : `${person.name}'s access has been disabled.`,
    },
    { headers: noStoreHeaders },
  );
}

async function updateAccountEmail(
  admin: FamilyAccessAdminClient,
  personId: string,
  email: string,
) {
  const { person, membership } = await loadTarget(admin, personId);
  if (!membership?.email && !membership?.user_id) {
    throw new FamilyAccessError(
      409,
      "Add an account for this person before changing its email.",
    );
  }
  if (membership.role === "admin") {
    throw new FamilyAccessError(
      403,
      "The Global Admin email cannot be changed from Family Access.",
    );
  }

  await ensureNoAccountCollision(admin, personId, email, membership.user_id);
  const oldEmail = membership.email ? normalizeEmail(membership.email) : null;

  if (membership.user_id) {
    const users = await listAllAuthUsers(admin);
    const linked = users.find((user) => user.id === membership.user_id);
    if (!linked) {
      throw new FamilyAccessError(
        409,
        "The linked Auth account no longer exists.",
      );
    }
    const matchingNewEmail = users.filter(
      (user) => user.email?.trim().toLowerCase() === email,
    );
    if (
      matchingNewEmail.length > 1 ||
      (matchingNewEmail.length === 1 &&
        matchingNewEmail[0].id !== membership.user_id)
    ) {
      throw new FamilyAccessError(
        409,
        "Another Auth account already uses this email.",
      );
    }

    const updatedAuth = await admin.auth.admin.updateUserById(
      membership.user_id,
      { email, email_confirm: true },
    );
    if (updatedAuth.error) {
      throw new FamilyAccessError(
        502,
        "Supabase Auth could not change this email.",
      );
    }
  }

  const updatedMembership = await admin
    .from("app_members")
    .update({ email, updated_at: new Date().toISOString() })
    .eq("id", membership.id);

  if (updatedMembership.error) {
    if (membership.user_id && oldEmail) {
      // Best-effort rollback keeps Auth and app_members aligned if the DB write fails.
      await admin.auth.admin.updateUserById(membership.user_id, {
        email: oldEmail,
        email_confirm: true,
      });
    }
    throw new FamilyAccessError(
      502,
      "The account email could not be saved.",
    );
  }

  return NextResponse.json(
    { ok: true, message: `${person.name}'s login email has been updated.` },
    { headers: noStoreHeaders },
  );
}

async function loadTarget(
  admin: FamilyAccessAdminClient,
  personId: string,
) {
  const [personResult, membershipResult] = await Promise.all([
    admin.from("people").select("id, name").eq("id", personId).maybeSingle(),
    admin
      .from("app_members")
      .select("id, person_id, contributor_id, user_id, email, role, active")
      .eq("person_id", personId),
  ]);

  if (personResult.error || membershipResult.error) {
    throw new FamilyAccessError(
      502,
      "This family member's account could not be loaded.",
    );
  }
  if (!personResult.data) {
    throw new FamilyAccessError(404, "This family member was not found.");
  }
  if (membershipResult.data.length > 1) {
    throw new FamilyAccessError(
      409,
      "More than one account record is linked to this person. No changes were made.",
    );
  }

  return {
    person: personResult.data as PersonRow,
    membership: (membershipResult.data[0] as MembershipRow | undefined) ?? null,
  };
}

async function ensureNoAccountCollision(
  admin: FamilyAccessAdminClient,
  personId: string,
  email: string,
  authUserId: string | null,
) {
  const { data, error } = await admin
    .from("app_members")
    .select("person_id, user_id, email");
  if (error) {
    throw new FamilyAccessError(
      502,
      "Existing family accounts could not be checked safely.",
    );
  }

  const collision = (data as Pick<
    MembershipRow,
    "person_id" | "user_id" | "email"
  >[]).some(
    (membership) =>
      membership.person_id !== personId &&
      ((membership.email?.trim().toLowerCase() === email) ||
        (authUserId !== null && membership.user_id === authUserId)),
  );

  if (collision) {
    throw new FamilyAccessError(
      409,
      "This email or Auth account is already linked to another person.",
    );
  }
}

async function linkMembership(
  admin: FamilyAccessAdminClient,
  personId: string,
  email: string,
  userId: string,
  membership: MembershipRow | null,
) {
  let contributorId = membership?.contributor_id ?? null;
  if (!contributorId) {
    const contributorResult = await admin
      .from("contributors")
      .select("id")
      .eq("person_id", personId)
      .eq("active", true)
      .limit(1);
    if (contributorResult.error) {
      throw new FamilyAccessError(
        502,
        "The family member's contributor link could not be checked.",
      );
    }
    contributorId = contributorResult.data[0]?.id ?? null;
  }

  const values = {
    person_id: personId,
    contributor_id: contributorId,
    user_id: userId,
    email,
    role: "member",
    active: true,
    updated_at: new Date().toISOString(),
  };
  const result = membership
    ? await admin.from("app_members").update(values).eq("id", membership.id)
    : await admin.from("app_members").insert(values);

  if (result.error) {
    throw new FamilyAccessError(
      result.error.code === "23505" ? 409 : 502,
      result.error.code === "23505"
        ? "This person or Auth account already has a membership."
        : "The Auth account was created, but its family membership could not be linked.",
    );
  }
}

async function readBody(request: NextRequest) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new FamilyAccessError(415, "Send this account request as JSON.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > INPUT_LIMITS.requestBody) {
    throw new FamilyAccessError(413, "This account request is too large.");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new FamilyAccessError(400, "Send a valid JSON request.");
  }
  if (text.length > INPUT_LIMITS.requestBody) {
    throw new FamilyAccessError(413, "This account request is too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FamilyAccessError(400, "Send a valid JSON request.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FamilyAccessError(400, "Send a valid account request.");
  }
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(["action", "personId", "email", "delivery", "role"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new FamilyAccessError(400, "This account request contains an unsupported field.");
  }
  return body;
}

function requireAction(value: unknown): Action {
  if (typeof value !== "string" || !actions.has(value as Action)) {
    throw new FamilyAccessError(400, "Choose a valid account action.");
  }
  return value as Action;
}

function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new FamilyAccessError(403, "This request origin is not allowed.");
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new FamilyAccessError(403, "This request origin is not allowed.");
  }

  const requestOrigin = getRequestOrigin(request);
  if (normalizedOrigin !== requestOrigin) {
    throw new FamilyAccessError(403, "This request origin is not allowed.");
  }

  return requestOrigin;
}

function errorResponse(error: unknown) {
  if (error instanceof FamilyAccessError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  }

  // Do not serialize Supabase errors: they can contain account identifiers.
  console.error("[family-access] unexpected server error", {
    type: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "Family Access could not complete this request." },
    { status: 500, headers: noStoreHeaders },
  );
}
