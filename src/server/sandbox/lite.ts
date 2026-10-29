import { blobs, type BlobInfo } from "../blobs";
import { cleanRel, globToRegExp, SandboxError, SKIP_DIRS, type ExecResult, type GrepOptions, type Sandbox, type SandboxEntry } from "./types";

/**
 * A Lite project: its files in storage (R2 on Cloudflare, the data folder elsewhere) and nothing else. There is no
 * shell, so it costs nothing to run and works on every plan (Workers Free included). The agent edits it with the file
 * tools and the Preview tab serves it as a static site. For commands (npm, git, tests), use a Morphie Runner.
 */
export const LITE_MAX_FILE = 2_000_000;
export const LITE_MAX_FILES = 3_000;
export const LITE_SHELL = "none: a Lite project has files but no shell";
export const NO_SHELL = "This is a Lite project: it has files but no shell, so commands can't run here. Work with the file tools (read_file, write_file, edit_file, list_files, glob, grep). To run commands, the user can move the work to a Morphie Runner (Settings → Runners).";

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (s: string) => [...enc.encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => dec.decode(Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)));

/** Storage keys allow only [A-Za-z0-9._-] per segment: anything else (and the escape prefix itself) is hex-encoded. */
export const encodeSegment = (s: string) => (/^[A-Za-z0-9._-]+$/.test(s) && !s.startsWith("_x") ? s : `_x${toHex(s)}`);
export const decodeSegment = (s: string) => (s.startsWith("_x") ? fromHex(s.slice(2)) : s);

export class LiteSandbox implements Sandbox {
  readonly kind = "lite" as const;
  readonly canExec = false;
  readonly shell = LITE_SHELL;
  private readonly prefix: string;

  constructor(userId: string, projectId: string) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(userId) || !/^[A-Za-z0-9_-]{6,64}$/.test(projectId)) throw new SandboxError("Invalid project.");
    this.prefix = `lite/${userId}/${projectId}/`;
  }

  private key(rel: string): string { return this.prefix + rel.split("/").map(encodeSegment).join("/"); }
  private relOf(key: string): string { return key.slice(this.prefix.length).split("/").map(decodeSegment).join("/"); }
  private async all(sub = ""): Promise<Array<BlobInfo & { rel: string }>> {
    const items = await blobs().list(sub ? `${this.key(sub)}/` : this.prefix);
    return items.map((b) => ({ ...b, rel: this.relOf(b.key) }));
  }

  async exec(_command?: string): Promise<ExecResult> {
    return { exitCode: 127, output: NO_SHELL, timedOut: false, truncated: false, ms: 0 };
  }

  async readFile(rel: string): Promise<string | null> {
    const clean = cleanRel(rel);
    const data = await blobs().get(this.key(clean));
    if (data) return dec.decode(data);
    if ((await this.all(clean)).length) throw new SandboxError(`${clean} is a folder, not a file.`);
    return null;
  }

  async readBytes(rel: string, maxBytes = 5_000_000): Promise<string | null> {
    const k = this.key(cleanRel(rel));
    const head = await blobs().head(k);
    if (!head || head.size > maxBytes) return null;
    const data = await blobs().get(k);
    if (!data) return null;
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const clean = cleanRel(rel);
    const data = enc.encode(content);
    if (data.length > LITE_MAX_FILE) throw new SandboxError(`That file is too large for a Lite project (max ${LITE_MAX_FILE / 1_000_000} MB).`);
    const k = this.key(clean);
    if (!(await blobs().head(k))) {
      const files = await this.all();
      if (files.length >= LITE_MAX_FILES) throw new SandboxError(`A Lite project holds up to ${LITE_MAX_FILES} files.`);
      // A file can't share its path with a folder (or sit inside a file).
      if (files.some((f) => f.rel.startsWith(`${clean}/`))) throw new SandboxError(`${clean} is a folder.`);
      const parts = clean.split("/");
      for (let i = 1; i < parts.length; i++) if (files.some((f) => f.rel === parts.slice(0, i).join("/"))) throw new SandboxError(`${parts.slice(0, i).join("/")} is a file, not a folder.`);
    }
    await blobs().put(k, data);
  }

  async remove(rel: string): Promise<void> {
    const clean = cleanRel(rel);
    if (await blobs().head(this.key(clean))) await blobs().delete(this.key(clean));
    await blobs().deletePrefix(`${this.key(clean)}/`);
  }

  async list(dir?: string, depth = 2): Promise<SandboxEntry[]> {
    const base = cleanRel(dir, { allowRoot: true });
    const files = await this.all(base);
    const dirs = new Set<string>();
    const out: SandboxEntry[] = [];
    const baseDepth = base ? base.split("/").length : 0;
    for (const f of files) {
      const parts = f.rel.split("/");
      // Folders on the way, as deep as asked; never into the ones that are only listed.
      let blocked = false;
      for (let i = baseDepth + 1; i < parts.length; i++) {
        const level = i - baseDepth;
        if (level > depth || blocked) break;
        const d = parts.slice(0, i).join("/");
        if (!dirs.has(d)) { dirs.add(d); out.push({ path: d, type: "dir" }); }
        if (SKIP_DIRS.has(parts[i - 1])) blocked = true;
      }
      if (!blocked && parts.length - baseDepth <= depth) out.push({ path: f.rel, type: "file", size: f.size });
    }
    out.sort((a, b) => {
      const pa = a.path.split("/"), pb = b.path.split("/");
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] === pb[i]) continue;
        const aDir = i < pa.length - 1 || a.type === "dir", bDir = i < pb.length - 1 || b.type === "dir";
        return aDir !== bDir ? (aDir ? -1 : 1) : pa[i].localeCompare(pb[i]);
      }
      return pa.length - pb.length;
    });
    return out.slice(0, 2000);
  }

  async glob(pattern: string, limit = 200): Promise<string[]> {
    const re = globToRegExp(pattern);
    return (await this.all()).filter((f) => re.test(f.rel)).sort((a, b) => b.modified - a.modified).slice(0, limit).map((f) => f.rel);
  }

  async grep(pattern: string, opts: GrepOptions = {}): Promise<string> {
    let re: RegExp;
    try { re = new RegExp(pattern, opts.ignoreCase ? "i" : ""); } catch (e) { throw new SandboxError(`Invalid regular expression: ${(e as Error).message}`); }
    const only = opts.glob ? globToRegExp(opts.glob) : undefined;
    const ctx = Math.min(5, Math.max(0, opts.context ?? 0));
    const max = Math.min(500, opts.maxResults ?? 100);
    const sub = opts.path ? cleanRel(opts.path) : "";
    let files = await this.all(sub);
    if (!files.length && sub) { const h = await blobs().head(this.key(sub)); if (h) files = [{ ...h, rel: sub }]; }
    const lines: string[] = [];
    let hits = 0;
    for (const f of files) {
      if (hits >= max) break;
      if ((only && !only.test(f.rel)) || f.size > 1_000_000 || f.rel.split("/").some((s) => SKIP_DIRS.has(s))) continue;
      const data = await blobs().get(f.key);
      if (!data) continue;
      const text = dec.decode(data);
      if (text.includes("\u0000")) continue;
      const rows = text.split(/\r?\n/);
      let lastPrinted = -1;
      for (let i = 0; i < rows.length && hits < max; i++) {
        if (!re.test(rows[i])) continue;
        hits++;
        for (let j = Math.max(0, i - ctx, lastPrinted + 1); j <= Math.min(rows.length - 1, i + ctx); j++) {
          lines.push(`${f.rel}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"}${rows[j].slice(0, 400)}`);
          lastPrinted = j;
        }
        if (ctx) lines.push("--");
      }
    }
    return lines.join("\n");
  }

  async clone(_url?: string): Promise<ExecResult> {
    throw new SandboxError("Lite projects can't clone repositories (they have no git). Clone into a Morphie Runner project instead (Settings → Runners).");
  }

  async checkpoint(): Promise<void> { /* already in storage */ }

  async destroy(): Promise<void> { await blobs().deletePrefix(this.prefix); }
}
