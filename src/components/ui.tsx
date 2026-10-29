"use client";
import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Checkbox as RCheckbox, Select as RSelect, Slider as RSlider, Tooltip as RTooltip } from "radix-ui";
import { createPortal } from "react-dom";
import { ariaShortcut, shortcutKeys, shortcutLabel, type Shortcut } from "@/lib/shortcuts";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode, type TextareaHTMLAttributes } from "react";

export const cn = clsx;

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "soft";
const VARIANTS: Record<BtnVariant, string> = {
  primary: "btn-glow text-accent-fg hover:brightness-110 hover:-translate-y-px",
  secondary: "btn-surface text-fg hover:-translate-y-px",
  soft: "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20 hover:ring-accent/45 hover:shadow-[0_6px_20px_-8px_rgb(var(--accent)/0.55)]",
  ghost: "text-muted hover:text-fg hover:bg-fg/[0.06]",
  danger: "bg-err/10 text-err ring-1 ring-inset ring-err/25 hover:bg-err/18 hover:ring-err/45 hover:shadow-[0_6px_20px_-8px_rgb(var(--err)/0.5)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean }>(function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...p }, ref) {
  return (
    <button
      ref={ref}
      {...p}
      disabled={disabled || loading}
      className={cn("inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-[translate,scale,background-color,box-shadow,color,filter,border-color] duration-200 ease-out active:translate-y-0 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap", size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm", "pointer-coarse:min-h-11", VARIANTS[variant], className)}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/** A styled tooltip (Radix): opens on hover after a short delay and on keyboard focus; Esc closes it. */
export function Tip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RTooltip.Provider delayDuration={350} skipDelayDuration={150}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content side={side} sideOffset={6} className="tip z-[80] flex items-center gap-1.5 rounded-lg border border-line bg-panel/95 px-2 py-1 text-xs font-medium text-fg shadow-pop backdrop-blur-md">
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}

/**
 * An icon-only button. Its label is its accessible name and its tooltip; `shortcut` adds the key combo to the
 * tooltip (⌘ on Apple platforms, Ctrl elsewhere) and announces it via aria-keyshortcuts. `data-tooltip` mirrors the
 * tooltip text (tests and debugging).
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: Shortcut; tipSide?: "top" | "bottom" | "left" | "right" }>(function IconButton({ label, className, children, active, shortcut, tipSide, ...p }, ref) {
  const tip = shortcut ? `${label} (${shortcutLabel(shortcut)})` : label;
  return (
    <Tip side={tipSide} content={<>{label}{shortcut && <KeyCombo shortcut={shortcut} />}</>}>
      <button ref={ref} {...p} aria-label={label} data-tooltip={tip} aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined} className={cn("inline-grid place-items-center size-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-lg text-muted transition duration-200 hover:text-fg hover:bg-fg/[0.07] active:scale-90 disabled:opacity-40 disabled:pointer-events-none", active && "text-fg bg-raised", className)}>
        {children}
      </button>
    </Tip>
  );
});

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn("switch group relative h-6 w-10 shrink-0 rounded-full transition duration-300 disabled:opacity-50 before:absolute before:content-[''] pointer-coarse:before:-inset-x-0.5 pointer-coarse:before:-inset-y-2.5", checked ? "btn-glow" : "bg-fg/12 ring-1 ring-inset ring-line hover:bg-fg/18")}>
      <span className={cn("switch-knob absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.35),0_0_0_0.5px_rgb(0_0_0/0.08)] group-active:w-6", checked ? "left-[18px] group-active:left-[14px]" : "left-0.5")} />
    </button>
  );
}

const field = "pointer-coarse:min-h-11 w-full rounded-xl border border-line bg-sunken/70 px-3 text-sm text-fg placeholder:text-faint outline-hidden transition duration-200 hover:border-faint/60 focus:border-accent/70 focus:bg-panel focus:ring-4 focus:ring-accent/15 disabled:opacity-60";
export function Input({ className, ...p }: ComponentProps<"input">) { return <input {...p} className={cn(field, "h-10", className)} />; }
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={cn(field, "py-2.5 leading-relaxed resize-y", className)} />; }
export interface SelectOption<T extends string = string> { value: T; label: ReactNode; hint?: ReactNode; icon?: ReactNode; textValue?: string }

/**
 * A custom select (Radix): keyboard type-ahead, arrow keys, Esc, screen-reader listbox semantics, and a menu that
 * springs open from the trigger. Options can carry an icon and a one-line hint. An empty value shows the placeholder.
 */
export function Select<T extends string>({ value, onValueChange, options, placeholder = "Choose…", className, id, disabled, "aria-label": ariaLabel }: {
  value: T | ""; onValueChange: (v: T) => void; options: Array<SelectOption<T>>; placeholder?: string; className?: string; id?: string; disabled?: boolean; "aria-label"?: string;
}) {
  return (
    <RSelect.Root value={value || undefined} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <RSelect.Trigger id={id} aria-label={ariaLabel} className={cn(field, "group flex h-10 items-center justify-between gap-2 text-left data-[placeholder]:text-faint data-[state=open]:border-accent/70 data-[state=open]:bg-panel data-[state=open]:ring-4 data-[state=open]:ring-accent/15 [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2 [&>span]:truncate", className)}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon asChild><ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-300 ease-out group-data-[state=open]:rotate-180 group-hover:text-fg" aria-hidden /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content data-layer="" position="popper" sideOffset={6} collisionPadding={12} className="layer-pop z-[90] max-h-[min(380px,var(--radix-select-content-available-height))] min-w-[max(var(--radix-select-trigger-width),12rem)] overflow-hidden rounded-xl border border-line bg-panel/95 shadow-pop backdrop-blur-xl">
          <RSelect.ScrollUpButton className="grid h-6 place-items-center text-muted"><ChevronUp className="size-4" aria-hidden /></RSelect.ScrollUpButton>
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} textValue={o.textValue ?? (typeof o.label === "string" ? o.label : o.value)} className="relative flex cursor-pointer select-none items-start gap-2.5 rounded-lg py-2 pl-2.5 pr-9 text-sm text-muted outline-hidden transition-colors duration-150 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent/12 data-[highlighted]:text-fg data-[state=checked]:text-fg">
                <span className="min-w-0 flex-1">
                  <RSelect.ItemText><span className="flex min-w-0 items-center gap-2">{o.icon && <span className="grid shrink-0 place-items-center text-muted" aria-hidden>{o.icon}</span>}<span className="truncate">{o.label}</span></span></RSelect.ItemText>
                  {o.hint && <span className="mt-0.5 block text-xs leading-snug text-faint">{o.hint}</span>}
                </span>
                <RSelect.ItemIndicator className="absolute right-2.5 top-2.5"><Check className="size-4 text-accent" aria-hidden /></RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
          <RSelect.ScrollDownButton className="grid h-6 place-items-center text-muted"><ChevronDown className="size-4" aria-hidden /></RSelect.ScrollDownButton>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/** A range slider (Radix): gradient track, glowing thumb that grows while held, arrow/Page/Home/End keys. */
export function Slider({ value, onChange, min, max, step = 1, className, "aria-label": ariaLabel, marks }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; className?: string; "aria-label": string; marks?: boolean;
}) {
  const pct = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <div className={cn("py-1", className)}>
      <RSlider.Root value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} aria-label={ariaLabel} className="group relative flex h-5 w-full touch-none select-none items-center pointer-coarse:h-11">
        <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-fg/10 ring-1 ring-inset ring-line">
          <RSlider.Range className="absolute h-full rounded-full bg-linear-to-r/oklch from-accent via-accent-3 to-accent-2" style={{ backgroundSize: `${10000 / Math.max(pct, 1)}% 100%` }} />
        </RSlider.Track>
        <RSlider.Thumb aria-label={ariaLabel} className="block size-[18px] cursor-grab rounded-full border-2 border-white bg-accent shadow-[0_0_0_4px_rgb(var(--accent)/0.18),0_4px_14px_-2px_rgb(var(--accent)/0.7)] outline-hidden transition-[scale,box-shadow] duration-200 ease-out hover:scale-110 focus-visible:shadow-[0_0_0_6px_rgb(var(--accent)/0.3),0_4px_14px_-2px_rgb(var(--accent)/0.7)] active:cursor-grabbing active:scale-125" />
      </RSlider.Root>
      {marks && <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-faint" aria-hidden><span>{min}</span><span>{max}</span></div>}
    </div>
  );
}

/** A checkbox (Radix) that draws its tick on a spring. */
export function Checkbox({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label?: string; className?: string }) {
  return (
    <RCheckbox.Root checked={checked} onCheckedChange={(v) => onChange(v === true)} aria-label={label} className={cn("peer grid size-4 shrink-0 place-items-center rounded-[5px] border border-faint/70 bg-sunken transition duration-200 hover:border-accent/70 data-[state=checked]:border-transparent data-[state=checked]:bg-accent data-[state=checked]:shadow-[0_0_0_3px_rgb(var(--accent)/0.18)]", className)}>
      <RCheckbox.Indicator className="check-pop text-accent-fg"><Check className="size-3" strokeWidth={3.5} aria-hidden /></RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium tabular-nums text-fg">{label}</label>
      {children}
      {error ? <p className="text-xs text-err" role="alert">{error}</p> : hint ? <p className="text-xs text-muted leading-relaxed">{hint}</p> : null}
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "ok" | "warn" | "err" | "info"; children: ReactNode; className?: string }) {
  const tones = { neutral: "bg-raised/80 text-muted border-line", accent: "bg-accent/12 text-accent border-accent/25", ok: "bg-ok/10 text-ok border-ok/20", warn: "bg-warn/10 text-warn border-warn/25", err: "bg-err/10 text-err border-err/20", info: "bg-info/10 text-info border-info/20" };
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none tabular-nums", tones[tone], className)}>{children}</span>;
}

/**
 * True once `on` has stayed true for `ms`. Loading UI waits for this so fast loads (most of them) never flash a
 * placeholder; only a load slower than ~300ms shows one.
 */
export function useDelayedFlag(on: boolean, ms = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && shown;
}

/** A gray placeholder block. Put it inside the real component's own markup so the loaded content lands in the same place. */
export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block rounded-md align-middle shimmer", className)} />;
}

export function Spinner({ className }: { className?: string }) { return <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />; }

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>;
}

/** A shortcut drawn as key chips: ⌘ K on a Mac, Ctrl K elsewhere. */
export function KeyCombo({ shortcut, className }: { shortcut: Shortcut; className?: string }) {
  return <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={shortcutLabel(shortcut)}>{shortcutKeys(shortcut).map((k) => <Kbd key={k}>{k}</Kbd>)}</span>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-sm place-items-center gap-3 py-16 text-center animate-rise">
      {icon && (
        <div className="relative grid size-14 place-items-center rounded-2xl border border-line bg-panel text-accent shadow-glow">
          <span className="absolute inset-0 -z-10 rounded-2xl bg-accent/20 blur-xl" aria-hidden />
          {icon}
        </div>
      )}
      <h3 className="font-display text-xl font-semibold tracking-tight">{title}</h3>
      {children && <p className="text-sm leading-relaxed text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function Dialog({ open, onClose, title, description, children, width = "max-w-lg", footer, returnFocus, scrimClassName = "backdrop-blur-[6px]", aside, icon, bare }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; width?: string; footer?: ReactNode;
  /** A mark beside the title (a provider's logo, say). */
  icon?: ReactNode;
  /** Keep the title for screen readers only and drop the visible header (the command palette). */
  bare?: boolean;
  /** A decorative panel beside the content on wider screens (the login popup's brand side). */
  aside?: ReactNode;
  /** Where focus goes when the dialog closes. Defaults to whatever had focus when it opened (some browsers don't focus a button on click, so a caller can name it). Keep it a stable function. */
  returnFocus?: () => HTMLElement | null;
  /** Replaces the default blur on the dimmed backdrop. */
  scrimClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const titleId = useId();
  const descId = useId();
  // The latest callbacks, read from a ref so that a parent re-rendering (a toast expiring, say) with new function
  // identities never re-runs the effect below, which would snap focus back to the first field mid-typing.
  const latest = useRef({ onClose, returnFocus });
  useEffect(() => { latest.current = { onClose, returnFocus }; });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>("[data-autofocus], input, textarea, select, button:not([data-close])")?.focus();
    const onKey = (e: KeyboardEvent) => {
      // An open menu inside the dialog (a select, a model list) takes Esc first; the next Esc closes the dialog.
      if (e.key === "Escape") { if (document.querySelector("[data-layer]")) return; e.stopPropagation(); latest.current.onClose(); }
      if (e.key === "Tab" && node) {
        const f = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const back = latest.current.returnFocus?.();
      (back?.isConnected ? back : previous)?.focus?.();
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  // Portalled to <body>: an ancestor with a backdrop-filter or transform (glass panels, page transitions) would
  // otherwise become the containing block of this fixed overlay and squeeze it into that panel.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center pt-[max(1rem,var(--safe-top))] pr-[max(1rem,var(--safe-right))] pb-[max(1rem,var(--safe-bottom))] pl-[max(1rem,var(--safe-left))]">
      <div className={cn("fade absolute inset-0 bg-black/50", scrimClassName)} onClick={onClose} aria-hidden />
      {/* Springs in from slightly below; the content is interactive from the first frame (nothing waits on the animation). */}
      <motion.div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
        initial={reduce ? false : { opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className={cn("dialog-surface relative flex max-h-[90dvh] w-full overflow-hidden rounded-2xl", width)}
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 z-10 h-px bg-linear-to-r from-transparent via-accent/70 to-transparent" />
        {aside && <div className="relative hidden w-[42%] shrink-0 overflow-hidden border-r border-line md:block" aria-hidden>{aside}</div>}
        <div className="flex min-w-0 flex-1 flex-col">
          {bare ? <h2 id={titleId} className="sr-only">{title}</h2> : <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
            <div className="flex min-w-0 items-center gap-3.5">
              {icon}
              <div className="min-w-0">
              <h2 id={titleId} className="font-display text-xl font-semibold leading-tight tracking-tight">{title}</h2>
              {description && <p id={descId} className="mt-1 text-sm text-muted">{description}</p>}
              </div>
            </div>
            <IconButton label="Close" onClick={onClose} data-close className="-mr-2 -mt-1 hover:rotate-90"><X className="size-4" /></IconButton>
          </header>}
          <div className={cn("dialog-body min-h-0 flex-1 overflow-y-auto", bare ? "p-3" : "px-6 py-5")}>{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line bg-sunken/40 px-6 py-4">{footer}</footer>}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, title, body, confirm = "Delete", onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirm?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => { onConfirm(); onClose(); }}>{confirm}</Button></>}>
      <div className="text-sm leading-relaxed text-muted">{body}</div>
    </Dialog>
  );
}

/** Closes a popover when clicking elsewhere or pressing Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, close]);
  return ref;
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="morphie-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--accent))" /><stop offset="0.55" stopColor="rgb(var(--accent-3))" /><stop offset="1" stopColor="rgb(var(--accent-2))" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#morphie-logo)" />
      <path d="M14 46V18h6l12 17 12-17h6v28h-6V29L32 46 20 29v17z" fill="#fff" />
    </svg>
  );
}

/**
 * A segmented control whose highlight slides between options on a spring (Motion layoutId: interrupted mid-way, it
 * turns around from where it is). `kind` keeps each caller's semantics: tabs, radios or plain buttons.
 */
export function Segmented<T extends string>({ value, onChange, options, label, kind = "radio", className, size = "md" }: {
  value: T; onChange: (v: T) => void; label: string; kind?: "radio" | "tab"; className?: string; size?: "sm" | "md";
  options: Array<{ value: T; label: ReactNode; title?: string; ariaLabel?: string }>;
}) {
  const id = useId();
  return (
    <div role={kind === "tab" ? "tablist" : "radiogroup"} aria-label={label} className={cn("relative inline-flex rounded-xl border border-line bg-sunken/70 p-1", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value} type="button" role={kind} aria-label={o.ariaLabel} title={o.title}
            {...(kind === "tab" ? { "aria-selected": on } : { "aria-checked": on })}
            onClick={() => onChange(o.value)}
            className={cn("relative z-0 flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-200 pointer-coarse:min-h-11", size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-4 text-sm", on ? "text-fg" : "text-muted hover:text-fg")}
          >
            {on && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 -z-10 rounded-lg bg-panel shadow-card ring-1 ring-line" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Initials on a gradient disc: the person's avatar wherever they appear. */
export function Avatar({ name, email, className }: { name?: string | null; email?: string | null; className?: string }) {
  const src = (name?.trim() || email || "?").trim();
  const initials = src.includes("@") ? src[0] : src.split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  return (
    <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full bg-linear-to-br/oklch from-accent via-accent-3 to-accent-2 text-sm font-semibold uppercase text-white shadow-glow", className)}>
      {initials || "?"}
    </span>
  );
}
