"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFamily } from "../family-context";

export function AppNav() {
  const pathname = usePathname();
  const { isAdmin } = useFamily();
  const moreHref = "/more";
  const linkClass = (active: boolean) => `block rounded-xl border px-3 py-3 text-sm transition ${active ? "border-white/15 bg-white/12 font-bold text-white shadow-sm" : "border-transparent font-semibold text-[#cbdad5] hover:bg-white/8 hover:text-white"}`;

  return <>
    <aside className="hidden w-64 shrink-0 border-r border-[#c5a65a]/35 bg-[#103f36] px-5 py-8 lg:flex lg:flex-col">
      <div className="px-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#c5a65a] text-xl text-[#103f36] shadow-sm" aria-hidden>✦</span>
        <p className="mt-4 text-2xl font-bold text-white">Christmas Budget</p>
        <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#d8c383]">Family planner</p>
      </div>
      <nav className="mt-10 space-y-2">
        <Link href="/" className={linkClass(pathname === "/")}>Home</Link>
        <Link href="/people" className={linkClass(pathname.startsWith("/people"))}>People</Link>
        <Link href="/add-purchase" className={linkClass(pathname.startsWith("/add-purchase"))}>Add Purchase</Link>
        <Link href="/owed" className={linkClass(pathname.startsWith("/owed"))}>Owed</Link>
        <Link href={moreHref} className={linkClass(pathname.startsWith("/more") || pathname.startsWith("/account") || pathname.startsWith("/payment-log"))}>More</Link>
      </nav>
      {isAdmin && <p className="mt-auto rounded-xl border border-[#d8c383]/35 bg-[#0b352e] px-3 py-2 text-xs font-semibold text-[#ead89e]">Global Admin</p>}
    </aside>
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-end justify-around border-t border-[#d9d7cd] bg-[#fffefb]/95 px-2 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 text-[10px] font-bold shadow-[0_-8px_30px_rgba(16,63,54,0.08)] backdrop-blur lg:hidden">
      <Link className={pathname === "/" ? "text-[#174f45]" : "text-[#7d8783]"} href="/">Home</Link>
      <Link className={pathname.startsWith("/people") ? "text-[#174f45]" : "text-[#7d8783]"} href="/people">People</Link>
      <Link href="/add-purchase" aria-label="Add purchase" className={`-mt-8 rounded-full border-4 border-[#fffefb] bg-[#c5a65a] px-5 py-4 text-sm text-[#103f36] shadow-lg ${pathname.startsWith("/add-purchase") ? "ring-2 ring-[#174f45]/30" : ""}`}>+ <small>Add</small></Link>
      <Link className={`pb-1 ${pathname.startsWith("/owed") ? "text-[#174f45]" : "text-[#7d8783]"}`} href="/owed">Owed</Link>
      <Link className={pathname.startsWith("/more") || pathname.startsWith("/account") || pathname.startsWith("/payment-log") ? "text-[#174f45]" : "text-[#7d8783]"} href={moreHref}>More</Link>
    </nav>
  </>;
}
