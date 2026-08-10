import { AppNav } from "../../components/app-nav";

export default function FamilyAccessLoading() {
  return (
    <main className="flex min-h-screen bg-[#f8f8f6] text-[#1d2926]">
      <AppNav />
      <div className="min-w-0 flex-1 pb-24 lg:pb-0">
      <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8 lg:px-12">
        <div className="h-4 w-28 animate-pulse rounded bg-[#e6ebe8]" />
        <div className="mt-5 h-10 w-64 animate-pulse rounded-lg bg-[#e6ebe8]" />
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="h-52 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
      </div>
      </div>
    </main>
  );
}
