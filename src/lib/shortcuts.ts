/**
 * Keyboard shortcuts in one place, so menus, tooltips, the command palette and Settings all show the same keys:
 * ⌘ on Apple platforms, Ctrl everywhere else.
 */
export interface Shortcut { key: string; mod?: boolean; shift?: boolean }

export const SHORTCUTS = {
  palette: { key: "k", mod: true },
  undo: { key: "z", mod: true },
  redo: { key: "z", mod: true, shift: true },
  send: { key: "Enter" },
  newline: { key: "Enter", shift: true },
  close: { key: "Escape" },
} satisfies Record<string, Shortcut>;

export function isApple(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav?.platform || nav?.userAgent || "");
}

const NAMES: Record<string, string> = { Enter: "Enter", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓" };
const keyName = (k: string) => NAMES[k] ?? k.toUpperCase();

/** The keys to draw as <Kbd> chips, e.g. ["⌘", "⇧", "Z"] on a Mac and ["Ctrl", "Shift", "Z"] elsewhere. */
export function shortcutKeys(s: Shortcut, apple = isApple()): string[] {
  return [...(s.mod ? [apple ? "⌘" : "Ctrl"] : []), ...(s.shift ? [apple ? "⇧" : "Shift"] : []), keyName(s.key)];
}

/** One string for a tooltip: "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function shortcutLabel(s: Shortcut, apple = isApple()): string {
  return shortcutKeys(s, apple).join(apple ? "" : "+");
}

/** The aria-keyshortcuts value, which names real modifier keys ("Meta+Z", "Control+Shift+Z"). */
export function ariaShortcut(s: Shortcut, apple = isApple()): string {
  return [...(s.mod ? [apple ? "Meta" : "Control"] : []), ...(s.shift ? ["Shift"] : []), s.key.length === 1 ? s.key.toUpperCase() : s.key].join("+");
}

/** Whether a keydown is this shortcut. The modifier is ⌘ on Apple platforms and Ctrl elsewhere, never both. */
export function matches(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, s: Shortcut, apple = isApple()): boolean {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key.toLowerCase() === s.key.toLowerCase() && !!s.mod === (s.mod ? mod : false) && (s.mod || (!e.metaKey && !e.ctrlKey)) && !!s.shift === e.shiftKey && !e.altKey;
}

/** True while someone is typing: single-key and editing shortcuts (like ⌘Z) must leave fields alone. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(t.type);
  return false;
}
