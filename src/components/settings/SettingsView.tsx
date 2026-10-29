"use client";
import { BarChart3, Cpu, Database, Gem, Sparkles, KeyRound, Palette, ShieldCheck, SlidersHorizontal, UserRound, Wrench, type LucideIcon } from "lucide-react";
import { useStore } from "@/lib/store";
import { motion } from "motion/react";
import { cn } from "../ui";
import { AccountSection } from "./AccountSection";
import { AdminSection } from "./AdminSection";
import { PlanSection } from "./PlanSection";
import { RunnersSection } from "./RunnersSection";
import { AgentSection, AppearanceSection, DataSection, ToolsSection } from "./OtherSections";
import { ProvidersSection } from "./ProvidersSection";
import { SkillsSection } from "./SkillsSection";
import { UsageSection } from "./UsageSection";

export const SETTINGS_SECTIONS: Array<{ id: string; label: string; icon: LucideIcon; /** Only some servers or people have it. */ when?: "plans" | "admin" }> = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "plan", label: "Plan & credits", icon: Gem, when: "plans" },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "agent", label: "Chat & agent", icon: SlidersHorizontal },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "runners", label: "Runners", icon: Cpu },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "data", label: "Data & privacy", icon: Database },
  { id: "admin", label: "Admin", icon: ShieldCheck, when: "admin" },
];

/** The sections this person sees: Plan only on a server with plans, Admin only for admins. */
export function useSettingsSections() {
  const plans = useStore((s) => !!s.plan);
  const admin = useStore((s) => s.admin);
  return SETTINGS_SECTIONS.filter((s) => !s.when || (s.when === "plans" ? plans : admin));
}

export function SettingsView() {
  const { settingsSection, setSettingsSection } = useStore();
  const sections = useSettingsSections();
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Settings sections" className="glass shrink-0 border-b border-line md:w-60 md:border-b-0 md:border-r">
        <h1 className="hidden px-5 pb-2 pt-5 font-display text-2xl font-semibold tracking-tight md:block">Settings</h1>
        <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3">
          {sections.map((s) => (
            <li key={s.id}>
              <button onClick={() => setSettingsSection(s.id)} aria-current={settingsSection === s.id ? "page" : undefined} className={cn("relative z-0 flex w-full pointer-coarse:min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition-colors", settingsSection === s.id ? "font-medium text-fg" : "text-muted hover:bg-raised/50 hover:text-fg")}>
                {settingsSection === s.id && <motion.span layoutId="settings-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-xl bg-raised ring-1 ring-line shadow-card" />}
                <s.icon className={cn("size-4", settingsSection === s.id && "text-accent")} aria-hidden /> {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-10 animate-rise" key={settingsSection}>
          {settingsSection === "account" && <AccountSection />}
          {settingsSection === "providers" && <ProvidersSection />}
          {settingsSection === "agent" && <AgentSection />}
          {settingsSection === "tools" && <ToolsSection />}
          {settingsSection === "skills" && <SkillsSection />}
          {settingsSection === "usage" && <UsageSection />}
          {settingsSection === "appearance" && <AppearanceSection />}
          {settingsSection === "data" && <DataSection />}
          {settingsSection === "plan" && <PlanSection />}
          {settingsSection === "runners" && <RunnersSection />}
          {settingsSection === "admin" && <AdminSection />}
        </div>
      </div>
    </div>
  );
}
