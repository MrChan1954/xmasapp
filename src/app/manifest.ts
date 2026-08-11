import type { MetadataRoute } from "next";

/**
 * Served at `/manifest.webmanifest`. This is what turns the site into an
 * installable app on Android and gives iOS its Home Screen presentation.
 *
 * `theme_color` and `background_color` can only hold one value each, so they
 * cannot follow the system theme. They use the light ground, which is what the
 * Android splash screen and task switcher show. The *running* app's status bar
 * still follows the media-scoped `<meta name="theme-color">` pair already
 * emitted from `layout.tsx`, so dark mode stays correct once the app is open.
 *
 * `orientation` is deliberately omitted: locking it would fight tablet and
 * desktop installs, and nothing here needs a fixed orientation.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Christmas Budget",
    short_name: "Christmas Budget",
    description: "A simple Christmas gift budget planner.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbf8f3",
    theme_color: "#fbf8f3",
    categories: ["finance", "lifestyle", "productivity"],
    icons: [
      // `any` renders as-drawn; the platform does not crop it.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // `maskable` is cropped to a circle or squircle, so these are drawn
      // smaller inside a full-bleed tile. Both purposes are supplied separately
      // rather than as "any maskable" on one file, which would force one
      // compromise to serve both.
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
