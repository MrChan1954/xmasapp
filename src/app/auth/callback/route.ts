import { NextResponse } from "next/server";
import { getRequestOrigin } from "@/utils/request-origin";
import { createClient } from "@/utils/supabase/server";

const loginError = (requestOrigin: string, message: string) => NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, requestOrigin));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestOrigin = getRequestOrigin(request);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next");
  const callbackError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const allowedDestinations = new Set(["/", "/reset-password", "/account-setup"]);
  const next = requestedNext && allowedDestinations.has(requestedNext) ? requestedNext : "/";
  const validCode = code && code.length <= 4_096 && !/[\u0000-\u0020\u007f-\u009f]/u.test(code) ? code : null;
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
  const claim = await supabase.rpc("claim_app_member");
  if (claim.error) {
    console.error("[auth callback] membership claim failed", { code: claim.error.code });
    await supabase.auth.signOut();
    return loginError(requestOrigin, "Your login succeeded, but this email is not linked to an approved family member.");
  }
  const userId = exchange.data.user?.id;
  const membership = userId ? await supabase.from("app_members").select("id").eq("user_id", userId).eq("active", true).maybeSingle() : { data: null, error: null };
  if (!membership.data) {
    console.error("[auth callback] no active membership after claim", { membershipErrorCode: membership.error?.code ?? null });
    await supabase.auth.signOut();
    return loginError(requestOrigin, "This email does not have access to this Christmas.");
  }
  console.info("[auth callback] approved member signed in");
  return NextResponse.redirect(new URL(next, requestOrigin));
}

function implicitAuthHandoff() {
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Completing secure sign in</title></head>
  <body>
    <p>Completing your secure sign in...</p>
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
