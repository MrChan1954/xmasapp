import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getRequestOrigin } from "@/utils/request-origin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export async function updateSession(request: NextRequest) {
  const requestOrigin = getRequestOrigin(request);
  const pathname = request.nextUrl.pathname;
  const callbackRoute = pathname === "/auth/callback";
  const forgotPasswordRoute = pathname === "/forgot-password";
  const resetPasswordRoute = pathname === "/reset-password";
  const accountSetupRoute = pathname === "/account-setup";
  const loginRoute = pathname === "/login";

  // Auth entry and recovery routes must work before an app session exists.
  if (callbackRoute || forgotPasswordRoute || resetPasswordRoute || accountSetupRoute) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  let supabaseResponse = NextResponse.next({ request: { headers: request.headers } });
  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return loginRoute ? supabaseResponse : redirectWithCookies(new URL("/login", requestOrigin), supabaseResponse);
  }

  const membership = await supabase.from("app_members").select("id").eq("user_id", user.id).eq("active", true).maybeSingle();
  if (membership.error || !membership.data) {
    await supabase.auth.signOut();
    const deniedUrl = new URL("/login", requestOrigin);
    deniedUrl.searchParams.set("error", "access_denied");
    return redirectWithCookies(deniedUrl, supabaseResponse);
  }

  if (loginRoute) return redirectWithCookies(new URL("/", requestOrigin), supabaseResponse);
  return supabaseResponse;
}

function redirectWithCookies(url: URL, source: NextResponse) {
  const redirect = NextResponse.redirect(url);
  source.cookies.getAll().forEach(({ name, value, ...options }) => redirect.cookies.set(name, value, options));
  return redirect;
}
