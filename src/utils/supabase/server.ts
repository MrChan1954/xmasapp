import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = async () => {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(cookiesToSet) {
        /**
         * A Server Component cannot set cookies, so this throws there and the
         * write is dropped. That is expected and safe.
         *
         * There is NO middleware in this app — Next 16's Node-runtime proxy
         * does not run on Cloudflare Workers, so the refresh-on-every-request
         * pattern is unavailable. Sessions are refreshed by the BROWSER client
         * (`utils/supabase/client.ts`), which owns the auth cookie, runs
         * `autoRefreshToken`, and persists the rotated token itself. Route
         * Handlers and Server Actions can still write cookies, so the refresh
         * this drops is only ever one a Server Component attempted, and the
         * next client-side call re-establishes it.
         *
         * None of this is the security boundary. Every row is behind RLS and
         * every privileged route re-authorizes independently, so a stale or
         * missing cookie fails closed — it cannot widen access.
         */
        try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch { /* Server Components cannot write cookies; see above. */ }
      },
    },
  });
};
