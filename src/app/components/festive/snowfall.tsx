"use client";

import { memo, useEffect, useState } from "react";
import { cx } from "../cx";
import { useFestive } from "./festive-context";

/**
 * Three compositor-animated texture layers, memoised with no changing props so
 * a parent re-render (the dashboard reloads from Supabase on mount) never
 * touches them. Everything visual lives in globals.css — including the
 * reduced-motion rule that removes the layers outright rather than freezing
 * them mid-fall.
 */
function SnowfallImpl({ density = "full" }: { density?: "light" | "full" }) {
  const { snow } = useFestive();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!snow) return null;

  return (
    <div aria-hidden className={cx("snow", paused && "snow-paused")}>
      <div className="snow-layer snow-1" />
      <div className="snow-layer snow-2" />
      {density === "full" && <div className="snow-layer snow-3" />}
    </div>
  );
}

export const Snowfall = memo(SnowfallImpl);
