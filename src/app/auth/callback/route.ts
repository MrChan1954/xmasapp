import { NextResponse } from "next/server";
import { HOME_PATH, destinationFor } from "@/lib/account-status";
import { getRequestOrigin } from "@/utils/request-origin";
import { claimInvitations, loadAccountStatus } from "@/utils/supabase/account-status-server";
import { createClient } from "@/utils/supabase/server";

const loginError = (requestOrigin: string, message: string) => NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, requestOrigin));

/**
 * A PKCE code is opaque base64url. Anything with whitespace or a control
 * character in it did not come from Supabase, and refusing it here keeps such
 * a value out of the exchange request and out of the log line below.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0020\u007f-\u009f]/u;

/**
 * WHERE EVERY EMAIL LINK LANDS: a sign-up confirmation, an invitation, a
 * password recovery.
 *
 * WHAT CHANGED IN Q19, AND IT IS THE WHOLE OF THE CHANGE. This route used to
 * finish by reading `app_members` and, finding nothing, calling `signOut()` and
 * sending the reader to a sign-in form saying "This email does not have access
 * to this Christmas."
 *
 * Under public sign-up that is the single worst place that refusal could be:
 * it is the last step of confirming a brand new address, and a brand new
 * account has no membership BY DEFINITION. Everybody who ever signed up would
 * have confirmed their address and been signed out for it.
 *
 * So membership is not asked about at all any more. The claim still runs --
 * it is the only routine that may attach a login to an invitation, and it is
 * the reason an invited person ends up in their family -- and then the GLOBAL
 * status decides where they go, exactly as it does on the sign-in form and in
 * `FamilyProvider`. One question, three callers, one answer.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestOrigin = getRequestOrigin(request);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next");
  const callbackError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const allowedDestinations = new Set(["/", "/reset-password", "/account-setup"]);
  const next = requestedNext && allowedDestinations.has(requestedNext) ? requestedNext : "/";
  const validCode = code && code.length <= 4_096 && !CONTROL_CHARACTERS.test(code) ? code : null;
  console.info("[auth callback] reached", { pathname: url.pathname, codePresent: Boolean(validCode) });
  if (!validCode) {
    if (callbackError) {
      const setupErrorUrl = new URL("/account-setup", requestOrigin);
      setupErrorUrl.searchParams.set("error", "invalid_auth_link");
      return NextResponse.redirect(setupErrorUrl);
    }

    // Supabase Auth Admin invite/recovery links deliberately use an implicit
    // handoff because the inviting and accepting browsers are different. URL
    // fragments never reach a server route, so hand that fragment to the
    // public browser-side setup screen without reading or logging its tokens.
    console.info("[auth callback] no PKCE code; serving implicit auth handoff");
    return implicitAuthHandoff();
  }
  const supabase = await createClient();
  const exchange = await supabase.auth.exchangeCodeForSession(validCode);
  console.info("[auth callback] code exchange complete", { succeeded: !exchange.error });
  if (exchange.error) {
    console.error("[auth callback] code exchange failed", { status: exchange.error.status });
    return loginError(requestOrigin, "This login link is invalid or has expired.");
  }

  /*
   * CLAIM AFTER CONFIRMATION, WHICH IS THE ORDER 052 MADE MANDATORY.
   *
   * `claim_app_member()` now requires `email_confirmed_at is not null` --
   * without it, signing up as somebody else's address was enough to walk into
   * their family. The code exchange above is what sets that column for a
   * confirmation link, so this call has to come after it and not before.
   *
   * A failure is not fatal and never was: `false` simply means there was
   * nothing waiting on this address, which is the normal case for anybody who
   * signed up on their own account rather than being invited.
   */
  const claimed = await claimInvitations();
  console.info("[auth callback] invitation claim complete", { claimed });

  /*
   * AND THEN THE ONE QUESTION THAT DECIDES ANYTHING. `my_account_status()`
   * carries the global decision and the confirmed flag; `destinationFor` turns
   * them into a path. An approved account goes wherever the link asked for, and
   * every other state goes to the screen that explains itself.
   */
  const status = await loadAccountStatus();
  const destination = destinationFor(status.state, HOME_PATH);
  if (destination && destination !== HOME_PATH) {
    console.info("[auth callback] routed by global status", { state: status.state });
    return NextResponse.redirect(new URL(destination, requestOrigin));
  }

  console.info("[auth callback] approved account signed in");
  return NextResponse.redirect(new URL(next, requestOrigin));
}

function implicitAuthHandoff() {
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Completing secure sign in</title></head>
  <body>
    <p>Completing your secure sign in…</p>
    <script>
      if (window.location.hash) {
        window.location.replace('/account-setup' + window.location.hash);
      } else {
        window.location.replace('/login?error=invalid_auth_link');
      }
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
