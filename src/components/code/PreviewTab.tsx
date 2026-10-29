"use client";
import { Camera, ExternalLink, Globe, Loader2, Play, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { PreviewStatus, ProjectView } from "@/lib/types";
import { Badge, Button, IconButton, Segmented, Spinner, cn } from "../ui";

type View = "live" | "static" | "shots";

/** Where the browser reaches a dev server on this machine (only when Morphie itself is opened on it). */
export function devServerUrl(port: number, hostname: string): string | null {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" ? `http://127.0.0.1:${port}/` : null;
}

/**
 * The project, running: its dev server live (local sandbox), its static files, or verify_project's screenshots.
 * Static previews reload as the agent changes files; dev servers reload themselves (hot reload).
 */
export function PreviewTab({ project }: { project: ProjectView }) {
  const tick = useStore((s) => s.changesTick);
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<PreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;

  const load = useCallback(async () => {
    try { setSt(await api<PreviewStatus>(`/api/projects/${project.id}/preview`)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);
  // Files changed: refresh what's available and reload a static preview (debounced: edits come in bursts).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => { void load(); setFrameKey((k) => k + 1); }, 900);
    return () => clearTimeout(t);
  }, [tick, load]);
  // A running server: keep its status fresh (and keep it alive: it stops when nobody's looking).
  const server = st?.server;
  useEffect(() => {
    if (!server || server.status === "exited") return;
    const t = setInterval(() => void load(), server.status === "starting" ? 2000 : 15_000);
    return () => clearInterval(t);
  }, [server, load]);

  // Default view: the live server if there is one, else the static site, else screenshots.
  const current: View = view ?? (server && server.status !== "exited" ? "live" : st?.staticUrl ? "static" : st?.dev.available ? "live" : st?.shots.length ? "shots" : "live");

  const act = async (action: "start" | "stop") => {
    setBusy(true);
    try { setSt(await api<PreviewStatus>(`/api/projects/${project.id}/preview`, { method: "POST", body: { action } })); if (action === "start") setView("live"); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };

  if (!st) {
    return <div className="grid flex-1 place-items-center p-6 text-sm text-muted">{error ? <span className="text-err">{error}</span> : <Spinner />}</div>;
  }

  const liveUrl = server?.status === "ready" ? devServerUrl(server.port, host) : null;
  const frameUrl = current === "live" ? liveUrl : current === "static" ? st.staticUrl : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        <Segmented size="sm" label="Preview source" value={current} onChange={setView} options={[
          { value: "live", label: <span className="flex items-center gap-1"><Play className="size-3" aria-hidden />Live</span> },
          { value: "static", label: <span className="flex items-center gap-1"><Globe className="size-3" aria-hidden />Files</span> },
          { value: "shots", label: <span className="flex items-center gap-1"><Camera className="size-3" aria-hidden />Shots{st.shots.length ? ` · ${st.shots.length}` : ""}</span> },
        ]} />
        <span className="flex-1" />
        {current === "live" && server && server.status !== "exited" && <Badge tone={server.status === "ready" ? "ok" : "warn"}>{server.status === "ready" ? `:${server.port}` : "starting"}</Badge>}
        {frameUrl && <IconButton label="Reload preview" onClick={() => setFrameKey((k) => k + 1)}><RefreshCw className="size-3.5" /></IconButton>}
        {frameUrl && <a href={frameUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className="grid size-8 pointer-coarse:size-11 place-items-center rounded-lg text-muted hover:bg-fg/[0.05] hover:text-fg"><ExternalLink className="size-3.5" /></a>}
      </div>

      {current === "live" && (
        st.sandbox !== "local" ? (
          <Empty icon={<Globe className="size-5" />} title="Live preview runs locally">{st.dev.reason}</Empty>
        ) : !server || server.status === "exited" ? (
          <Empty icon={<Play className="size-5" />} title={server?.status === "exited" ? "The dev server stopped" : "Run the app"}
            action={st.dev.available ? <Button size="sm" variant="primary" loading={busy} onClick={() => act("start")}><Play className="size-3.5" aria-hidden /> {server ? "Start again" : "Start dev server"}</Button> : undefined}>
            {st.dev.available
              ? <>Starts <code className="font-mono text-[11px]">{st.dev.command}</code> in the background (installing dependencies first if needed) and shows the app here, updating as the agent edits.</>
              : "This project has no dev server yet (no package.json with a dev or start script)."}
            {server?.status === "exited" && server.log && <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-line bg-[#0b0d12] p-2 text-left font-mono text-[11px] leading-relaxed text-[#cfd6e4]">{server.log.slice(-2000)}</pre>}
          </Empty>
        ) : server.status === "starting" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted"><Loader2 className="size-3.5 animate-spin text-accent" aria-hidden /> Starting <code className="truncate font-mono text-[11px]">{server.command}</code></div>
            <pre className="m-2 mt-0 min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-[#0b0d12] p-2 font-mono text-[11px] leading-relaxed text-[#cfd6e4]">{server.log || "…"}</pre>
            <div className="p-2 pt-0"><Button size="sm" variant="ghost" onClick={() => act("stop")}><Square className="size-3" aria-hidden /> Stop</Button></div>
          </div>
        ) : !liveUrl ? (
          <Empty icon={<TriangleAlert className="size-5" />} title="Open it on this machine">The dev server is running on port {server.port} of the computer running Morphie. Open Morphie at localhost on that computer to see it here.</Empty>
        ) : (
          <Frame src={liveUrl} frameKey={frameKey} sameOrigin footer={
            <div className="flex items-center gap-2 border-t border-line px-2 py-1 text-[11px] text-faint">
              <span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_rgb(var(--ok))]" aria-hidden />
              <code className="min-w-0 flex-1 truncate font-mono">{server.command}</code>
              <button className="hover:text-fg" onClick={() => setShowLog((s) => !s)}>{showLog ? "Hide log" : "Log"}</button>
              <button className="hover:text-err" onClick={() => act("stop")} disabled={busy}>Stop</button>
            </div>
          } log={showLog ? server.log : undefined} />
        )
      )}

      {current === "static" && (st.staticUrl
        ? <Frame src={st.staticUrl} frameKey={frameKey} footer={<p className="border-t border-line px-2 py-1 text-[11px] text-faint">Static files from <code className="font-mono">{st.staticRoot === "." ? "the project root" : `${st.staticRoot}/`}</code>, reloaded as files change.</p>} />
        : <Empty icon={<Globe className="size-5" />} title="No static site yet">There's no index.html in the project (or in dist/, build/, out/ or public/). Apps with a dev server show under Live.</Empty>)}

      {current === "shots" && (st.shots.length
        ? <div className="grid min-h-0 flex-1 auto-rows-max gap-3 overflow-y-auto p-3 sm:grid-cols-2">
            {st.shots.map((s) => (
              <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" className="group overflow-hidden rounded-xl border border-line bg-sunken transition hover:border-accent/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${s.url}?v=${tick}`} alt={`Screenshot: ${s.name}`} className="aspect-[16/10] w-full object-cover object-top transition group-hover:scale-[1.01]" loading="lazy" />
                <span className="block truncate px-2 py-1 font-mono text-[11px] text-muted">{s.name}</span>
              </a>
            ))}
          </div>
        : <Empty icon={<Camera className="size-5" />} title="No screenshots yet">When the agent runs verify_project, it opens the app in a headless browser and its screenshots show here.</Empty>)}
    </div>
  );
}

function Frame({ src, frameKey, footer, sameOrigin, log }: { src: string; frameKey: number; footer?: React.ReactNode; sameOrigin?: boolean; log?: string }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); }, [src, frameKey]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 bg-white">
        {loading && <div className="absolute inset-0 grid place-items-center bg-panel/60"><Spinner /></div>}
        <iframe
          key={frameKey} src={src} title="App preview" onLoad={() => setLoading(false)}
          // A dev server has its own origin; static files run in an opaque one (the server sandboxes them too).
          sandbox={cn("allow-scripts allow-forms allow-popups allow-modals allow-downloads", sameOrigin && "allow-same-origin")}
          className="size-full border-0"
        />
      </div>
      {log !== undefined && <pre className="max-h-40 shrink-0 overflow-auto border-t border-line bg-[#0b0d12] p-2 font-mono text-[11px] leading-relaxed text-[#cfd6e4]">{log || "…"}</pre>}
      {footer}
    </div>
  );
}

function Empty({ icon, title, children, action }: { icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center overflow-y-auto p-6">
      <div className="max-w-sm text-center">
        <div className={cn("mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20")}>{icon}</div>
        <p className="text-sm font-medium">{title}</p>
        <div className="mt-1 text-xs leading-relaxed text-muted">{children}</div>
        {action && <div className="mt-3 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
