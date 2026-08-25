import { createBrowserClient } from "@supabase/ssr";
import { AREA_COOKIE } from "@/lib/areas";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * The Area cookie, read where the browser keeps it.
 *
 * Deliberately not httpOnly (see `api/areas/route.ts`): it is a preference, and
 * the database ignores one that names a family the caller is not in.
 */
function activeAreaId(): string | null {
  if (typeof document === "undefined") return null;
  const found = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${AREA_COOKIE}=`));
  return found ? decodeURIComponent(found.slice(AREA_COOKIE.length + 1)) : null;
}

/**
 * READ ONCE, AT CREATION. A client is made per component, so switching family
 * -- which reloads the page -- gets a fresh one with the new header. Reading it
 * per request instead would let a half-torn-down screen from the previous family
 * fetch under the new one's Area.
 */
export const createClient = () => {
  const area = activeAreaId();
  return createBrowserClient(supabaseUrl!, supabaseKey!,
    area ? { global: { headers: { "x-area-id": area } } } : undefined);
};
