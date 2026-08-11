<<<<<<< HEAD
import type { Metadata } from "next";
import "./globals.css";
import { FamilyProvider } from "./family-context";
=======
import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { FamilyProvider } from "./family-context";
import { AppFrame } from "./components/app-frame";
import { FestiveProvider } from "./components/festive/festive-context";
import { ThemeProvider } from "./components/theme-provider";

/**
 * The two meta tags below are media-scoped, so the browser picks the matching
 * colour straight from the OS preference. That is the whole story now the app
 * has no manual theme override — nothing needs to rewrite them at runtime.
 */
const THEME_COLORS = { light: "#fbf8f3", dark: "#0c1211" } as const;

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
});
>>>>>>> 7534a2d (redesign and realtime)

export const metadata: Metadata = {
  title: "Christmas Budget",
  description: "A simple Christmas gift budget planner.",
};

<<<<<<< HEAD
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col"><FamilyProvider>{children}</FamilyProvider></body>
=======
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * <html> deliberately carries no utility classes: next-themes owns its
 * className, and React's dev Strict Mode remount resets <html> attributes to
 * exactly what appears in JSX — which would wipe the theme class set by the
 * pre-paint script. Font variables and `antialiased` live on <body> instead;
 * the --font-* custom properties inherit, so `font-sans`/`font-display` still
 * resolve everywhere. `h-full` moved to `html { height: 100% }` in globals.css.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${fraunces.variable} flex min-h-full flex-col antialiased`}>
        <ThemeProvider>
          <FestiveProvider>
            <FamilyProvider>
              <AppFrame>{children}</AppFrame>
            </FamilyProvider>
          </FestiveProvider>
        </ThemeProvider>
      </body>
>>>>>>> 7534a2d (redesign and realtime)
    </html>
  );
}
