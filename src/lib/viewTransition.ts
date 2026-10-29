"use client";
import { flushSync } from "react-dom";

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type StartViewTransition = (update: () => void) => unknown;

/**
 * Runs a same-page UI change inside document.startViewTransition, so the browser crossfades between the old and new
 * screens and morphs elements that share a view-transition-name. The update is flushed synchronously so the "after"
 * snapshot is the new screen. Without support, or with reduced motion, it is just the plain update.
 * Timing and the click-through rule live in globals.css (::view-transition-*).
 */
export function withViewTransition(update: () => void): void {
  const start = (typeof document !== "undefined" ? (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition : undefined);
  if (!start || prefersReducedMotion()) { update(); return; }
  start.call(document, () => flushSync(update));
}
