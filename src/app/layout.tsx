import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { FamilyProvider } from "./family-context";
import { AppFrame } from "./components/app-frame";
import { PwaRuntime } from "./components/pwa-runtime";
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

export const metadata: Metadata = {
  title: "Family Gift Planner",
  description: "Plan and share the cost of Christmas, birthdays and every other family occasion.",
  manifest: "/manifest.webmanifest",
  /**
   * `statusBarStyle` is "default", not "black-translucent", on purpose. The
   * viewport below already sets `viewport-fit: cover`; adding
   * "black-translucent" would extend the web view under the status bar AND
   * force light status-bar text, which is unreadable against this app's cream
   * `#fbf8f3` light theme. "default" lets iOS tint the bar from the
   * media-scoped `theme-color` pair, which is already correct in both themes.
   *
   * No `startupImage`: that needs ~20 device-specific splash PNGs, and modern
   * iOS composes a launch screen from the manifest's `background_color` and
   * icon instead.
   *
   * The icon <link> tags are not declared here — `icon.png`, `apple-icon.png`
   * and `favicon.ico` in this directory generate them automatically, with the
   * sizes read from the files.
   */
  appleWebApp: {
    capable: true,
    title: "Family Gift Planner",
    statusBarStyle: "default",
  },
};

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
          <PwaRuntime />
          <FestiveProvider>
            <FamilyProvider>
              <AppFrame>{children}</AppFrame>
            </FamilyProvider>
          </FestiveProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
