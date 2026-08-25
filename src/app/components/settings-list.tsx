"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The shared hairline settings row, extracted from the More screen so the three
 * scoped Settings pages cannot drift into three different-looking lists.
 */
export function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">{label}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsRow({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group mb-3 flex items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card transition last:mb-0 hover:border-line-strong"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-lg font-semibold">{title}</span>
        <span className="mt-0.5 block text-sm leading-6 text-ink-600">{description}</span>
      </span>
    </Link>
  );
}
