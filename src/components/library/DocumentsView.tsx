"use client";
import { CheckCircle2, FileCode2, FileJson, FileSpreadsheet, FileText, FileType2, Library, Loader2, Trash2, UploadCloud, XCircle, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { bytes, timeAgo } from "@/lib/format";
import { useRevalidate } from "@/lib/revalidate";
import { motion } from "motion/react";
import { useStore } from "@/lib/store";
import { spotlight } from "../fx";
import type { DocumentView } from "@/lib/types";
import { Badge, Bone, Button, EmptyState, IconButton, cn, useDelayedFlag } from "../ui";

const ICON: Record<string, LucideIcon> = { pdf: FileType2, docx: FileText, txt: FileText, md: FileCode2, csv: FileSpreadsheet, json: FileJson };
/** A tint per file type, so a long list scans at a glance (rgb triplets, like the theme tokens). */
const TINT: Record<string, string> = { pdf: "239 68 68", docx: "59 130 246", txt: "148 163 184", md: "168 85 247", csv: "34 197 94", json: "245 158 11" };
interface Upload { name: string; state: "uploading" | "done" | "error"; message?: string }

/** One document row. Without `d` it draws the same row as gray blocks, so the list doesn't move when data arrives. */
function DocumentRow({ d, onDelete }: { d?: DocumentView; onDelete?: (d: DocumentView) => void }) {
  const Icon = d ? ICON[d.kind] ?? FileText : FileText;
  return (
    <li onPointerMove={spotlight} className="spotlight group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-fg/[0.03]">
      <span style={d ? { ["--tint" as string]: TINT[d.kind] ?? "var(--accent)" } : undefined} className={cn("grid size-10 shrink-0 place-items-center rounded-xl transition duration-300 group-hover:-rotate-3 group-hover:scale-105", d ? "doc-tile" : "border border-line bg-sunken")}>{d ? <Icon className="size-[18px]" aria-hidden /> : <Bone className="size-[18px]" />}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{d ? d.name : <Bone className="h-3.5 w-48 max-w-full" />}</div>
        <div className="mt-0.5 text-xs tabular-nums text-muted">{d ? <>{bytes(d.size)} · {d.chunkCount} section{d.chunkCount === 1 ? "" : "s"} · {timeAgo(d.createdAt)}</> : <Bone className="h-3 w-32" />}</div>
      </div>
      {d ? <Badge className="font-mono uppercase max-sm:hidden">{d.kind}</Badge> : <Bone className="h-[18px] w-9 rounded-full max-sm:hidden" />}
      {d ? <IconButton label={`Delete ${d.name}`} className="opacity-60 hover:bg-err/10 hover:text-err group-hover:opacity-100" onClick={() => onDelete?.(d)}><Trash2 className="size-4" /></IconButton> : <span className="size-8 pointer-coarse:size-11" aria-hidden />}
    </li>
  );
}

export function DocumentsView() {
  const { toast, server } = useStore();
  // Cached in the store: a revisit shows the last list at once while it refetches in the background.
  const docs = useStore((s) => s.documents);
  const setDocs = useStore((s) => s.setDocuments);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const slow = useDelayedFlag(docs === null);

  const load = useCallback(async () => { try { setDocs((await api<{ documents: DocumentView[] }>("/api/documents")).documents); } catch (e) { if (useStore.getState().documents === null) { toast("error", (e as Error).message); setDocs([]); } } }, [toast, setDocs]);
  useEffect(() => { void load(); }, [load]);
  useRevalidate(load);

  const uploading = uploads.some((u) => u.state === "uploading");
  async function upload(files: File[]) {
    if (uploading) return; // one batch at a time: browse is disabled meanwhile
    const limit = server.maxUploadMb * 1048576;
    setUploads(files.map((f) => ({ name: f.name, state: "uploading" })));
    for (const [i, f] of files.entries()) {
      const patch = (u: Partial<Upload>) => setUploads((list) => list.map((x, j) => (j === i ? { ...x, ...u } : x)));
      if (f.size > limit) { patch({ state: "error", message: `Over the ${server.maxUploadMb} MB limit.` }); continue; }
      const form = new FormData();
      form.set("file", f);
      try {
        const r = await api<{ created: boolean; documents: DocumentView[] }>("/api/documents", { method: "POST", form, idempotencyKey: newIdempotencyKey() });
        setDocs(r.documents);
        patch({ state: "done", message: r.created ? undefined : "Already uploaded." });
      } catch (e) { patch({ state: "error", message: (e as Error).message }); }
    }
    setTimeout(() => setUploads((u) => u.filter((x) => x.state === "error")), 4000);
  }

  const undoable = useStore((s) => s.undoable);
  const hidden = useStore((s) => s.hidden);
  const visible = docs?.filter((d) => !hidden[`doc:${d.id}`]) ?? null;
  // No confirm dialog: it disappears now and the request goes out once the Undo toast has gone.
  const remove = (d: DocumentView) => undoable({
    key: `doc:${d.id}`, text: `Deleted “${d.name}”.`,
    commit: async ({ keepalive }) => setDocs((await api<{ documents: DocumentView[] }>(`/api/documents/${d.id}`, { method: "DELETE", keepalive })).documents),
  });

  return (
    <div className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 pb-24 md:px-8 md:py-10 md:pb-10">
        <header>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.03em]">Documents</h1>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">Upload files once and Chat and Agent search them automatically when a question needs them, citing the file name. Text is indexed locally; nothing is sent anywhere until a passage is used in an answer.</p>
        </header>

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = [...e.dataTransfer.files]; if (f.length) void upload(f); }}
          onClick={(e) => { if (e.target === e.currentTarget && !uploading) input.current?.click(); }}
          className={cn("group/drop relative cursor-pointer overflow-hidden rounded-3xl border-2 border-dashed p-10 text-center transition duration-300", drag ? "border-beam scale-[1.01] border-transparent bg-accent/8 shadow-glow" : "border-line bg-panel/50 backdrop-blur hover:border-accent/50 hover:bg-accent/[0.03]")}
        >
          <div className="absolute inset-0 -z-10 dotgrid opacity-50" aria-hidden />
          <motion.span className="pointer-events-none mx-auto grid size-14 place-items-center rounded-2xl bg-linear-to-b/oklch from-accent/25 to-accent/5 text-accent ring-1 ring-inset ring-accent/30 shadow-[0_10px_30px_-12px_rgb(var(--accent)/0.8)] transition-transform duration-300 group-hover/drop:-translate-y-1" animate={drag ? { y: -6, scale: 1.12, rotate: -6 } : { y: 0, scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 380, damping: 18 }}>
            <UploadCloud className="size-7" aria-hidden />
          </motion.span>
          <p className="pointer-events-none mt-3 text-sm font-medium">{drag ? "Release to upload" : "Drop files here"}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => input.current?.click()} disabled={uploading}><UploadCloud className="size-4" aria-hidden /> browse</Button>
          <div className="pointer-events-none mt-4 flex flex-wrap justify-center gap-1.5" aria-hidden>
            {Object.keys(TINT).map((k) => <span key={k} style={{ ["--tint" as string]: TINT[k] }} className="doc-chip rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase">{k}</span>)}
          </div>
          <p className="pointer-events-none mt-2 text-xs text-muted">PDF, Word (.docx), text, Markdown, CSV and JSON · up to {server.maxUploadMb} MB each</p>
          <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json" aria-label="Choose documents to upload" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
        </div>

        {uploads.length > 0 && (
          <ul className="space-y-1.5" aria-live="polite">
            {uploads.map((u, i) => (
              <li key={i} className={cn("relative flex items-center gap-2.5 overflow-hidden rounded-xl border bg-panel/70 px-3 py-2 text-sm backdrop-blur animate-rise", u.state === "error" ? "border-err/30" : u.state === "done" ? "border-ok/30" : "border-accent/30")}>
                {u.state === "uploading" && <span className="shimmer absolute inset-x-0 bottom-0 h-0.5 opacity-80" aria-hidden />}
                {u.state === "uploading" ? <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> : u.state === "done" ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-err" aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                {u.message && <span className={cn("text-xs", u.state === "error" ? "text-err" : "text-muted")}>{u.message}</span>}
              </li>
            ))}
          </ul>
        )}

        {docs === null ? (
          <div aria-busy="true">{slow && <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70 backdrop-blur" aria-label="Loading documents">{[0, 1, 2].map((i) => <DocumentRow key={i} />)}</ul>}</div>
        ) : visible!.length === 0 ? (
          <EmptyState icon={<Library className="size-5" />} title="Nothing here yet">Add a contract, a paper, meeting notes or a spreadsheet, then ask about it in Chat.</EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70 backdrop-blur" aria-label="Uploaded documents">
            {visible!.map((d) => <DocumentRow key={d.id} d={d} onDelete={remove} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
