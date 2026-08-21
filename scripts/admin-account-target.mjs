/**
 * Which account the admin maintenance scripts act on.
 *
 * The email used to be hard-coded in both `setup-taylor.mjs` and
 * `set-taylor-password.mjs`. That put a real person's address in the repository
 * and in its history, and it meant the two scripts could drift apart about who
 * they targeted — one of them creating an Auth user for one address while the
 * other reset a password for another would be a genuinely confusing failure.
 *
 * Both now resolve it here, and both refuse to run without it. There is no
 * default and no fallback on purpose: these scripts create and modify real
 * accounts against the production service-role key, so guessing a target is
 * exactly the wrong behaviour.
 *
 * Supply it either way:
 *
 *   ADMIN_EMAIL=someone@example.com node scripts/setup-taylor.mjs
 *   node scripts/setup-taylor.mjs --email=someone@example.com
 *
 * The CLI flag wins, so a one-off run does not need the environment changed.
 */

/** Deliberately permissive: a shape check, not an attempt to validate RFC 5322. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveAdminEmail(argv = process.argv) {
  const flag = argv.find((argument) => argument.startsWith("--email="));
  const raw = flag ? flag.slice("--email=".length) : process.env.ADMIN_EMAIL;
  const email = (raw ?? "").trim().toLowerCase();

  if (!email) {
    throw new Error(
      "No account was specified. Pass --email=<address> or set ADMIN_EMAIL. "
      + "These scripts modify a real Auth account, so there is deliberately no default.",
    );
  }
  if (!EMAIL_SHAPE.test(email)) {
    throw new Error(`"${email}" does not look like an email address. No changes were made.`);
  }
  return email;
}

/**
 * Which `people` row the membership is expected to link to.
 *
 * Not sensitive — every family first name is already in `supabase/seed.sql` —
 * so this keeps its existing default rather than becoming a second required
 * argument for a script that has always been run one way.
 */
export function resolveAdminPersonName(argv = process.argv) {
  const flag = argv.find((argument) => argument.startsWith("--person="));
  const raw = flag ? flag.slice("--person=".length) : process.env.ADMIN_PERSON_NAME;
  return (raw ?? "Taylor").trim();
}
