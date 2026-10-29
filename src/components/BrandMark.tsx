"use client";
import { Globe, Server } from "lucide-react";
import { BRAND_MARKS } from "./brandMarks";
import { cn } from "./ui";

/**
 * A provider's (or sign-in method's) real logo on a glass tile tinted with its brand colour. Unknown kinds fall back
 * to a monogram on the app gradient; the custom endpoint gets a globe, local servers a server glyph.
 */
export function BrandMark({ kind, label, size = "md", className, active }: { kind: string; label?: string; size?: "sm" | "md" | "lg"; className?: string; active?: boolean }) {
  const m = BRAND_MARKS[kind];
  const box = size === "sm" ? "size-8 rounded-lg" : size === "lg" ? "size-12 rounded-2xl" : "size-10 rounded-xl";
  const glyph = size === "sm" ? "size-4" : size === "lg" ? "size-6" : "size-5";
  const tint = m?.tint ?? "var(--accent)";
  return (
    <span
      aria-hidden
      style={{ ["--tint" as string]: tint }}
      className={cn(
        "brand-tile relative grid shrink-0 place-items-center overflow-hidden transition duration-300",
        box, active && "brand-tile-active", className,
      )}
    >
      {m?.color ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.color} alt="" className={cn(glyph, "relative drop-shadow-[0_1px_2px_rgb(0_0_0/0.25)]")} draggable={false} />
      ) : m?.mono ? (
        <svg viewBox="0 0 24 24" className={cn(glyph, "relative text-fg")} fill="currentColor" dangerouslySetInnerHTML={{ __html: m.mono }} />
      ) : kind === "custom" ? (
        <Globe className={cn(glyph, "relative text-accent")} />
      ) : kind === "local" ? (
        <Server className={cn(glyph, "relative text-fg")} />
      ) : (
        <span className="relative bg-linear-to-br/oklch from-accent via-accent-3 to-accent-2 bg-clip-text font-display text-[15px] font-bold text-transparent">{(label ?? kind).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?"}</span>
      )}
    </span>
  );
}
