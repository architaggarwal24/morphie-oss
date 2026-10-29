/**
 * Hand-written binding types (equivalent to `npm run cf-typegen`, which regenerates the full runtime
 * types into this same file name if you prefer). Kept structural so `tsc` needs no Workers type package.
 */
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}
interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}
interface R2ObjectLike { key: string; size: number; uploaded: Date }
interface R2ObjectBodyLike extends R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer> }
interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}
interface CoordinatorStub {
  tryAcquire(key: string, ttlMs: number): Promise<string | null>;
  acquire(key: string, ttlMs: number, waitMs: number): Promise<string | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  rateLimit(key: string, limit: number, windowMs: number): Promise<number>;
  openApproval(id: string, timeoutMs: number): Promise<void>;
  awaitApproval(id: string): Promise<{ approved: boolean; always?: boolean; timedOut?: boolean; answers?: Record<string, string> }>;
  decide(id: string, decision: { approved: boolean; always?: boolean; answers?: Record<string, string> }): Promise<boolean>;
  cancelApproval(id: string): Promise<void>;
  heldKeys(prefix: string): Promise<string[]>;
  runJob(runnerId: string, job: { id: string; project: string; op: string; args: unknown[] }, timeoutMs: number): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  takeJobs(runnerId: string, waitMs: number): Promise<Array<{ id: string; project: string; op: string; args: unknown[] }>>;
  finishJob(jobId: string, result: { ok: boolean; value?: unknown; error?: string }): Promise<boolean>;
  online(runnerId: string): Promise<boolean>;
}
interface CoordinatorNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): CoordinatorStub;
}

interface SandboxExecResultLike { exitCode: number; output: string; timedOut: boolean; truncated: boolean; ms: number }
interface SandboxStub {
  exec(command: string, opts: { cwd?: string; timeoutMs?: number; githubToken?: string }): Promise<SandboxExecResultLike>;
  readFile(path: string): Promise<string | null>;
  readBytes(path: string, maxBytes: number): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(dir: string, depth: number): Promise<Array<{ path: string; type: "file" | "dir"; size?: number }>>;
  files_(limit?: number): Promise<string[]>;
  grep(pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; context?: number; maxResults?: number }): Promise<string>;
  clone(url: string, branch: string | null, githubToken?: string): Promise<SandboxExecResultLike>;
  checkpoint(): Promise<void>;
  destroy(): Promise<void>;
}
interface SandboxNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): SandboxStub;
}

/** One Durable Object per conversation: runs that conversation's agent so it keeps going when the browser leaves. */
interface AgentRunnerNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

interface CloudflareEnv {
  /** D1 database (all relational data). */
  DB: D1DatabaseLike;
  /** Durable Object namespace: approvals, locks and rate limits (one object per anonymous user). */
  COORDINATOR: CoordinatorNamespaceLike;
  /** R2 bucket for files that aren't rows (agent workspace files). */
  FILES?: R2BucketLike;
  /** Durable Object + container per code project (worker/sandbox.ts). Optional: without it code projects run locally or are off. */
  SANDBOX?: SandboxNamespaceLike;
  /** Durable Object per conversation that hosts its agent runs (worker/index.ts AgentRunner). */
  AGENT_RUNNER?: AgentRunnerNamespaceLike;
  /** Static assets binding created by OpenNext. */
  ASSETS: { fetch(req: Request): Promise<Response> };

  // Secrets (wrangler secret put …)
  ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  TAVILY_API_KEY?: string;

  // Plain vars (wrangler.jsonc "vars")
  MORPHIE_ALLOW_PRIVATE_URLS?: string;
  MORPHIE_ALLOWED_ORIGINS?: string;
  MORPHIE_MAX_UPLOAD_MB?: string;
  MORPHIE_MAX_AGENT_STEPS?: string;
}
