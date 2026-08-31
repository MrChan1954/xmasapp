import { NextRequest, NextResponse } from "next/server";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { getRequestOrigin } from "@/utils/request-origin";

import {
  FamilyAccessError,
  type FamilyAccessAdminClient,
  passwordSetupRedirect,
  requireFamilyAccessAdmin,
  requirePersonId,
} from "@/utils/supabase/family-access-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ==========================================================================
 *  WHAT IS LEFT OF THIS ROUTE, AND WHY MOST OF IT IS GONE.
 * ==========================================================================
 *
 * It used to be 855 lines and eight actions, and it did the whole of Family
 * Access with the service role: list every person, every membership and EVERY
 * AUTH ACCOUNT IN THE PROJECT; create memberships; disable them; re-address
 * them. Every rule it obeyed was a rule it applied to itself, because the
 * service role bypasses row level security AND migration 037's write barrier.
 *
 * Migration 052 moved all of that into the database, where the rules are the
 * database's own:
 *
 *   reading   -> `list_area_access()`      no Area parameter, no email
 *                                          parameter, so it cannot be pointed
 *                                          at another family or used to probe
 *                                          whether an address has an account.
 *   granting  -> `grant_area_access()`     and it never writes `user_id`.
 *   revoking  -> `revoke_area_access()`    keeps the seat unless told to unlink.
 *   the       -> `set_family_contributor()` unchanged, and never needed this.
 *   pool
 *
 * THE PROJECT-WIDE AUTH ENUMERATION IS GONE ENTIRELY. `listAllAuthUsers` --
 * up to 100 pages of every account on the installation, fetched to answer a
 * question about one family -- has no caller and no longer exists. Nothing here
 * looks up an account by address, so this route can no longer answer "does this
 * email have an account", which is the disclosure the design forbade.
 *
 * THREE ACTIONS SURVIVE, and only because the Supabase Admin API is the only
 * thing that can perform them; there is no SQL routine that sends an email or
 * mints a one-time link:
 *
 *   send-invite       invite an address that has no account yet.
 *   copy-setup-link   the same, as a link, for a family that cannot receive
 *                     email reliably.
 *   copy-reset-link   a recovery link for an account that already exists.
 *
 * ORDINARY PASSWORD RESET IS NOT HERE. `supabase.auth.resetPasswordForEmail` is
 * a public Auth call the browser makes for itself with the publishable key --
 * the same call `/forgot-password` makes -- so routing it through the service
 * role added a privilege and no capability.
 *
 * AND NOT ONE OF THE THREE WRITES A ROW. They read a membership to find out
 * which address to send to, and then they talk to Auth. `app_members` is
 * written by `grant_area_access`, `revoke_area_access` and `claim_app_member`,
 * and by nothing else.
 */

type MembershipRow = {
  id: string;
  person_id: string | null;
  user_id: string | null;
  email: string | null;
  role: string;
  active: boolean;
};

type PersonRow = {
  id: string;
  name: string;
  area_id: string;
};

type Action = "send-invite" | "copy-setup-link" | "copy-reset-link";

const actions = new Set<Action>(["send-invite", "copy-setup-link", "copy-reset-link"]);

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
};

export async function POST(request: NextRequest) {
  try {
    // Route handlers are public entry points. This authorization check is
    // intentionally repeated for every request; do not rely on UI checks.
    const context = await requireFamilyAccessAdmin();
    const requestOrigin = assertSameOrigin(request);
    const body = await readBody(request);
    const action = requireAction(body.action);
    const personId = requirePersonId(body.personId);

    const { person, membership } = await loadTarget(context.admin, context.areaId, personId);

    /*
     * THE ADDRESS COMES FROM THE SEAT, NEVER FROM THE REQUEST.
     *
     * The old route took an `email` in the body and would create or re-address
     * an account from it. It cannot now: an invitation is created by
     * `grant_area_access`, which is where an administrator types an address and
     * where the database checks it. By the time anything here runs, the seat
     * already names the address, and sending to any other one would be sending
     * somebody else a way into this family.
     */
    if (!membership || !membership.email) {
      throw new FamilyAccessError(
        409,
        "Give this person access first — an invitation needs an address to go to.",
      );
    }
    if (!membership.active) {
      throw new FamilyAccessError(409, "Give this person access again before sending them a link.");
    }
    /*
     * ADMINISTRATORS ARE NOT MANAGED FROM THIS SCREEN, and the database says
     * the same: `grant_area_access` and `revoke_area_access` both refuse
     * `role = 'admin'`, because an Area has exactly one active administrator
     * and neither routine knows that invariant. Handing the family over is
     * `transfer_area_admin`'s job.
     */
    if (membership.role === "admin" || membership.user_id === context.authUserId) {
      throw new FamilyAccessError(
        409,
        "This family’s admin account cannot be changed with this action.",
      );
    }

    const redirectTo = passwordSetupRedirect(requestOrigin);

    if (action === "send-invite") {
      return await sendInvite(context.admin, person, membership, redirectTo);
    }
    return await copyLink(context.admin, person, membership, redirectTo, action);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * An invitation email to an address that has not been claimed yet.
 *
 * REFUSED ONCE THE SEAT IS CLAIMED, deliberately. `inviteUserByEmail` creates
 * an Auth account, and there already is one; the useful thing for a person who
 * has an account and cannot get in is a recovery link, which is the other
 * action.
 */
async function sendInvite(
  admin: FamilyAccessAdminClient,
  person: PersonRow,
  membership: MembershipRow,
  redirectTo: string,
) {
  if (membership.user_id) {
    throw new FamilyAccessError(
      409,
      "They have already signed up. Send them a password reset link instead.",
    );
  }

  const invited = await admin.auth.admin.inviteUserByEmail(membership.email as string, {
    data: { name: person.name },
    redirectTo,
  });
  if (invited.error) {
    // The real reason server-side; the client message stays generic so it
    // cannot be used to probe which addresses exist. Without this, an SMTP rate
    // limit and a non-allowlisted redirect URL are indistinguishable from the UI.
    console.error(
      `[family-access] invite email failed | status=${invited.error.status} code=${invited.error.code} redirectTo=${redirectTo}`,
    );
    throw new FamilyAccessError(502, "Supabase could not send the account invitation.");
  }

  return NextResponse.json(
    { ok: true, message: `An invitation was sent to ${person.name}.` },
    { headers: noStoreHeaders },
  );
}

/**
 * A one-time link, for a family whose email does not arrive reliably.
 *
 * WHICH KIND OF LINK IS DECIDED FROM THE SEAT AND ONE TARGETED LOOKUP, never
 * from a sweep of every account. `getUserById` asks about the single account
 * this seat is already attached to; there is no address search anywhere in this
 * file, which is what stops it answering "is this email registered".
 */
async function copyLink(
  admin: FamilyAccessAdminClient,
  person: PersonRow,
  membership: MembershipRow,
  redirectTo: string,
  action: "copy-setup-link" | "copy-reset-link",
) {
  const email = membership.email as string;
  let type: "invite" | "magiclink" | "recovery";

  if (!membership.user_id) {
    if (action === "copy-reset-link") {
      throw new FamilyAccessError(409, "They have not signed up yet. Copy a setup link instead.");
    }
    type = "invite";
  } else {
    const linked = await admin.auth.admin.getUserById(membership.user_id);
    if (linked.error || !linked.data.user) {
      throw new FamilyAccessError(409, "The account this seat is linked to no longer exists.");
    }
    // A confirmed address can be sent a recovery link; an unconfirmed one
    // cannot recover a password it has never set, and needs a magic link.
    type = linked.data.user.email_confirmed_at ? "recovery" : "magiclink";
  }

  const generated = await admin.auth.admin.generateLink({ type, email, options: { redirectTo } });
  if (generated.error || !generated.data.properties) {
    console.error(
      `[family-access] link generation failed | type=${type} status=${generated.error?.status} code=${generated.error?.code}`,
    );
    throw new FamilyAccessError(502, "Supabase could not generate that link.");
  }

  return NextResponse.json(
    {
      ok: true,
      message: action === "copy-reset-link"
        ? `A password reset link is ready for ${person.name}.`
        : `A secure setup link is ready for ${person.name}.`,
      link: generated.data.properties.action_link,
    },
    { headers: noStoreHeaders },
  );
}

/**
 * THE ONE GATEWAY. Both actions reach their person through here, so scoping
 * this scopes both: a person from another family comes back as "not found",
 * exactly as an id that names nobody does.
 */
async function loadTarget(
  admin: FamilyAccessAdminClient,
  areaId: string,
  personId: string,
) {
  const [personResult, membershipResult] = await Promise.all([
    admin
      .from("people")
      .select("id, name, area_id")
      .eq("id", personId)
      .eq("area_id", areaId)
      .maybeSingle(),
    admin
      .from("app_members")
      .select("id, person_id, user_id, email, role, active")
      .eq("person_id", personId)
      .eq("area_id", areaId),
  ]);

  if (personResult.error || membershipResult.error) {
    throw new FamilyAccessError(502, "This family member's account could not be loaded.");
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
  // `email`, `delivery` and `role` are gone from this list on purpose: the
  // address comes from the seat, and there is no account to create or role to
  // choose here any more.
  const allowedKeys = new Set(["action", "personId"]);
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
