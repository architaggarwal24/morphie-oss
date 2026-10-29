"use client";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { useRevalidate } from "@/lib/revalidate";
import { PUBLIC_TAB, useStore } from "@/lib/store";
import { ChatView } from "./chat/ChatView";
import { CommandPalette } from "./CommandPalette";
import { AUTH_ERRORS, LoginDialog } from "./LoginDialog";
import { DesignView } from "./design/DesignView";
import { DocumentsView } from "./library/DocumentsView";
import { MemoryView } from "./library/MemoryView";
import { Rail } from "./Rail";
import { SettingsView } from "./settings/SettingsView";
import { ConversationSidebar, DesignSidebar } from "./Sidebar";
import { Toasts } from "./Toasts";
import { Aurora, Orb } from "./fx";
import { Button, Logo } from "./ui";

export default function App() {
  const ready = useStore((s) => s.ready);
  const session = useStore((s) => s.session);
  const loadError = useStore((s) => s.loadError);
  const boot = useStore((s) => s.boot);
  const storedTab = useStore((s) => s.tab);
  const loginOpen = useStore((s) => s.loginOpen);
  const toast = useStore((s) => s.toast);
  // Until someone has logged in, Chat is the only tab there is, whatever the stored value says.
  const tab = session ? storedTab : PUBLIC_TAB;
  const activeConv = useStore((s) => s.activeConv);
  const loaded = useStore((s) => s.messages);
  const loadMessages = useStore((s) => s.loadMessages);
  const setPalette = useStore((s) => s.setPalette);

  useEffect(() => { void boot(); }, [boot]);

  // Back from a failed Google/GitHub login: say why, and clear it from the address bar.
  useEffect(() => {
    if (!ready) return; // after boot, so the tab it picks doesn't override the one chosen here
    const q = new URLSearchParams(location.search);
    const err = q.get("auth_error");
    const linked = q.get("linked");
    if (!err && !linked) return;
    if (err) toast("error", AUTH_ERRORS[err] ?? AUTH_ERRORS.provider_error);
    // Back from Account → Connect: say so and land on the Account page again.
    if (linked === "google" || linked === "github") {
      toast("ok", `${linked === "google" ? "Google" : "GitHub"} is connected. You can use it to sign in.`);
      useStore.setState({ tab: "settings", settingsSection: "account" });
    }
    history.replaceState(null, "", location.pathname);
  }, [toast, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (!useStore.getState().loginOpen) setPalette(!useStore.getState().paletteOpen); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  // Whenever a conversation becomes active (opened, or its tab revisited) show the cached history at once and refetch it
  // in the background. Not mid-run: the live view owns it then, and refetching would show the user's message twice.
  const id = tab === "chat" ? activeConv.chat : tab === "agent" ? activeConv.agent : null;
  const runningId = useStore((s) => s.run?.convId ?? null);
  useEffect(() => { if (id && id !== useStore.getState().run?.convId) void loadMessages(id); }, [id, loadMessages]);
  // A history never loaded yet (e.g. the run that created it was the only thing showing it) still loads once the run ends.
  useEffect(() => { if (id && id !== runningId && !loaded[id]) void loadMessages(id); }, [id, runningId, loaded, loadMessages]);
  // Stale-while-revalidate: coming back to the window or back online quietly refreshes what's on screen.
  useRevalidate(() => useStore.getState().revalidate(), !!session);

  if (loadError) {
    return (
      <div className="grid h-dvh place-items-center p-6">
        <Aurora />
        <div className="glass relative max-w-sm rounded-3xl border border-line p-8 text-center shadow-pop">
          <AlertTriangle className="mx-auto size-8 text-err" aria-hidden />
          <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">Can't reach Morphie</h1>
          <p className="mt-2 text-sm text-muted">{loadError}</p>
          <Button className="mt-5" variant="primary" onClick={() => void boot()}><RefreshCw className="size-4" aria-hidden /> Try again</Button>
        </div>
      </div>
    );
  }
  if (!ready) {
    return <div className="grid h-dvh place-items-center"><Aurora /><div className="relative flex flex-col items-center gap-5"><Logo className="size-14 drop-shadow-[0_10px_30px_rgb(var(--accent)/0.5)]" /><Orb working className="size-6" /><span className="sr-only" role="status">Loading</span></div></div>;
  }

  return (
    // Motion follows the OS "reduce motion" setting everywhere: springs become instant, nothing moves on its own.
    <MotionConfig reducedMotion="user">
      <Aurora />
      {/* While the login popup is open the page behind it is inert: not clickable, not focusable, hidden from assistive tech. */}
      <div inert={loginOpen} className="relative z-[1] flex h-dvh overflow-hidden pt-safe px-safe">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
        <Rail />
        {(tab === "chat" || tab === "agent") && <ConversationSidebar mode={tab} />}
        {tab === "design" && <DesignSidebar />}
        <main id="main" className="flex min-w-0 flex-1 flex-col pb-[calc(4rem_+_var(--safe-bottom))] md:pb-safe">
          {tab === "chat" && <ChatView key="chat" mode="chat" />}
          {tab === "agent" && <ChatView key="agent" mode="agent" />}
          {tab === "design" && <DesignView />}
          {tab === "documents" && <DocumentsView />}
          {tab === "memory" && <MemoryView />}
          {tab === "settings" && <SettingsView />}
        </main>
        <CommandPalette />
      </div>
      <LoginDialog />
      <Toasts />
    </MotionConfig>
  );
}
