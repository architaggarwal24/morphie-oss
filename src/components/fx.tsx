"use client";
/**
 * Morphie's motion & effects kit ("Aurora"). Small, dependency-light pieces in the spirit of React Bits / Skiper UI /
 * Kokonut UI, written for this app: every one is keyboard- and screen-reader-safe, and goes still with reduced motion
 * (Motion follows <MotionConfig reducedMotion="user"> in App; CSS effects are frozen by the rule in globals.css).
 */
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type HTMLMotionProps } from "motion/react";
import { forwardRef, type PointerEvent, type ReactNode } from "react";
import { cn } from "./ui";

/** Springs used everywhere, so the whole app moves with one personality. */
export const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 220, damping: 26 } as const;

/** Three slow colour fields drifting behind the app. Pure decoration: aria-hidden, no pointer events. */
export function Aurora() {
  return <div className="aurora" aria-hidden><span /><span /><span /></div>;
}

/** onPointerMove for `.spotlight` elements: puts the light where the cursor is. */
export function spotlight(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

/**
 * A button that tilts toward the cursor in 3D and springs back flat (interruptible: it always moves from where it
 * is). Also carries the spotlight. Off with reduced motion.
 */
export const TiltButton = forwardRef<HTMLButtonElement, HTMLMotionProps<"button"> & { max?: number }>(function TiltButton({ max = 7, className, onPointerMove, onPointerLeave, style, ...p }, ref) {
  const reduce = useReducedMotion();
  const rx = useSpring(0, SPRING_SOFT), ry = useSpring(0, SPRING_SOFT);
  return (
    <motion.button
      ref={ref}
      {...p}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 800, ...style }}
      whileTap={reduce ? undefined : { scale: 0.98 }}
      onPointerMove={(e) => {
        spotlight(e);
        if (!reduce && e.pointerType === "mouse") {
          const r = e.currentTarget.getBoundingClientRect();
          ry.set(((e.clientX - r.left) / r.width - 0.5) * 2 * max);
          rx.set(-((e.clientY - r.top) / r.height - 0.5) * 2 * max);
        }
        onPointerMove?.(e);
      }}
      onPointerLeave={(e) => { rx.set(0); ry.set(0); onPointerLeave?.(e); }}
      className={cn("spotlight", className)}
    />
  );
});

/** A control that leans a few pixels toward the cursor and springs back (send buttons, primary calls to action). */
export const Magnetic = forwardRef<HTMLButtonElement, HTMLMotionProps<"button"> & { strength?: number }>(function Magnetic({ strength = 0.25, onPointerMove, onPointerLeave, style, ...p }, ref) {
  const reduce = useReducedMotion();
  const x = useSpring(0, SPRING), y = useSpring(0, SPRING);
  return (
    <motion.button
      ref={ref}
      {...p}
      style={{ x, y, ...style }}
      whileTap={reduce ? undefined : { scale: 0.92 }}
      onPointerMove={(e) => {
        if (!reduce && e.pointerType === "mouse") {
          const r = e.currentTarget.getBoundingClientRect();
          x.set((e.clientX - r.left - r.width / 2) * strength);
          y.set((e.clientY - r.top - r.height / 2) * strength);
        }
        onPointerMove?.(e);
      }}
      onPointerLeave={(e) => { x.set(0); y.set(0); onPointerLeave?.(e); }}
    />
  );
});

/**
 * Lines that arrive from a blur, one after another. Each line stays a single text node, so it reads, copies and is
 * found by tests and screen readers exactly as plain text.
 */
export function BlurIn({ lines, className, lineClassName, delay = 0 }: { lines: ReactNode[]; className?: string; lineClassName?: (i: number) => string | undefined; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <span className={className}>
      {lines.map((l, i) => (
        <motion.span
          key={i}
          className={cn("block", lineClassName?.(i))}
          initial={reduce ? false : { opacity: 0, y: 10, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ ...SPRING_SOFT, delay: delay + i * 0.09 }}
        >
          {l}
        </motion.span>
      ))}
    </span>
  );
}

/** Children rise in one after another (lists of cards, settings blocks). */
export function Stagger({ children, className, step = 0.05 }: { children: ReactNode[]; className?: string; step?: number }) {
  const reduce = useReducedMotion();
  return (
    <div className={className}>
      {children.map((c, i) => (
        <motion.div key={i} initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING_SOFT, delay: i * step }}>{c}</motion.div>
      ))}
    </div>
  );
}

/** The living orb that stands for Morphie: spins while it works, rests otherwise. */
export function Orb({ working, className }: { working?: boolean; className?: string }) {
  return (
    <span className={cn("relative grid place-items-center overflow-hidden rounded-full", className)} aria-hidden>
      <span className={cn("absolute inset-0 rounded-full orb", !working && "[animation-play-state:paused] opacity-80")} />
      <span className="absolute inset-[2px] rounded-full bg-panel/40 backdrop-blur-[2px]" />
      <span className="relative size-1/3 rounded-full bg-white/90 shadow-[0_0_12px_rgb(255_255_255/0.8)]" />
    </span>
  );
}

/** Number that springs to its new value (counters, stats). */
export function Ticker({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 140, damping: 22 });
  const text = useTransform(reduce ? mv : spring, (v) => Math.round(v).toLocaleString());
  mv.set(value);
  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}
