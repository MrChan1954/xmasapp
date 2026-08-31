import type { Metadata } from "next";
import type React from "react";

/**
 * The document title for a screen whose page is a client component, and
 * therefore cannot export one itself. `title` is a plain string rather than a
 * template, so the tab reads the screen rather than the application on the one
 * kind of screen somebody may be looking at for a while.
 */
export const metadata: Metadata = {
  title: "Create an account · Gift Planner",
  description: "Create a Gift Planner account.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
