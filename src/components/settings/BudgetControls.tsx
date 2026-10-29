"use client";
import { useEffect, useRef, useState } from "react";
import { tokens } from "@/lib/format";
import { useStore } from "@/lib/store";
import { TASK_BUDGET } from "@/lib/types";
import { Select, Slider } from "../ui";

/** Tokens one agent task may use before it pauses with Continue (20k – 1M). */
export function BudgetSlider({ label = "Token budget per task" }: { label?: string }) {
  const { settings, setSettings } = useStore();
  const saved = settings.taskTokenBudget ?? TASK_BUDGET.default;
  // Dragging updates the label at once; the setting is saved when the slider rests.
  const [value, setValue] = useState(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setValue(saved), [saved]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (v: number) => { setValue(v); clearTimeout(timer.current); timer.current = setTimeout(() => void setSettings({ taskTokenBudget: v }), 400); };
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted">{tokens(value)} tokens</span>
      </div>
      <Slider min={TASK_BUDGET.min} max={TASK_BUDGET.max} step={10_000} value={value} onChange={change} aria-label={label} />
      <p className="mt-1 text-xs leading-relaxed text-muted">
        The agent works until the task is done and verified, or until it has used this many tokens (sub-agents and summaries included; cached prompt tokens count a tenth). Then it pauses and you can press Continue. A provider can set its own budget.
      </p>
    </div>
  );
}

/** A cheaper model for sub-agents, summaries and memory. */
export function HelperPicker() {
  const { settings, setSettings, profiles } = useStore();
  // Your own providers and the Morphie AI models your plan includes.
  const usable = profiles.filter((p) => !p.paused && !p.hosted?.locked && p.hosted?.available !== false);
  const options = [{ value: "main", label: "Same as the active model" }, ...usable.map((p) => ({ value: p.id, label: `${p.label} · ${p.model}` }))];
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">Helper model</div>
      <Select value={settings.helperProfileId && usable.some((p) => p.id === settings.helperProfileId) ? settings.helperProfileId : "main"} onValueChange={(v) => setSettings({ helperProfileId: v === "main" ? null : v })} options={options} aria-label="Helper model" />
      <p className="mt-1 text-xs leading-relaxed text-muted">Used for research sub-agents, summarising long runs and picking out memories. A small, fast model here saves most of a long task's tokens.</p>
    </div>
  );
}
