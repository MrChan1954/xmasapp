import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const email = "tstward10@hotmail.co.uk";
const verifyOnly = process.argv.includes("--verify-only");

if (!url || !publishableKey || !secretKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and server-only SUPABASE_SECRET_KEY are required.");

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const publicClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: usersPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw listError;
const matchingUsers = usersPage.users.filter((user) => user.email?.toLowerCase() === email);
if (matchingUsers.length > 1) throw new Error("More than one Taylor Auth account exists. No changes were made.");

let authUser = matchingUsers[0];
if (!authUser) {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name: "Taylor" } });
  if (created.error) throw created.error;
  authUser = created.data.user;
}

const person = await admin.from("people").select("id").eq("name", "Taylor").maybeSingle();
if (person.error || !person.data) throw new Error(`Taylor person record was not found: ${person.error?.message ?? "missing"}`);
const contributor = await admin.from("contributors").select("id").eq("person_id", person.data.id).maybeSingle();
if (contributor.error || !contributor.data) throw new Error(`Taylor contributor record was not found: ${contributor.error?.message ?? "missing"}`);
const [membershipsByPerson, membershipsByEmail] = await Promise.all([
  admin.from("app_members").select("id,email,user_id,person_id").eq("person_id", person.data.id),
  admin.from("app_members").select("id,email,user_id,person_id").ilike("email", email),
]);
if (membershipsByPerson.error) throw membershipsByPerson.error;
if (membershipsByEmail.error) throw membershipsByEmail.error;
const memberships = [...new Map(
  [...membershipsByPerson.data, ...membershipsByEmail.data].map((membership) => [membership.id, membership]),
).values()];
if (memberships.length !== 1) throw new Error(`Expected exactly one Taylor app_members record, found ${memberships.length}. No membership changes were made.`);
const membership = memberships[0];
if (membership.user_id && membership.user_id !== authUser.id) throw new Error("Taylor's membership is linked to a different Auth user. No changes were made.");
const updated = await admin.from("app_members").update({ email, user_id: authUser.id, person_id: person.data.id, contributor_id: contributor.data.id, role: "admin", active: true, updated_at: new Date().toISOString() }).eq("id", membership.id);
if (updated.error) throw updated.error;

const verification = await admin.from("app_members").select("email,user_id,person_id,contributor_id,role,active").eq("id", membership.id).single();
if (verification.error) throw verification.error;
const exactAuthMatches = usersPage.users.filter((user) => user.email?.toLowerCase() === email).length + (matchingUsers.length === 0 ? 1 : 0);
if (exactAuthMatches !== 1 || verification.data.user_id !== authUser.id || verification.data.person_id !== person.data.id || verification.data.contributor_id !== contributor.data.id || verification.data.role !== "admin" || !verification.data.active) throw new Error("Taylor account verification failed.");

if (verifyOnly) {
  console.log(JSON.stringify({ authUserCount: exactAuthMatches, authCreatedAt: authUser.created_at, authLastSignInAt: authUser.last_sign_in_at ?? null, email: verification.data.email, membershipCount: memberships.length, membershipLinked: true, contributorLinked: true, role: verification.data.role, active: verification.data.active }));
  process.exit(0);
}

const recovery = await publicClient.auth.resetPasswordForEmail(email, { redirectTo: `${appUrl}/auth/callback?next=/reset-password` });
if (recovery.error) throw recovery.error;
console.log(JSON.stringify({ accountExists: true, reusedExistingAuthUser: matchingUsers.length === 1, email, membershipLinked: true, role: "admin", active: true, passwordSetupEmailSent: true }));
