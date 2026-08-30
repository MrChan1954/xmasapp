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
    // `id` is the app's identity and stays "/". Renaming with the id fixed
    // relabels the existing installation rather than offering a second one.
    id: "/",
    name: "Gift Planner",
    short_name: "Gift Planner",
    description: "Plan and share the cost of Christmas, birthdays and every other family occasion.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbf8f3",
    theme_color: "#fbf8f3",
    categories: ["finance", "lifestyle", "productivity"],
    /*
     * `-v2` BECAUSE A LAUNCHER ICON IS NOT AN HTTP CACHE. These paths are not
     * content-hashed — `public/_headers` caps them at a day for exactly that
     * reason — but Android copies the icon at install time and can keep it
     * until the manifest names a DIFFERENT URL. The app's identity changed from
     * the Christmas tree to the gift-and-checklist tile, so the filenames
     * changed with it and every installation picks the new one up.
     */
    icons: [
      // `any` renders as-drawn; the platform does not crop it.
      { src: "/icons/icon-192-v2.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-v2.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // `maskable` is cropped to a circle or squircle, so these keep the
      // artwork inset inside a full-bleed tile — the master file's own framing,
      // which puts the furthest green pixel at 65% of the half-width against a
      // safe circle of 80%. Both purposes are supplied separately rather than
      // as "any maskable" on one file, which would force one compromise to
      // serve both.
      { src: "/icons/maskable-192-v2.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
