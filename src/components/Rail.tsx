"use client";
import { Bot, Brain, KeyRound, Library, Lock, LogIn, LogOut, MessagesSquare, Monitor, Moon, Search, Settings, Sun, UserRound, WandSparkles, type LucideIcon } from "lucide-react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";
import { api } from "@/lib/api";
import { ariaShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { PUBLIC_TAB, useStore, type Tab } from "@/lib/store";
import { Avatar, KeyCombo, Logo, Tip, cn } from "./ui";

export const NAV: Array<{ tab: Tab; label: string; icon: LucideIcon }> = [
  { tab: "chat", label: "Chat", icon: MessagesSquare },
  { tab: "agent", label: "Agent", icon: Bot },
  { tab: "design", label: "Design", icon: WandSparkles },
  { tab: "documents", label: "Documents", icon: Library },
  { tab: "memory", label: "Memory", icon: Brain },
];

const PILL_SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/**
 * The icon grows as the pointer passes over the dock (macOS-style), computed from the pointer's distance to this
 * item. Only the icon scales, never the button, so nothing reflows and the hit area stays put.
 */
function DockIcon({ pointerY, children, active }: { pointerY: MotionValue<number>; children: React.ReactNode; active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const distance = useTransform(pointerY, (y) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? y - (r.top + r.height / 2) : Infinity;
  });
  const scale = useSpring(useTransform(distance, [-110, 0, 110], [1, 1.32, 1], { clamp: true }), { stiffness: 380, damping: 26 });
  return (
    <motion.span ref={ref} style={reduce ? undefined : { scale }} className={cn("relative grid size-9 place-items-center rounded-xl transition-colors", active && "text-accent")}>
      {children}
    </motion.span>
  );
}

function UserMenu() {
  const session = useStore((s) => s.session)!;
  const { setTab, setSettingsSection, setTheme, theme } = useStore();
  const go = (section: string) => { setTab("settings"); setSettingsSection(section); };
  const signOut = async () => { try { await api("/api/auth/logout", { method: "POST" }); } finally { location.reload(); } };
  const item = "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-hidden transition-colors data-[highlighted]:bg-raised data-[highlighted]:text-fg pointer-coarse:min-h-11";
  return (
    <DropdownMenu.Root>
      <Tip side="right" content="Account">
        <DropdownMenu.Trigger aria-label={`Account menu for ${session.user.displayName ?? session.user.email ?? "you"}`} className="rounded-full outline-offset-4 transition hover:scale-105 active:scale-95">
          <Avatar name={session.user.displayName} email={session.user.email} />
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="right" align="end" sideOffset={12} className="menu z-[70] w-64 rounded-2xl border border-line bg-panel/95 p-1.5 text-muted shadow-pop backdrop-blur-xl">
          <div className="flex items-center gap-3 px-2.5 pb-2.5 pt-2">
            <Avatar name={session.user.displayName} email={session.user.email} className="size-10" />
            <div className="min-w-0"><div className="truncate text-sm font-semibold text-fg">{session.user.displayName ?? "Your account"}</div><div className="truncate text-xs">{session.user.email}</div></div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={item} onSelect={() => go("account")}><UserRound className="size-4" aria-hidden /> Account</DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => go("account")}><KeyRound className="size-4" aria-hidden /> Password &amp; sign-in</DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => go("providers")}><Settings className="size-4" aria-hidden /> Settings</DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)} className="flex gap-1 px-1 py-1" aria-label="Theme">
            {([["system", Monitor], ["light", Sun], ["dark", Moon]] as const).map(([v, Icon]) => (
              <DropdownMenu.RadioItem key={v} value={v} aria-label={`${v} theme`} className="grid h-9 flex-1 cursor-pointer place-items-center rounded-lg outline-hidden transition-colors data-[highlighted]:bg-raised data-[state=checked]:bg-accent/15 data-[state=checked]:text-accent"><Icon className="size-4" aria-hidden /></DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={cn(item, "data-[highlighted]:text-err")} onSelect={() => void signOut()}><LogOut className="size-4" aria-hidden /> Sign out</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Rail() {
  const { tab, setTab, theme, setTheme, run, openLogin, setPalette } = useStore();
  const loggedIn = useStore((s) => !!s.session);
  const hasDraft = useStore((s) => s.drafts.chat.trim().length > 0);
  const working = !!run && (run.status === "running" || run.status === "waiting" || run.status === "connecting");
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const ThemeIcon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
  const pointerY = useMotionValue(Infinity);

  const item = (t: Tab, label: string, Icon: LucideIcon, mobile = false) => {
    // A visitor only has Chat. The other tabs are still listed, marked as needing a login, and clicking one opens the popup instead of switching.
    const locked = !loggedIn && t !== PUBLIC_TAB;
    const active = loggedIn ? tab === t : t === PUBLIC_TAB;
    const icon = <Icon className="relative size-[19px]" aria-hidden />;
    return (
      <button key={t} onClick={(e) => setTab(t, e.currentTarget)} aria-current={active ? "page" : undefined} aria-haspopup={locked ? "dialog" : undefined}
        className={cn("group relative flex flex-col items-center justify-center rounded-2xl text-[10px] transition-colors", mobile ? "h-full flex-1 gap-0.5" : "size-[56px] gap-1", active ? "text-fg" : "text-muted hover:bg-fg/[0.05] hover:text-fg")}>
        {/* The active pill slides between tabs on a spring (Motion layoutId), so a quick double switch just turns it around. */}
        {active && <motion.span data-tab-marker aria-hidden layoutId={mobile ? "tab-pill-mobile" : "tab-pill"} transition={PILL_SPRING}
          className={cn("absolute rounded-2xl bg-accent/12 ring-1 ring-accent/25 shadow-[0_0_24px_-6px_rgb(var(--accent)/0.55)]", mobile ? "inset-x-1.5 inset-y-1" : "inset-0")} />}
        {mobile ? <span className={cn("relative grid h-7 w-12 place-items-center", active && "text-accent")}>{icon}</span> : <DockIcon pointerY={pointerY} active={active}>{icon}</DockIcon>}
        <span className="relative font-medium">{label}{locked && <>{" "}<span className="sr-only">(log in required)</span></>}</span>
        {locked && <Lock className="absolute right-2.5 top-1.5 size-3 text-faint" aria-hidden />}
        {(t === "chat" || t === "agent") && working && run?.mode === t && <span className="absolute right-2 top-1.5 size-2 animate-pulse-dot rounded-full bg-ok shadow-[0_0_8px_rgb(var(--ok))]" aria-label="Working" />}
      </button>
    );
  };

  // Replaces Settings until there is an account to have settings.
  const loginItem = (mobile = false) => (
    <button key="login" onClick={(e) => openLogin({ tab: hasDraft ? PUBLIC_TAB : null, trigger: e.currentTarget })} aria-haspopup="dialog"
      className={cn("relative flex flex-col items-center justify-center rounded-2xl text-[10px] text-accent transition hover:bg-accent/10", mobile ? "h-full flex-1 gap-0.5" : "size-[56px] gap-1")}>
      <span className="grid size-7 place-items-center"><LogIn className="size-[19px]" aria-hidden /></span>
      <span className="text-balance text-center font-semibold leading-tight">Login / Sign up</span>
    </button>
  );

  const last = (mobile: boolean) => (loggedIn ? item("settings", "Settings", Settings, mobile) : loginItem(mobile));
  const tool = "grid size-10 place-items-center rounded-xl text-muted transition hover:bg-fg/[0.07] hover:text-fg active:scale-90 pointer-coarse:size-11";

  return (
    <>
      <nav aria-label="Primary" onPointerMove={(e) => pointerY.set(e.clientY)} onPointerLeave={() => pointerY.set(Infinity)}
        className="glass relative z-20 hidden w-[80px] shrink-0 flex-col items-center gap-1.5 border-r border-line pt-4 pb-[calc(1rem_+_var(--safe-bottom))] md:flex">
        <motion.div className="mb-4" whileHover={{ rotate: -8, scale: 1.06 }} whileTap={{ scale: 0.94 }} transition={PILL_SPRING}><Logo className="size-10 drop-shadow-[0_6px_18px_rgb(var(--accent)/0.45)]" /></motion.div>
        {NAV.map((n) => item(n.tab, n.label, n.icon))}
        <div className="mt-auto flex flex-col items-center gap-1.5">
          <Tip side="right" content={<>Search and commands <KeyCombo shortcut={SHORTCUTS.palette} /></>}>
            <button onClick={() => setPalette(true)} aria-haspopup="dialog" aria-keyshortcuts={ariaShortcut(SHORTCUTS.palette)} aria-label="Search and commands" className={tool}><Search className="size-[18px]" aria-hidden /></button>
          </Tip>
          <Tip side="right" content={`Theme: ${theme}`}>
            <button onClick={() => setTheme(nextTheme)} aria-label={`Theme: ${theme}. Switch to ${nextTheme}`} className={tool}><ThemeIcon className="size-[18px]" /></button>
          </Tip>
          {last(false)}
          {loggedIn && <div className="mt-1"><UserMenu /></div>}
        </div>
      </nav>
      <nav aria-label="Primary" className="glass fixed inset-x-0 bottom-0 z-30 flex h-[calc(4rem_+_var(--safe-bottom))] items-stretch border-t border-line pb-safe pl-[calc(0.25rem_+_var(--safe-left))] pr-[calc(0.25rem_+_var(--safe-right))] md:hidden">
        {NAV.map((n) => item(n.tab, n.label, n.icon, true))}
        {last(true)}
      </nav>
    </>
  );
}
