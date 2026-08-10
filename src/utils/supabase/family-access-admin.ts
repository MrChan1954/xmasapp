import "server-only";

import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { validateEmail, validateUuid } from "@/lib/input-validation";

import { createClient as createSessionClient } from "../../../utils/supabase/server";

export class FamilyAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FamilyAccessError";
  }
}

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new FamilyAccessError(
      503,
      "Family Access is not configured on the server.",
    );
  }

  return createAdminSupabaseClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

export type FamilyAccessAdminClient = ReturnType<typeof createAdminClient>;

export async function requireFamilyAccessAdmin() {
  const sessionClient = await createSessionClient();
  const {
    data: { user },
    error: userError,
  } = await sessionClient.auth.getUser();

  if (userError || !user) {
    throw new FamilyAccessError(401, "You must sign in to continue.");
  }

  const { data: memberships, error: membershipError } = await sessionClient
    .from("app_members")
    .select("person_id, role, active")
    .eq("user_id", user.id);

  if (membershipError) {
    throw new FamilyAccessError(
      503,
      "Your Family Access permission could not be checked.",
    );
  }

  if (memberships.length !== 1) {
    throw new FamilyAccessError(403, "Your account is not approved for this app.");
  }

  const membership = memberships[0];
  if (!membership.active || membership.role !== "admin") {
    throw new FamilyAccessError(
      403,
      "Only the Global Admin can manage family access.",
    );
  }

  return {
    admin: createAdminClient(),
    authUserId: user.id,
    personId: membership.person_id as string | null,
  };
}

export async function listAllAuthUsers(
  admin: ReturnType<typeof createAdminClient>,
) {
  const users: User[] = [];
  const perPage = 1000;

  for (let page = 1; page <= 100; page += 1) {
    const result = await admin.auth.admin.listUsers({ page, perPage });
    if (result.error) {
      throw new FamilyAccessError(
        502,
        "Supabase Auth accounts could not be loaded.",
      );
    }

    users.push(...result.data.users);
    if (result.data.users.length < perPage) break;

    if (page === 100) {
      throw new FamilyAccessError(
        503,
        "There are too many Auth accounts to verify safely.",
      );
    }
  }

  return users;
}

export function normalizeEmail(value: unknown) {
  const result = validateEmail(value);
  if (!result.ok) throw new FamilyAccessError(400, result.error);
  return result.value;
}

export function requirePersonId(value: unknown) {
  const result = validateUuid(value, "Select a valid family member.");
  if (!result.ok) throw new FamilyAccessError(400, result.error);
  return result.value;
}

export function passwordSetupRedirect(requestOrigin: string) {
  return new URL(
    "/auth/callback?next=/account-setup",
    requestOrigin,
  ).toString();
}
