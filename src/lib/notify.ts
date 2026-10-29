/**
 * Tell the user when a run needs them or has finished while they're in another tab: a soft chime, a desktop
 * notification (if they allowed it) and a dot in the tab title until they come back. Nothing happens while the tab
 * is visible: they can already see it.
 */

export interface NotifyPrefs { sound: boolean; desktop: boolean }
export type NotifyKind = "done" | "paused" | "error" | "approval" | "question";

const KEY = "morphie.notify";
const DEFAULTS: NotifyPrefs = { sound: true, desktop: true };

export function getNotifyPrefs(): NotifyPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<NotifyPrefs>) : {};
    return { sound: v.sound ?? DEFAULTS.sound, desktop: v.desktop ?? DEFAULTS.desktop };
  } catch { return { ...DEFAULTS }; }
}

export function setNotifyPrefs(p: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...getNotifyPrefs(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: keep it for this page */ }
  return next;
}

export function desktopPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Ask for desktop notifications (call from a click: browsers ignore it otherwise). */
export async function askDesktopPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** What each event says. */
export function notifyText(kind: NotifyKind, title?: string): { title: string; body: string } {
  const task = title && title !== "New conversation" ? `“${title}”` : "Your task";
  switch (kind) {
    case "done": return { title: "Morphie finished", body: `${task} is done.` };
    case "paused": return { title: "Morphie paused", body: `${task} paused. Press Continue to pick it up.` };
    case "error": return { title: "Morphie hit a problem", body: `${task} stopped with an error.` };
    case "approval": return { title: "Morphie needs your OK", body: `${task} is waiting for your approval.` };
    case "question": return { title: "Morphie has a question", body: `${task} is waiting for your answers.` };
  }
}

let audio: AudioContext | null = null;
/** Two soft notes, rising for "done", a single repeated one for "needs you". */
function chime(kind: NotifyKind): void {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const ctx = audio;
    const notes = kind === "done" ? [659.25, 987.77] : kind === "error" || kind === "paused" ? [523.25, 392] : [880, 880];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch { /* no audio: the notification is enough */ }
}

let baseTitle: string | null = null;
function markTitle(): void {
  if (typeof document === "undefined" || baseTitle !== null) return;
  baseTitle = document.title;
  document.title = `● ${baseTitle}`;
  const restore = () => {
    if (document.hidden) return;
    if (baseTitle !== null) document.title = baseTitle;
    baseTitle = null;
    document.removeEventListener("visibilitychange", restore);
  };
  document.addEventListener("visibilitychange", restore);
}

/** Notify about a run event, only while the tab is hidden. Returns whether it did. */
export function notifyRun(kind: NotifyKind, convTitle?: string): boolean {
  if (typeof document === "undefined" || !document.hidden) return false;
  const prefs = getNotifyPrefs();
  markTitle();
  if (prefs.sound) chime(kind);
  if (prefs.desktop && desktopPermission() === "granted") {
    try {
      const { title, body } = notifyText(kind, convTitle);
      const n = new Notification(title, { body, tag: "morphie-run", icon: "/icon.svg" });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
  return true;
}
