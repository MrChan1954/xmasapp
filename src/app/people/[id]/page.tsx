import { redirectLegacyRoute } from "@/utils/supabase/events-server";
import { loadPersonProfile } from "@/utils/supabase/people-server";
import { PersonProfileScreen } from "./person-profile-screen";

export const dynamic = "force-dynamic";

/**
 * One person's profile: who they are, and what has been bought for them.
 *
 * THE ID IN THIS URL USED TO MEAN SOMETHING ELSE. Until now `/people/<id>` only
 * ever forwarded to the Christmas People screen, and the id was a
 * `christmas_recipients` id from a pre-Checkpoint-2 notification. Both meanings
 * are served: a person id resolves to the profile, and anything else falls
 * through to the redirect it always had. The two id spaces cannot collide, so
 * trying the profile first costs one lookup and breaks no saved link.
 *
 * `loadPersonProfile` returns null for an unknown person AND for a reader who
 * is not an active member, on purpose -- telling somebody "that person exists
 * but is not yours to see" is itself a disclosure.
 */
export default async function PersonPage({ params }: PageProps<"/people/[id]">) {
  const { id } = await params;
  const profile = await loadPersonProfile(id);
  if (!profile) return redirectLegacyRoute("people", `?person=${encodeURIComponent(id)}`);

  return (
    <PersonProfileScreen
      person={profile.person}
      history={profile.history}
      isSelf={profile.isSelf}
      isAdmin={profile.isAdmin}
      canEditBirthdays={profile.canEditBirthdays}
      today={profile.today}
    />
  );
}
