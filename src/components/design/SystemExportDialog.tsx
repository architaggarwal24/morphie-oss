"use client";
import { Check, Copy, Download, FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CodeView } from "../code/CodeView";
import { Button, Dialog, Segmented, Spinner, cn } from "../ui";

type Format = "css" | "tailwind" | "tokens" | "react";
interface Export { files: Array<{ path: string; content: string }>; name: string }
const FORMATS: Array<{ value: Format; label: string; hint: string }> = [
  { value: "css", label: "CSS variables", hint: "One tokens.css with every colour, ramp, font, size, radius and shadow." },
  { value: "tailwind", label: "Tailwind", hint: "A v4 @theme stylesheet and a v3 tailwind.config.js." },
  { value: "tokens", label: "Tokens JSON", hint: "W3C Design Tokens format, for Figma plugins, Style Dictionary and friends." },
  { value: "react", label: "React kit", hint: "Button, Input, Card, Badge and Alert on top of the tokens, with a Vite demo." },
];

export function SystemExportDialog({ open, onClose, systemId, name }: { open: boolean; onClose: () => void; systemId: string; name: string }) {
  const [format, setFormat] = useState<Format>("css");
  const [data, setData] = useState<Export | null>(null);
  const [file, setFile] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setData(null); setFile(0); setError(null);
    api<Export>(`/api/systems/${systemId}/export?format=${format}`).then((d) => alive && setData(d)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [open, format, systemId]);
  const current = data?.files[file];
  const copy = async () => { if (!current) return; try { await navigator.clipboard.writeText(current.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ } };
  return (
    <Dialog open={open} onClose={onClose} title={`Export ${name}`} description={FORMATS.find((f) => f.value === format)!.hint} width="max-w-5xl"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><a href={`/api/systems/${systemId}/export?format=${format}&download=1`}><Button variant="primary"><Download className="size-4" aria-hidden /> Download .zip</Button></a></>}>
      <Segmented<Format> label="Export format" kind="tab" value={format} onChange={setFormat} className="mb-4 max-w-full overflow-x-auto" options={FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.hint }))} />
      {error ? <p className="text-sm text-err" role="alert">{error}</p> : !data ? <div className="grid place-items-center py-16"><Spinner /></div> : (
        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <ul className="max-h-[52dvh] space-y-0.5 overflow-auto md:pr-1" aria-label="Files">
            {data.files.map((f, i) => (
              <li key={f.path}><button onClick={() => setFile(i)} aria-current={i === file} className={cn("flex w-full items-center gap-2 truncate rounded-lg px-2.5 py-1.5 pointer-coarse:min-h-11 text-left font-mono text-xs transition active:scale-[0.98]", i === file ? "bg-accent/10 font-medium text-fg ring-1 ring-inset ring-accent/30" : "text-muted hover:bg-fg/[0.05] hover:text-fg")} title={f.path}><FileCode2 className={cn("size-3.5 shrink-0", i === file ? "text-accent" : "text-faint")} aria-hidden /><span className="truncate">{f.path}</span></button></li>
            ))}
          </ul>
          <div className="code-window flex min-w-0 flex-col overflow-hidden rounded-2xl">
            <div className="flex items-center gap-3 border-b border-line/80 bg-fg/[0.025] px-3 py-1.5"><span className="flex gap-1.5" aria-hidden><span className="size-2.5 rounded-full bg-[#ff5f57]/80" /><span className="size-2.5 rounded-full bg-[#febc2e]/80" /><span className="size-2.5 rounded-full bg-[#28c840]/80" /></span><span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{current?.path}</span><button onClick={copy} className={cn("flex pointer-coarse:min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition active:scale-95", copied ? "bg-ok/12 text-ok" : "text-muted hover:bg-fg/[0.07] hover:text-fg")}>{copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}</button></div>
            <div className="flex max-h-[48dvh] min-h-0 flex-col p-2">{current && <CodeView path={current.path} code={current.content} />}</div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
