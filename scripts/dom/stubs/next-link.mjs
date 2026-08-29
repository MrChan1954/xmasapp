/**
 * `next/link`, for the DOM suite only.
 *
 * Next 16 resolves `next/link` through its bundler, not through plain Node
 * resolution, so importing the shared UI module outside a Next build fails on
 * that one import. What these tests care about is that a link-shaped control
 * renders a real <a> with a real href — the routing behind it is Next's
 * business and is exercised in the browser, not here.
 */
import { createElement, forwardRef } from "react";

const Link = forwardRef(function Link({ href, children, ...rest }, ref) {
  return createElement("a", { ...rest, ref, href: typeof href === "string" ? href : "#" }, children);
});

export default Link;
