"use client";
import { useEffect, useRef } from "react";

/**
 * Stale-while-revalidate triggers: whatever is on screen is shown from memory straight away, and `fn` refetches it in
 * the background when the window regains focus, the tab becomes visible again, or the network comes back.
 * focus and visibilitychange usually fire together, so calls closer than `minGapMs` apart are folded into one.
 *
 * Only for data where a few seconds of staleness costs nothing (lists, history). Never for anything money-like.
 */
export function onRevalidate(fn: () => void, minGapMs = 2000): () => void {
  let last = 0;
  const run = () => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - last < minGapMs) return;
    last = now;
    fn();
  };
  window.addEventListener("focus", run);
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", run);
  return () => {
    window.removeEventListener("focus", run);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", run);
  };
}

/** Hook form of onRevalidate. `fn` may change every render; the listeners don't. */
export function useRevalidate(fn: () => void, enabled = true): void {
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });
  useEffect(() => (enabled ? onRevalidate(() => latest.current()) : undefined), [enabled]);
}
