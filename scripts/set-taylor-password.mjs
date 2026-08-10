import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const taylorEmail = "tstward10@hotmail.co.uk";

if (!supabaseUrl || !secretKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and server-only SUPABASE_SECRET_KEY are required.");
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Run this command in an interactive terminal so the password can be entered securely.");
}

const admin = createClient(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: userPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw listError;

const matchingUsers = userPage.users.filter(
  (user) => user.email?.toLowerCase() === taylorEmail,
);

if (matchingUsers.length !== 1) {
  throw new Error(
    `Expected exactly one Auth account for Taylor, found ${matchingUsers.length}. No password was changed.`,
  );
}

const authUser = matchingUsers[0];
const { data: memberships, error: membershipError } = await admin
  .from("app_members")
  .select("id,user_id,email,role,active,person_id,contributor_id")
  .eq("user_id", authUser.id);

if (membershipError) throw membershipError;
if (memberships.length !== 1) {
  throw new Error(
    `Expected exactly one app_members record linked to Taylor's Auth account, found ${memberships.length}. No password was changed.`,
  );
}

const membership = memberships[0];
if (
  membership.email?.toLowerCase() !== taylorEmail ||
  membership.role !== "admin" ||
  membership.active !== true ||
  !membership.person_id ||
  !membership.contributor_id
) {
  throw new Error("Taylor's linked membership is not active, admin, and fully linked. No password was changed.");
}

console.log("Verified one existing Taylor Auth account and one linked active admin membership.");

let password = await readHidden("New password: ");
let confirmation = await readHidden("Confirm password: ");

if (password !== confirmation) {
  password = "";
  confirmation = "";
  throw new Error("Passwords did not match. No password was changed.");
}

if (password.length < 8) {
  password = "";
  confirmation = "";
  throw new Error("Password must contain at least 8 characters. No password was changed.");
}

const updateAttributes = {
  password,
  ...(!authUser.email_confirmed_at ? { email_confirm: true } : {}),
};
const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(
  authUser.id,
  updateAttributes,
);
password = "";
confirmation = "";

if (updateError) throw updateError;
if (updated.user.email?.toLowerCase() !== taylorEmail) {
  throw new Error("Auth verification failed after the password update.");
}

const { data: verifiedMemberships, error: verifyError } = await admin
  .from("app_members")
  .select("user_id,email,role,active,person_id,contributor_id")
  .eq("user_id", updated.user.id);

if (verifyError) throw verifyError;
if (
  verifiedMemberships.length !== 1 ||
  verifiedMemberships[0].email?.toLowerCase() !== taylorEmail ||
  verifiedMemberships[0].role !== "admin" ||
  verifiedMemberships[0].active !== true ||
  !verifiedMemberships[0].person_id ||
  !verifiedMemberships[0].contributor_id
) {
  throw new Error("Membership verification failed after the password update.");
}

console.log("Taylor's password was updated successfully.");
console.log("The existing Auth account is confirmed and remains linked to one active admin membership.");

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(input);
    };

    const onData = (character) => {
      if (character === "\u0003") return finish(new Error("Cancelled. No password was changed."));
      if (character === "\r" || character === "\n") return finish();
      if (character === "\u007f" || character === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (character >= " ") {
        input += character;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
  });
}
