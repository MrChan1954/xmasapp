import { redirect } from "next/navigation";

/**
 * `/events` is an alias. The dashboard itself lives at `/`, which is the PWA's
 * start URL, so this exists only so that a guessed or typed `/events` lands in
 * the right place.
 */
export default function EventsIndexRedirect(): never {
  redirect("/");
}
