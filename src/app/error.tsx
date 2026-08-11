"use client";

import { useEffect } from "react";
import { Button, ButtonLink, EmptyState } from "./components/ui";

/**
 * Note the prop is `retry`, not `reset` — that renaming is part of this
 * Next major version (see node_modules/next/dist/docs .../file-conventions/error.md).
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-5 py-16 text-ink-900">
      <EmptyState
        className="w-full max-w-lg"
        illustration="bauble"
        title="Something went wrong"
        body="That page could not be loaded. Trying again usually fixes it."
        action={
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" onClick={() => retry()}>Try again</Button>
            <ButtonLink href="/" variant="secondary" size="lg">Back to the dashboard</ButtonLink>
          </div>
        }
      />
    </main>
  );
}
