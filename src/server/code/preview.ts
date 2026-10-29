import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { hmacHex, safeEqualHex } from "../crypto";
import { killServer, LocalSandbox } from "../sandbox/local";
import type { Sandbox } from "../sandbox/types";

/**
 * The live preview of a code project.
 *
 * - Static files (a site with an index.html, or a build's dist/) are served from the project through a capability URL:
 *   /api/preview/<token>/..., where the token is signed, bound to the user, project and folder, and expires. The page
 *   runs sandboxed (an opaque origin), so it can never act as you on Morphie.
 * - With the local sandbox, the project's dev server (next dev, vite, npm run dev…) can run in the background on a
 *   port of this machine, and the preview shows it live. It stops when you stop it or nobody has looked for a while.
 * - Screenshots from verify_project (.morphie/shots) are served the same way as static files.
 */

export const PREVIEW_TTL_MS = 6 * 3600_000;
const IDLE_STOP_MS = 20 * 60_000;
const MAX_SERVERS = 3;
const LOG_MAX = 20_000;

// ------------------------------------------------------------------ tokens

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function previewToken(userId: string, projectId: string, root: string, now = Date.now()): string {
  const payload = b64(JSON.stringify({ u: userId, p: projectId, r: root, e: now + PREVIEW_TTL_MS }));
  return `${payload}.${hmacHex("preview", payload).slice(0, 40)}`;
}

export function readPreviewToken(token: string, now = Date.now()): { userId: string; projectId: string; root: string } | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined || payload.length > 600) return null;
  if (!safeEqualHex(hmacHex("preview", payload).slice(0, 40), sig)) return null;
  try {
    const v = JSON.parse(unb64(payload)) as { u?: unknown; p?: unknown; r?: unknown; e?: unknown };
    if (typeof v.u !== "string" || typeof v.p !== "string" || typeof v.r !== "string" || typeof v.e !== "number" || v.e < now) return null;
    return { userId: v.u, projectId: v.p, root: v.r };
  } catch { return null; }
}

// ------------------------------------------------------------------ what the project can show

export const STATIC_ROOTS = ["dist", "build", "out", "public", "."];

/** The folder whose index.html is the site, if there is one. */
export async function findStaticRoot(sb: Sandbox): Promise<string | null> {
  const found = await Promise.all(STATIC_ROOTS.map((d) => sb.readFile(d === "." ? "index.html" : `${d}/index.html`).then((t) => t !== null, () => false)));
  return STATIC_ROOTS[found.indexOf(true)] ?? null;
}

interface Pkg { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The command that runs the project's dev server on `port` (null: it has none). */
export function devCommand(pkg: Pkg | null, port: number | string): string | null {
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const host = "--host 127.0.0.1";
  if (deps.next) return `npx --no-install next dev -p ${port} -H 127.0.0.1`;
  if (deps.vite) return `npx --no-install vite --port ${port} --strictPort ${host}`;
  if (deps.astro) return `npx --no-install astro dev --port ${port} ${host}`;
  if (scripts.dev) return "npm run dev";
  if (scripts.start) return "npm start";
  return null;
}

export async function readPackage(sb: Sandbox): Promise<Pkg | null> {
  const text = await sb.readFile("package.json").catch(() => null);
  if (!text) return null;
  try { return JSON.parse(text) as Pkg; } catch { return null; }
}

/** verify_project's screenshots. */
export async function listShots(sb: Sandbox): Promise<string[]> {
  try {
    const entries = await sb.list(".morphie/shots", 1);
    return entries.filter((e) => e.type === "file" && /\.(png|jpe?g|webp)$/i.test(e.path)).map((e) => e.path.split("/").pop()!).slice(0, 12);
  } catch { return []; }
}

// ------------------------------------------------------------------ dev servers (local sandbox)

export interface DevServerView { status: "starting" | "ready" | "exited"; port: number; command: string; log: string; startedAt: number; exitCode?: number | null }
interface DevServer extends DevServerView { child: ChildProcess; lastSeen: number }

const servers = ((globalThis as { __morphiePreview?: Map<string, DevServer> }).__morphiePreview ??= new Map());
let sweeper: ReturnType<typeof setInterval> | undefined;

const key = (userId: string, projectId: string) => `${userId}:${projectId}`;
const view = (s: DevServer): DevServerView => ({ status: s.status, port: s.port, command: s.command, log: s.log.slice(-4000), startedAt: s.startedAt, exitCode: s.exitCode });

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const a = srv.address(); srv.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export function devServer(userId: string, projectId: string, touch = true): DevServerView | null {
  const s = servers.get(key(userId, projectId));
  if (!s) return null;
  if (touch) s.lastSeen = Date.now();
  return view(s);
}

export function stopDevServer(userId: string, projectId: string): void {
  const k = key(userId, projectId);
  const s = servers.get(k);
  if (!s) return;
  servers.delete(k);
  killServer(s.child);
}

/** Start the project's dev server (installing dependencies first when they're missing). */
export async function startDevServer(sb: LocalSandbox, userId: string, projectId: string): Promise<DevServerView> {
  stopDevServer(userId, projectId);
  const pkg = await readPackage(sb);
  const port = await freePort();
  const cmd = devCommand(pkg, port);
  if (!cmd) throw new Error("This project has no dev server to start (no package.json with a dev or start script).");
  const hasModules = (await sb.list("", 1).catch(() => [])).some((e) => e.path === "node_modules");
  const command = hasModules ? cmd : `npm install --no-audit --no-fund && ${cmd}`;
  // Oldest out when too many are running.
  while (servers.size >= MAX_SERVERS) {
    const oldest = [...servers.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    servers.delete(oldest[0]);
    killServer(oldest[1].child);
  }
  const child = sb.spawnServer(command, { PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", BROWSER: "none", NODE_ENV: "development", CI: "" });
  const s: DevServer = { child, port, command: cmd, log: "", status: "starting", startedAt: Date.now(), lastSeen: Date.now() };
  servers.set(key(userId, projectId), s);
  const take = (b: Buffer) => { s.log = (s.log + b.toString("utf8")).slice(-LOG_MAX); };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("exit", (code) => { s.status = "exited"; s.exitCode = code; });
  child.on("error", (e) => { s.log += `\n${e.message}`; s.status = "exited"; s.exitCode = 127; });
  void (async () => {
    // Ready when the port answers (installs can take minutes).
    for (let i = 0; i < 600 && s.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (s.status === "starting" && (await listening(port))) s.status = "ready";
    }
  })();
  if (!sweeper) {
    // Dev servers are detached process groups: take them down with Morphie.
    process.once("exit", stopAllDevServers);
  }
  sweeper ??= setInterval(() => {
    for (const [k, v] of servers) if (Date.now() - v.lastSeen > IDLE_STOP_MS || v.status === "exited") { if (v.status !== "exited") killServer(v.child); if (Date.now() - v.lastSeen > IDLE_STOP_MS) servers.delete(k); }
  }, 60_000);
  (sweeper as { unref?: () => void }).unref?.();
  return view(s);
}

/** Stop every dev server (server shutdown). */
export function stopAllDevServers(): void {
  for (const [k, s] of servers) { servers.delete(k); killServer(s.child); }
}

// ------------------------------------------------------------------ serving files

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8", xml: "application/xml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
  wasm: "application/wasm", pdf: "application/pdf", webmanifest: "application/manifest+json",
};
export const contentType = (path: string) => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Root-relative links ("/assets/x.js") would leave the preview: point them back into it. Relative links resolve
 * against the folder of the file actually served (the URL may lack its trailing slash), via a <base>.
 */
export function rewriteHtml(html: string, base: string, dir = ""): string {
  let out = html.replace(/(\s(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${base}`);
  if (!/<base\s/i.test(out)) {
    const tag = `<base href="${base}${dir ? `${dir.replace(/"/g, "")}/` : ""}">`;
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${out}`;
  }
  return out;
}

/** Which file a request path means: folders get their index.html, extension-less paths try .html. */
export function candidates(root: string, rel: string): string[] {
  const clean = rel.replace(/^\/+/, "");
  const join = (p: string) => (root === "." || !root ? p : `${root}/${p}`).replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return [join(`${clean}index.html`)];
  const last = clean.split("/").pop()!;
  return last.includes(".") ? [join(clean)] : [join(clean), join(`${clean}.html`), join(`${clean}/index.html`)];
}

/** Headers for a preview response: its own sandboxed origin, nothing cached, no referrer (the URL is a capability). */
export function previewHeaders(type: string): Record<string, string> {
  return {
    "content-type": type,
    // Same as security-headers.mjs previewHeaders() (which next.config applies on top).
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
  };
}
