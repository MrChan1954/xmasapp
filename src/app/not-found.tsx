import { ButtonLink, EmptyState } from "./components/ui";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-5 py-16 text-ink-900">
      <EmptyState
        className="w-full max-w-lg"
        illustration="sleigh"
        title="This page went missing"
        body="The link may be out of date, or the page may have moved."
        action={<ButtonLink href="/" size="lg">Back to the dashboard</ButtonLink>}
      />
    </main>
  );
}
