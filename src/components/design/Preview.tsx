"use client";
import { ArrowDown, ArrowUp, Copy, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEVICE_WIDTHS, type Device } from "@/lib/designStore";

/**
 * Renders a design inside a fully sandboxed iframe (no scripts, no same-origin, no forms, no top navigation),
 * scaled to fit its container so a 1280px desktop layout is readable on a laptop panel.
 */
export function Preview({ html, device, busy }: { html: string; device: Device; busy?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = DEVICE_WIDTHS[device];
  const pad = 24;
  const scale = box.w ? Math.min(1, (box.w - pad) / width) : 1;
  const height = box.h ? (box.h - pad) / scale : 600;
  return (
    <div ref={wrap} className="dotgrid relative flex-1 overflow-hidden bg-sunken/50">
      <div className="absolute inset-0 grid place-items-start justify-center p-3">
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_30px_80px_-30px_rgb(0_0_0/0.55),0_0_0_1px_rgb(var(--line))] transition-[width,height] duration-500 ease-[var(--ease-spring)]" style={{ width: width * scale, height: height * scale }}>
          <iframe
            title="Design preview" srcDoc={html} sandbox="" referrerPolicy="no-referrer"
            style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left", border: 0, display: "block", background: "#fff" }}
          />
        </div>
      </div>
      {busy && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden"><div className="h-full w-full animate-shimmer bg-linear-to-r/srgb from-transparent via-accent to-transparent bg-[length:200%_100%]" /></div>}
    </div>
  );
}

interface Selection { section: string; rect: { x: number; y: number; w: number; h: number } }

/**
 * The visual editor: the same scaled frame, but the page inside may run one script (sandbox="allow-scripts", still an
 * opaque origin with no network) so you can click text to edit it in place and select sections. Messages from the
 * frame are checked to come from this iframe and to have the expected shape before anything is sent to the server.
 */
export function EditablePreview({ html, device, busy, sections, onEdit, onSection, onScroll }: {
  html: string; device: Device; busy?: boolean;
  sections: Array<{ id: string; type: string }>;
  onEdit(section: string, path: string, value: string): void;
  onSection(action: "up" | "down" | "duplicate" | "remove", section: string): void;
  onScroll(y: number): void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<Selection | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const latest = useRef({ onEdit, onScroll });
  useEffect(() => { latest.current = { onEdit, onScroll }; });
  useEffect(() => { setSel(null); }, [html]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d.source !== "morphie-editor") return;
      const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
      if (d.type === "select") {
        const section = str(d.section, 40);
        const r = d.rect as Selection["rect"] | undefined;
        if (!section || !r || ![r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n))) { setSel(null); return; }
        setSel({ section, rect: r });
      } else if (d.type === "edit") {
        const section = str(d.section, 40), path = str(d.path, 120), value = str(d.value, 400);
        if (section && path && value) latest.current.onEdit(section, path, value);
      } else if (d.type === "scroll" && typeof d.y === "number" && Number.isFinite(d.y)) latest.current.onScroll(d.y);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // A srcdoc frame inherits this page's CSP, so its one script must carry this page's nonce (its own CSP is rewritten to
  // the same nonce, so both policies agree). The script text itself is the fixed one the server wrote.
  const doc = useMemo(() => {
    const own = /<script nonce="([A-Za-z0-9+/=_-]+)">/.exec(html)?.[1];
    const page = typeof document !== "undefined" ? document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce : undefined;
    return own && page && /^[A-Za-z0-9+/=_-]+$/.test(page) ? html.split(own).join(page) : html;
  }, [html]);
  const width = DEVICE_WIDTHS[device];
  const pad = 24;
  const scale = box.w ? Math.min(1, (box.w - pad) / width) : 1;
  const height = box.h ? (box.h - pad) / scale : 600;
  const meta = sel ? sections.find((s) => s.id === sel.section) : undefined;
  const idx = meta ? sections.indexOf(meta) : -1;
  const fixed = meta?.type === "navbar" || meta?.type === "footer";
  const canUp = !fixed && idx > 0 && sections[idx - 1]?.type !== "navbar";
  const canDown = !fixed && idx >= 0 && idx < sections.length - 1 && sections[idx + 1]?.type !== "footer";
  const top = sel ? Math.max(4, Math.min(height * scale - 40, sel.rect.y * scale + 6)) : 0;
  const deselect = () => { setSel(null); frame.current?.contentWindow?.postMessage({ source: "morphie-parent", type: "deselect" }, "*"); };
  const btn = "grid size-7 pointer-coarse:size-11 place-items-center rounded-lg text-white/85 transition hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div ref={wrap} className="dotgrid relative flex-1 overflow-hidden bg-sunken/50">
      <div className="absolute inset-0 grid place-items-start justify-center p-3">
        <div className="relative overflow-hidden rounded-2xl border border-accent/50 bg-white shadow-[0_30px_80px_-30px_rgb(0_0_0/0.55),0_0_0_3px_rgb(var(--accent)/0.18)] transition-[width,height] duration-500 ease-[var(--ease-spring)]" style={{ width: width * scale, height: height * scale }}>
          <iframe
            ref={frame} title="Design editor" srcDoc={doc} sandbox="allow-scripts" referrerPolicy="no-referrer"
            style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left", border: 0, display: "block", background: "#fff" }}
          />
          {sel && meta && (
            <div role="toolbar" aria-label={`${meta.type} section`} className="absolute right-2 z-10 flex items-center gap-0.5 rounded-xl bg-[#17151f]/90 p-1 text-xs text-white shadow-pop backdrop-blur" style={{ top }}>
              <span className="px-2 font-medium capitalize">{meta.type}</span>
              <button className={btn} aria-label="Move section up" title="Move up" disabled={!canUp} onClick={() => onSection("up", sel.section)}><ArrowUp className="size-3.5" /></button>
              <button className={btn} aria-label="Move section down" title="Move down" disabled={!canDown} onClick={() => onSection("down", sel.section)}><ArrowDown className="size-3.5" /></button>
              <button className={btn} aria-label="Duplicate section" title="Duplicate" disabled={fixed} onClick={() => onSection("duplicate", sel.section)}><Copy className="size-3.5" /></button>
              <button className={`${btn} hover:text-rose-300`} aria-label="Delete section" title="Delete" onClick={() => onSection("remove", sel.section)}><Trash2 className="size-3.5" /></button>
              <button className={btn} aria-label="Deselect" title="Done" onClick={deselect}><X className="size-3.5" /></button>
            </div>
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#17151f]/85 px-3 py-1 text-[11px] text-white/85 shadow-pop backdrop-blur">Click text to edit · Enter saves · Esc cancels · click a section for its tools</div>
      {busy && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden"><div className="h-full w-full animate-shimmer bg-linear-to-r/srgb from-transparent via-accent to-transparent bg-[length:200%_100%]" /></div>}
    </div>
  );
}
