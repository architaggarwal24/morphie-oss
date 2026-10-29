"use client";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "./ui";

export interface ComboOption { value: string; label?: string; hint?: ReactNode }

/**
 * A free-text field with a filterable suggestion list (replaces <datalist>, which every browser draws differently
 * and none lets you style). Typing filters, ↑/↓ move, Enter picks, Esc closes the list first and the dialog second.
 * Any text is still a valid value: the list only suggests.
 */
export function Combobox({ id, value, onChange, options, placeholder, className, inputClassName, emptyText = "No matches. Press Enter to use what you typed.", "aria-label": ariaLabel, mono }: {
  id?: string; value: string; onChange: (v: string) => void; options: ComboOption[]; placeholder?: string; className?: string; inputClassName?: string;
  emptyText?: string; "aria-label"?: string; mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState(false);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  // Until the person types, show everything (the current value is usually one of the options).
  const shown = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!typed || !q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q) || o.label?.toLowerCase().includes(q));
  }, [options, value, typed]);

  const pick = (v: string) => { onChange(v); setOpen(false); setTyped(false); input.current?.focus(); };
  const show = () => { if (options.length) { setOpen(true); setActive(Math.max(0, shown.findIndex((o) => o.value === value))); } };

  return (
    <Popover.Root open={open && options.length > 0} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className={cn("relative min-w-0 flex-1", className)}>
          <input
            ref={input} id={id} value={value} placeholder={placeholder} aria-label={ariaLabel}
            role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
            autoComplete="off" spellCheck={false} autoCapitalize="off"
            onChange={(e) => { onChange(e.target.value); setTyped(true); setActive(0); if (!open) setOpen(true); }}
            onFocus={() => { if (!open) setTyped(false); }}
            onClick={show}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); if (!open) show(); else setActive((a) => Math.min(shown.length - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter" && open) { e.preventDefault(); if (shown[active]) pick(shown[active].value); else setOpen(false); }
              else if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); }
            }}
            className={cn(
              "pointer-coarse:min-h-11 h-10 w-full rounded-xl border border-line bg-sunken/70 pl-3 pr-10 text-sm text-fg placeholder:text-faint outline-hidden transition duration-200 hover:border-faint/60 focus:border-accent/70 focus:bg-panel focus:ring-4 focus:ring-accent/15",
              mono && "font-mono", inputClassName,
            )}
          />
          {options.length > 0 && (
            <button
              type="button" tabIndex={-1} aria-label="Show suggestions"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (open) setOpen(false); else { setTyped(false); show(); } input.current?.focus(); }}
              className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-fg/[0.07] hover:text-fg pointer-coarse:size-11"
            >
              <ChevronDown className={cn("size-4 transition-transform duration-300", open && "rotate-180")} aria-hidden />
            </button>
          )}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          data-layer="" align="start" sideOffset={6} collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (input.current?.parentElement?.contains(e.target as Node)) e.preventDefault(); }}
          className="layer-pop z-[90] w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-xl border border-line bg-panel/95 shadow-pop backdrop-blur-xl"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px] text-faint">
            <Search className="size-3.5" aria-hidden />
            <span className="tabular-nums">{shown.length} of {options.length}</span>
            <span className="ml-auto hidden sm:inline">↑↓ to move · Enter to pick</span>
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {shown.length === 0 && <li className="px-3 py-3 text-xs text-muted">{emptyText}</li>}
            {shown.map((o, i) => (
              <li
                key={o.value} id={`${listId}-${i}`} role="option" aria-selected={o.value === value}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(o.value)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors duration-100", i === active ? "bg-accent/12 text-fg" : "text-muted")}
              >
                <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[13px]")}>{o.label && o.label !== o.value ? <>{o.label} <span className="text-faint">{o.value}</span></> : o.value}</span>
                {o.value === value && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
