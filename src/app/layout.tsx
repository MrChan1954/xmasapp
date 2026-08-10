import type { Metadata } from "next";
import "./globals.css";
import { FamilyProvider } from "./family-context";

export const metadata: Metadata = {
  title: "Christmas Budget",
  description: "A simple Christmas gift budget planner.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col"><FamilyProvider>{children}</FamilyProvider></body>
    </html>
  );
}
