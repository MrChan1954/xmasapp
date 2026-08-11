import { redirect } from "next/navigation";

/**
 * This route used to render a second, parallel person detail screen that
 * bypassed the app shell, hand-rolled its own modal and contributor editor, and
 * reported Spent as £0. `/people` opens the real person modal instead, so the
 * deep link is preserved by forwarding to it.
 */
export default async function PersonRedirect({ params }: PageProps<"/people/[id]">) {
  const { id } = await params;
  redirect(`/people?person=${encodeURIComponent(id)}`);
}
