import fs from "node:fs";
import path from "node:path";
import { cfEnv } from "./cf";
import { config } from "./config";

/**
 * File storage for things that aren't rows: the agent's workspace files (and later, uploads and design assets).
 * Cloudflare R2 (binding FILES) on Workers; a folder under the data directory everywhere else. Keys are
 * slash-separated and always built by trusted code (never taken raw from a request).
 */
export interface BlobInfo { key: string; size: number; modified: number }
export interface BlobStore {
  readonly kind: "r2" | "fs";
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<BlobInfo | null>;
  put(key: string, data: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every object under `prefix` (which should end with "/"), sorted by key. */
  list(prefix: string): Promise<BlobInfo[]>;
  deletePrefix(prefix: string): Promise<void>;
}

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string) => (typeof d === "string" ? enc.encode(d) : d);
const KEY_RE = /^[A-Za-z0-9._\/-]{1,512}$/;
function checkKey(key: string): string {
  if (!KEY_RE.test(key) || key.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`Invalid storage key: ${key}`);
  return key;
}
/** A listing prefix: a key that ends in "/". */
function checkPrefix(prefix: string): string {
  if (!prefix.endsWith("/")) throw new Error(`Storage prefixes must end with "/": ${prefix}`);
  checkKey(prefix.slice(0, -1));
  return prefix;
}

// ------------------------------------------------------------------ R2

class R2Store implements BlobStore {
  readonly kind = "r2" as const;
  constructor(private b: R2BucketLike) {}
  async get(key: string) { const o = await this.b.get(checkKey(key)); return o ? new Uint8Array(await o.arrayBuffer()) : null; }
  async head(key: string) { const o = await this.b.head(checkKey(key)); return o ? { key, size: o.size, modified: o.uploaded.getTime() } : null; }
  async put(key: string, data: Uint8Array | string) { await this.b.put(checkKey(key), bytes(data)); }
  async delete(key: string) { await this.b.delete(checkKey(key)); }
  async list(prefix: string) {
    const out: BlobInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.b.list({ prefix: checkPrefix(prefix), cursor, limit: 1000 });
      for (const o of page.objects) out.push({ key: o.key, size: o.size, modified: o.uploaded.getTime() });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async deletePrefix(prefix: string) {
    const keys = (await this.list(prefix)).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) await this.b.delete(keys.slice(i, i + 1000));
  }
}

// ------------------------------------------------------------------ local folder

class FsStore implements BlobStore {
  readonly kind = "fs" as const;
  private root(): string { return fs.realpathSync(config.dataDir); }
  /** Resolve inside the root, refusing anything that escapes it or passes through a symbolic link. */
  private full(key: string): string {
    const base = this.root();
    const full = path.join(base, ...checkKey(key).split("/"));
    if (!full.startsWith(base + path.sep)) throw new Error("Storage key escapes the data directory.");
    let cur = base;
    for (const seg of path.relative(base, full).split(path.sep)) {
      cur = path.join(cur, seg);
      try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error("Symbolic links aren't allowed in storage."); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return full;
  }
  async get(key: string) { const f = this.full(key); try { return new Uint8Array(fs.readFileSync(f)); } catch { return null; } }
  async head(key: string) {
    try { const st = fs.statSync(this.full(key)); return st.isFile() ? { key, size: st.size, modified: st.mtimeMs } : null; } catch { return null; }
  }
  async put(key: string, data: Uint8Array | string) { const f = this.full(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes(data)); }
  async delete(key: string) { fs.rmSync(this.full(key), { force: true }); }
  async list(prefix: string) {
    const base = this.root();
    const dir = this.full(checkPrefix(prefix).slice(0, -1));
    const out: BlobInfo[] = [];
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const f = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) { const st = fs.statSync(f); out.push({ key: path.relative(base, f).split(path.sep).join("/"), size: st.size, modified: st.mtimeMs }); }
      }
    };
    walk(dir);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async deletePrefix(prefix: string) { fs.rmSync(this.full(checkPrefix(prefix).slice(0, -1)), { recursive: true, force: true }); }
}

const local = new FsStore();

/** R2 on Workers (when the FILES bucket is bound), the data folder everywhere else. */
export function blobs(): BlobStore {
  let env: CloudflareEnv | undefined;
  try { env = cfEnv(); } catch { env = undefined; }
  if (!env) return local;
  if (!env.FILES) throw new Error("File storage isn't configured: bind an R2 bucket as FILES in wrangler.jsonc (see README → Deploying to Cloudflare).");
  return new R2Store(env.FILES);
}
