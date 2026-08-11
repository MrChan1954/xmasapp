import { AppShell } from "../../components/app-shell";
import { Skeleton } from "../../components/ui";

export default function FamilyAccessLoading() {
  return (
    <AppShell>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-5 h-10 w-64" />
      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton key={item} className="h-52 rounded-2xl" />
        ))}
      </div>
    </AppShell>
  );
}
