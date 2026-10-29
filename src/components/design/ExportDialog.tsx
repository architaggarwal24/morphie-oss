"use client";
import { motion } from "motion/react";
import { Check, Copy, Download, FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Dialog, Spinner, cn } from "../ui";

interface Export { files: Array<{ path: string; content: string }>; designName: string }

export function ExportDialog({ open, onClose, designId }: { open: boolean; onClose: () => void; designId: string }) {
  const [format, setFormat] = useState<"html" | "react">("html");
  const [data, setData] = useState<Export | null>(null);
  const [file, setFile] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setData(null); setFile(0); setError(null);
    api<Export>(`/api/design/${designId}/export?format=${format}`).then((d) => alive && setData(d)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [open, format, designId]);

  const current = data?.files[file];
  const copy = async () => { if (!current) return; try { await navigator.clipboard.writeText(current.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ } };

  return (
    <Dialog open={open} onClose={onClose} title="Export design" description="Take the code with you. Everything is standard, dependency-light and yours." width="max-w-4xl"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><a href={`/api/design/${designId}/download?format=${format}`}><Button variant="primary"><Download className="size-4" aria-hidden /> Download .zip</Button></a></>}>
      <div className="mb-4 inline-flex rounded-xl border border-line bg-sunken/70 p-1" role="tablist" aria-label="Export format">
        {([["html", "HTML + CSS", "Two files, opens anywhere"], ["react", "React (Vite)", "Component per section"]] as const).map(([v, l, h]) => (
          <button key={v} role="tab" aria-selected={format === v} onClick={() => setFormat(v)} title={h} className={cn("rounded-lg px-4 py-1.5 pointer-coarse:min-h-11 text-sm transition-colors relative z-0", format === v ? "font-medium text-fg" : "text-muted hover:text-fg")}>
            {format === v && <motion.span layoutId="export-tab" transition={{ type: "spring", stiffness: 500, damping: 38 }} className="absolute inset-0 -z-10 rounded-lg bg-panel shadow-card ring-1 ring-line" />}{l}</button>
        ))}
      </div>
      {error ? <p className="text-sm text-err" role="alert">{error}</p> : !data ? <div className="grid place-items-center py-16"><Spinner /></div> : (
        <div className="grid gap-3 md:grid-cols-[210px_1fr]">
          <ul className="max-h-[50dvh] space-y-0.5 overflow-auto md:pr-1" aria-label="Files">
            {data.files.map((f, i) => (
              <li key={f.path}><button onClick={() => setFile(i)} aria-current={i === file} className={cn("flex w-full items-center gap-2 truncate rounded-lg px-2.5 py-1.5 pointer-coarse:min-h-11 text-left font-mono text-xs transition active:scale-[0.98]", i === file ? "bg-accent/10 font-medium text-fg ring-1 ring-inset ring-accent/30" : "text-muted hover:bg-fg/[0.05] hover:text-fg")} title={f.path}><FileCode2 className={cn("size-3.5 shrink-0", i === file ? "text-accent" : "text-faint")} aria-hidden /><span className="truncate">{f.path}</span></button></li>
            ))}
          </ul>
          <div className="code-window min-w-0 overflow-hidden rounded-2xl">
            <div className="flex items-center gap-3 border-b border-line/80 bg-fg/[0.025] px-3 py-1.5"><span className="flex gap-1.5" aria-hidden><span className="size-2.5 rounded-full bg-[#ff5f57]/80" /><span className="size-2.5 rounded-full bg-[#febc2e]/80" /><span className="size-2.5 rounded-full bg-[#28c840]/80" /></span><span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{current?.path}</span><button onClick={copy} className={cn("flex pointer-coarse:min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition active:scale-95", copied ? "bg-ok/12 text-ok" : "text-muted hover:bg-fg/[0.07] hover:text-fg")}>{copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}</button></div>
            <pre className="max-h-[46dvh] overflow-auto p-3.5 font-mono text-[12px] leading-relaxed">{current?.content}</pre>
          </div>
        </div>
      )}
    </Dialog>
  );
}
