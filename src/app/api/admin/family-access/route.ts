import { NextRequest, NextResponse } from "next/server";
import { INPUT_LIMITS } from "@/lib/input-validation";
import type { AreaAccessRow } from "@/lib/family-access";
import {
  classifySetupEmailError,
  issueFamilyInvitation,
  type InvitationDeliveryOutcome,
  type SetupEmailResult,
} from "@/lib/family-invitations";
import { getRequestOrigin } from "@/utils/request-origin";
import { createClient as createSessionClient } from "@/utils/supabase/server";

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
 * database's own, and 053 finished the job:
 *
 *   reading   -> `list_area_access()`      no Area parameter, no email
 *                                          parameter, so it cannot be pointed
 *                                          at another family or used to probe
 *                                          whether an address has an account.
 *   granting  -> `grant_area_access()`     and it never writes `user_id`.
 *   revoking  -> `revoke_area_access()`    keeps the seat unless told to unlink.
 *   auditing  -> `record_invitation_delivery()`  two words, and it chooses the
 *                                          Area, the table, the actor and the
 *                                          sentence itself.
 *
 * EVERY ONE OF THOSE IS CALLED HERE WITH THE ADMINISTRATOR'S OWN SESSION, not
 * with the service role. They are `SECURITY DEFINER` routines that authorise
 * themselves from `auth.uid()` and the acting Area, so handing them the service
 * role would remove the only thing checking them.
 *
 * ==========================================================================
 *  THE SERVICE ROLE IS DOWN TO ONE CAPABILITY: SENDING MAIL.
 * ==========================================================================
 *
 * `invite`            create or reissue the invitation, and give the address
 *                     whatever it needs. If it has no account, that is the
 *                     account-setup email. If it has one, that is NOTHING --
 *                     the invitation waits for them inside the app, which is
 *                     Phase 5B's screen.
 * `copy-reset-link`   a recovery link for a seat that is already attached to a
 *                     login, for a family whose email does not arrive reliably.
 *
 * `send-invite` AND `copy-setup-link` ARE GONE, and their removal is the
 * security work of this phase.
 *
 *   `send-invite` was a SECOND button, offered only on a seat the screen had
 *   already labelled "Awaiting sign-up" -- a label that existed to say the
 *   address had no account. The whole two-step was an oracle with a state
 *   machine around it. Inviting is one press now, and delivery is part of it.
 *
 *   `copy-setup-link` minted `generateLink({ type: "invite" })`, which GoTrue
 *   REFUSES for an address that already has an account. An administrator got a
 *   link for a stranger and an error for a member: the cleanest account-
 *   existence oracle in the application, wearing a convenience feature's
 *   clothes. There is no version of it that keeps the convenience and loses the
 *   disclosure, so it is not here.
 *
 * ORDINARY PASSWORD RESET IS NOT HERE EITHER.
 * `supabase.auth.resetPasswordForEmail` is a public Auth call the browser makes
 * for itself with the publishable key -- the same call `/forgot-password` makes
 * -- so routing it through the service role added a privilege and no
 * capability.
 *
 * AND THE ROUTE STILL WRITES NO ROW ITSELF. There is no `.insert`, `.update`,
 * `.upsert` or `.delete` in this file. `app_members` is written by
 * `grant_area_access`, `revoke_area_access` and `accept_family_invitation`, and
 * by nothing else anywhere.
 */

type Action = "invite" | "copy-reset-link";

const actions = new Set<Action>(["invite", "copy-reset-link"]);

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
};

type SessionClient = Awaited<ReturnType<typeof createSessionClient>>;

export async function POST(request: NextRequest) {
  try {
    // Route handlers are public entry points. This authorization check is
    // intentionally repeated for every request; do not rely on UI checks.
    const context = await requireFamilyAccessAdmin();
    const requestOrigin = assertSameOrigin(request);
    const body = await readBody(request);
    const action = requireAction(body.action);
    const personId = requirePersonId(body.personId);

    const session = await createSessionClient();
    const redirectTo = passwordSetupRedirect(requestOrigin);

    if (action === "invite") {
      return await invite(session, context.admin, personId, body.email, redirectTo);
    }
    return await copyResetLink(session, context.admin, personId, redirectTo);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * ONE PRESS, TWO PRIVATE BRANCHES, ONE ANSWER.
 *
 * The decision lives in `@/lib/family-invitations`, which holds no client and
 * no key -- every privileged thing is one of these four closures. That is what
 * lets a test run the real decision with the branch chosen by a fake, instead
 * of reading this file and hoping.
 */
async function invite(
  session: SessionClient,
  admin: FamilyAccessAdminClient,
  personId: string,
  email: unknown,
  redirectTo: string,
) {
  const result = await issueFamilyInvitation(
    {
      listAccess: () => listAccess(session),
      grantAccess: async (person, address) => {
        const granted = await session.rpc("grant_area_access", {
          p_person_id: person,
          p_email: address,
        });
        if (granted.error) throw databaseRefusal(granted.error, "That access could not be given.");
      },
      recordDelivery: async (person, outcome: InvitationDeliveryOutcome) => {
        const recorded = await session.rpc("record_invitation_delivery", {
          p_person_id: person,
          p_outcome: outcome,
        });
        // Never the routine's own sentence: the caller turns any failure here
        // into the one branch-blind message, so a refused audit write and a
        // refused email are indistinguishable from outside.
        if (recorded.error) throw new Error("invitation delivery was not recorded");
      },
      sendSetupEmail: (address) => sendSetupEmail(admin, address, redirectTo),
    },
    { personId, email: typeof email === "string" ? email : "" },
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status, headers: noStoreHeaders });
  }
  return NextResponse.json({ ok: true, message: result.message }, { status: 200, headers: noStoreHeaders });
}

/**
 * THE ATTEMPT IS THE BRANCH, AND THERE IS NO LOOKUP.
 *
 * Nothing here asks Auth whether an address is registered, because a function
 * that answers that is a function somebody will eventually expose -- which is
 * exactly what `listAllAuthUsers` was before Q19 deleted it. `inviteUserByEmail`
 * refuses an already-registered address BEFORE it sends anything, and that
 * refusal is the only signal taken. It is folded into `ready` and never leaves
 * the server.
 *
 * THE LOG LINE NAMES NEITHER THE ADDRESS NOR THE BRANCH. A failure is logged
 * because somebody has to be able to diagnose SMTP; an already-registered
 * address is not logged at all, because that IS the disclosure.
 */
async function sendSetupEmail(
  admin: FamilyAccessAdminClient,
  email: string,
  redirectTo: string,
): Promise<SetupEmailResult> {
  const invited = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!invited.error) return { kind: "sent" };

  const classified = classifySetupEmailError(invited.error);
  if (classified.kind === "failed") {
    console.error(
      `[family-access] invitation delivery failed | status=${invited.error.status} code=${invited.error.code}`,
    );
  }
  return classified;
}

/**
 * A recovery link for a seat that already has a login on it.
 *
 * NO ACCOUNT-EXISTENCE QUESTION IS ASKED OR ANSWERED. It is offered only for a
 * CLAIMED seat, and `claimed` is a fact about a row inside the administrator's
 * own family that `list_area_access` already put on their screen. `magiclink`
 * against `recovery` is chosen from `email_confirmed` in that same row -- there
 * is no address search anywhere in this file, and no `getUserById` either.
 */
async function copyResetLink(
  session: SessionClient,
  admin: FamilyAccessAdminClient,
  personId: string,
  redirectTo: string,
) {
  const row = (await listAccess(session)).find((candidate) => candidate.person_id === personId);
  if (!row) throw new FamilyAccessError(404, "This family member was not found.");
  if (row.role === "admin") {
    throw new FamilyAccessError(
      409,
      "The family administrator’s access is changed by handing over the family, not here.",
    );
  }
  if (!row.app_member_id || !row.email) {
    throw new FamilyAccessError(409, "Invite this person first — a link needs an address to go to.");
  }
  if (row.active !== true) {
    throw new FamilyAccessError(409, "Give this person access again before sending them a link.");
  }
  if (row.claimed !== true) {
    throw new FamilyAccessError(409, "Their invitation has not been answered yet.");
  }

  // A confirmed address can be sent a recovery link; an unconfirmed one cannot
  // recover a password it has never set, and needs a magic link.
  const type = row.email_confirmed === true ? "recovery" : "magiclink";
  const generated = await admin.auth.admin.generateLink({
    type,
    email: row.email,
    options: { redirectTo },
  });
  if (generated.error || !generated.data.properties) {
    console.error(
      `[family-access] link generation failed | type=${type} status=${generated.error?.status} code=${generated.error?.code}`,
    );
    throw new FamilyAccessError(502, "Supabase could not generate that link.");
  }

  return NextResponse.json(
    {
      ok: true,
      message: `A password reset link is ready for ${row.person_name}.`,
      link: generated.data.properties.action_link,
    },
    { headers: noStoreHeaders },
  );
}

/**
 * THE ONE READ, AND IT TAKES NO AREA.
 *
 * `list_area_access()` has no Area parameter and no email parameter, and it
 * checks `is_area_admin(acting_area())` for itself. So this cannot be pointed
 * at another family however wrong the rest of this file gets: a person in Area
 * B is simply absent from the answer, and every caller here treats absent as
 * "not found".
 */
async function listAccess(session: SessionClient): Promise<AreaAccessRow[]> {
  const access = await session.rpc("list_area_access");
  if (access.error) {
    throw databaseRefusal(access.error, "This family’s access could not be read.");
  }
  return (access.data ?? []) as AreaAccessRow[];
}

/**
 * A routine's own refusal, kept as its own sentence and given the status that
 * matches its SQLSTATE. These sentences are written in the migrations and say
 * nothing about accounts outside the family; the fall-through is 409 rather
 * than 500 because a refusal is not a fault.
 */
function databaseRefusal(error: { code?: string | null; message?: string | null }, fallback: string) {
  const status =
    error.code === "42501" ? 403 :
    error.code === "22023" ? 400 :
    error.code === "23505" ? 409 :
    error.code === "P0002" ? 404 :
    409;
  return new FamilyAccessError(status, error.message?.trim() || fallback);
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
  /*
   * `email` IS BACK, and only because the invitation is one press again. It is
   * the address the administrator typed, and it is checked twice before it can
   * do anything: `validateEmail` here in the runtime, and
   * `grant_area_access`'s own shape check in the database. `delivery` and
   * `role` stay gone -- there is no account to create and no role to choose.
   */
  const allowedKeys = new Set(["action", "personId", "email"]);
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
