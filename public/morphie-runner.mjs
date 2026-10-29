#!/usr/bin/env node
/**
 * Morphie Runner: runs your Morphie code projects on this computer.
 *
 *   node morphie-runner.mjs --server https://your-morphie.example --token mr_xxxx.yyyy [--dir ~/morphie-projects]
 *
 * It connects OUT to your Morphie server and asks for work (no open ports, no tunnel). Each project is a folder under
 * --dir; the agent's commands run inside it, as you, with your tools (node, git, python...). Keep approvals on in
 * Morphie for anything risky. Stop it any time with Ctrl+C; remove the runner in Settings → Runners to revoke the token.
 *
 * Needs Node.js 18 or newer. No dependencies.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";

// ------------------------------------------------------------------ options

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const server = (arg("server") || process.env.MORPHIE_SERVER || "").replace(/\/+$/, "");
const token = arg("token") || process.env.MORPHIE_RUNNER_TOKEN || "";
const home = os.homedir();
const dir = path.resolve((arg("dir") || process.env.MORPHIE_RUNNER_DIR || path.join(home, "morphie-projects")).replace(/^~(?=$|[\\/])/, home));
if (!server || !/^mr_[A-Za-z0-9]{6,40}\.[A-Za-z0-9_-]{20,100}$/.test(token)) {
  console.error("Usage: node morphie-runner.mjs --server https://your-morphie.example --token mr_xxxx.yyyy [--dir ~/morphie-projects]\nGet the command from Morphie: Settings → Runners → Add runner.");
  process.exit(2);
}
if (typeof fetch !== "function") { console.error("Morphie Runner needs Node.js 18 or newer."); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });

// ------------------------------------------------------------------ the shell

const EXEC_DEFAULT_MS = 120_000, EXEC_MAX_MS = 600_000, OUTPUT_CAP = 30_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".open-next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo", ".cache", "target"]);

/**
 * On Windows: Git for Windows' bash, found from where Git is installed. Never the WSL launcher (bash.exe in System32 or
 * WindowsApps), which hangs for a minute and fails when WSL isn't set up. Set MORPHIE_BASH to choose one yourself.
 */
function windowsBash() {
  const w = path.win32;
  const where = (cmd) => { const r = spawnSync("where", [cmd], { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []; };
  const isWsl = (p) => /\\(system32|sysnative|windowsapps)\\/i.test(p);
  const c = [];
  if (process.env.MORPHIE_BASH) c.push(process.env.MORPHIE_BASH);
  for (const g of where("git")) { const d = w.dirname(g.trim()); c.push(w.join(d, "..", "bin", "bash.exe"), w.join(d, "..", "..", "bin", "bash.exe"), w.join(d, "bash.exe")); }
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && w.join(process.env.LOCALAPPDATA, "Programs")]) if (base) c.push(w.join(base, "Git", "bin", "bash.exe"));
  c.push(...where("bash"));
  return c.map((p) => w.normalize(p.trim())).find((p) => p && !isWsl(p) && fs.existsSync(p));
}

function findShell() {
  if (process.platform === "win32") {
    const bash = windowsBash();
    return bash ? { cmd: bash, args: (c) => ["-c", c], label: "bash" } : { cmd: process.env.ComSpec || "cmd.exe", args: (c) => ["/d", "/s", "/c", c], label: "cmd.exe" };
  }
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { cmd: bash, args: (c) => ["-c", c], label: path.basename(bash) };
}
const shell = findShell();
const platform = `${process.platform} ${process.arch} · ${shell.label}`;

function childEnv(githubToken) {
  const env = { ...process.env, TERM: "dumb", NO_COLOR: "1", CI: "1", GIT_TERMINAL_PROMPT: "0" };
  delete env.MORPHIE_RUNNER_TOKEN;
  // Git never rewrites line endings in project files (Git for Windows turns core.autocrlf on by default).
  const gitConfig = [["core.autocrlf", "false"]];
  if (githubToken) {
    Object.assign(env, { GITHUB_TOKEN: githubToken, GH_TOKEN: githubToken });
    gitConfig.push(["credential.https://github.com.helper", "!f() { echo username=x-access-token; echo \"password=$GITHUB_TOKEN\"; }; f"]);
    // While the token is in the environment, the project's own git hooks don't run: a hook could read it.
    gitConfig.push(["core.hooksPath", path.join(os.tmpdir(), "morphie-no-git-hooks")]);
  }
  // Keep any git settings already in this terminal's environment, after ours.
  const own = Number(env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < own; i++) if (env[`GIT_CONFIG_KEY_${i}`]) gitConfig.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`] ?? ""]);
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  gitConfig.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  return env;
}

function capOutput(text) {
  if (text.length <= OUTPUT_CAP) return { text, truncated: false };
  const head = Math.floor(OUTPUT_CAP / 3);
  return { text: `${text.slice(0, head)}\n…[${text.length - OUTPUT_CAP} characters omitted]…\n${text.slice(text.length - (OUTPUT_CAP - head))}`, truncated: true };
}

// ------------------------------------------------------------------ paths (never outside the project)

class JobError extends Error {}

function cleanRel(p, allowRoot = false) {
  const raw = String(p ?? "").trim().replace(/^\.\/+/, "");
  if (!raw || raw === ".") { if (allowRoot) return ""; throw new JobError("A path inside the project is required."); }
  if (raw.length > 400 || /[\0\\]/.test(raw)) throw new JobError("That path isn't valid.");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new JobError("Use a path relative to the project root.");
  const parts = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new JobError("Paths can't go above the project root.");
    parts.push(seg);
  }
  if (!parts.length) { if (allowRoot) return ""; throw new JobError("A path inside the project is required."); }
  return parts.join("/");
}

function projectRoot(id) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new JobError("Invalid project.");
  const root = path.join(dir, id);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function abs(root, rel, allowRoot = false) {
  const clean = cleanRel(rel, allowRoot);
  const real = fs.realpathSync(root);
  const full = path.join(real, ...clean.split("/").filter(Boolean));
  let probe = full;
  while (!fs.existsSync(probe) && probe !== real) probe = path.dirname(probe);
  const resolved = fs.realpathSync(probe);
  if (resolved !== real && !resolved.startsWith(real + path.sep)) throw new JobError("That path leads outside the project.");
  return full;
}

function globToRegExp(glob) {
  let re = "", i = 0;
  const g = glob.replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { const slash = g[i + 2] === "/"; re += slash ? "(?:.*/)?" : ".*"; i += slash ? 3 : 2; continue; }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) { re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"; i = end + 1; continue; }
      re += "\\{";
    } else if ("\\^$+.()|[]".includes(c)) re += "\\" + c;
    else re += c;
    i++;
  }
  return new RegExp(g.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

function allFiles(root, sub = "") {
  const real = fs.realpathSync(root);
  const start = sub ? abs(root, sub, true) : real;
  const out = [];
  if (fs.existsSync(start) && fs.statSync(start).isFile()) { const st = fs.statSync(start); return [{ rel: path.relative(real, start).split(path.sep).join("/"), mtime: st.mtimeMs, size: st.size }]; }
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 20_000) return;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
      else if (e.isFile()) { const st = fs.statSync(full); out.push({ rel: path.relative(real, full).split(path.sep).join("/"), mtime: st.mtimeMs, size: st.size }); }
    }
  };
  walk(start);
  return out;
}

// ------------------------------------------------------------------ operations

function exec(root, command, opts = {}) {
  const timeout = Math.min(EXEC_MAX_MS, Math.max(1000, Number(opts.timeoutMs) || EXEC_DEFAULT_MS));
  const cwd = abs(root, opts.cwd || "", true);
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "", timedOut = false;
    const child = spawn(shell.cmd, shell.args(String(command)), { cwd, env: childEnv(opts.githubToken), detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const killTree = () => {
      try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]); else process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
    const take = (b) => { if (out.length < 2_000_000) out += b.toString("utf8"); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const done = (code) => {
      clearTimeout(timer);
      const { text, truncated } = capOutput(out);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), output: text, timedOut, truncated, ms: Date.now() - started });
    };
    child.on("error", (e) => { out += `\n${e.message}`; done(127); });
    child.on("close", done);
  });
}

const ops = {
  exec: (root, [command, opts]) => exec(root, command, opts),
  readFile(root, [rel]) {
    const f = abs(root, rel);
    try { const st = fs.statSync(f); if (!st.isFile()) throw new JobError(`${cleanRel(rel)} is a folder, not a file.`); return fs.readFileSync(f, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  readBytes(root, [rel, maxBytes = 5_000_000]) {
    const f = abs(root, rel);
    try { const st = fs.statSync(f); if (!st.isFile() || st.size > maxBytes) return null; return fs.readFileSync(f).toString("base64"); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  writeFile(root, [rel, content]) {
    const f = abs(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(content), "utf8");
    return null;
  },
  remove(root, [rel]) { fs.rmSync(abs(root, rel), { recursive: true, force: true }); return null; },
  list(root, [rel, depth = 2]) {
    const base = abs(root, rel, true);
    const real = fs.realpathSync(root);
    const out = [];
    const walk = (d, level) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= 2000) return;
        const full = path.join(d, e.name);
        const r = path.relative(real, full).split(path.sep).join("/");
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { out.push({ path: r, type: "dir" }); if (level < depth && !SKIP_DIRS.has(e.name)) walk(full, level + 1); }
        else if (e.isFile()) out.push({ path: r, type: "file", size: fs.statSync(full).size });
      }
    };
    walk(fs.realpathSync(base), 1);
    return out;
  },
  glob(root, [pattern, limit = 200]) {
    const re = globToRegExp(String(pattern));
    return allFiles(root).filter((f) => re.test(f.rel)).sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.rel);
  },
  grep(root, [pattern, opts = {}]) {
    let re;
    try { re = new RegExp(String(pattern), opts.ignoreCase ? "i" : ""); } catch (e) { throw new JobError(`Invalid regular expression: ${e.message}`); }
    const only = opts.glob ? globToRegExp(opts.glob) : undefined;
    const ctx = Math.min(5, Math.max(0, opts.context ?? 0));
    const max = Math.min(500, opts.maxResults ?? 100);
    const lines = [];
    let hits = 0;
    for (const f of allFiles(root, opts.path ? cleanRel(opts.path) : "")) {
      if (hits >= max) break;
      if ((only && !only.test(f.rel)) || f.size > 1_000_000) continue;
      let text;
      try { text = fs.readFileSync(path.join(root, f.rel), "utf8"); } catch { continue; }
      if (text.includes("\u0000")) continue;
      const rows = text.split(/\r?\n/);
      let last = -1;
      for (let i = 0; i < rows.length && hits < max; i++) {
        if (!re.test(rows[i])) continue;
        hits++;
        for (let j = Math.max(0, i - ctx, last + 1); j <= Math.min(rows.length - 1, i + ctx); j++) { lines.push(`${f.rel}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"}${rows[j].slice(0, 400)}`); last = j; }
        if (ctx) lines.push("--");
      }
    }
    return lines.join("\n");
  },
  clone(root, [url, branch, githubToken]) {
    if (fs.readdirSync(root).length) throw new JobError("The project folder isn't empty, so a repository can't be cloned into it.");
    if (!/^https:\/\//.test(String(url))) throw new JobError("Only https:// repositories can be cloned.");
    const b = branch ? ` --branch ${JSON.stringify(String(branch))}` : "";
    return exec(root, `git clone --depth 50${b} -- ${JSON.stringify(String(url))} .`, { timeoutMs: 300_000, githubToken });
  },
  destroy(root) { fs.rmSync(root, { recursive: true, force: true }); return null; },
};

// ------------------------------------------------------------------ talking to Morphie

const headers = { authorization: `Bearer ${token}`, "x-runner-platform": platform, "user-agent": `morphie-runner/${VERSION}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function send(results) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${server}/api/runner/jobs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ results }) });
      if (r.ok || r.status === 401 || r.status === 400) return;
    } catch { /* retry */ }
    await sleep(1000 * (attempt + 1));
  }
}

async function run(job) {
  const t = Date.now();
  let result;
  try {
    const fn = ops[job.op];
    if (!fn) throw new JobError(`This runner doesn't know "${job.op}". Update it (download morphie-runner.mjs again).`);
    const value = await fn(projectRoot(job.project), Array.isArray(job.args) ? job.args : []);
    result = { id: job.id, ok: true, value: value ?? null };
  } catch (e) {
    result = { id: job.id, ok: false, error: e instanceof JobError ? e.message : `The runner hit an error: ${e?.message ?? e}` };
  }
  if (job.op === "exec") log(`${job.project} $`, String(job.args?.[0]).replace(/\s+/g, " ").trim().slice(0, 100), `→ ${result.ok ? `exit ${result.value.exitCode}` : "error"} (${Date.now() - t} ms)`);
  else if (!result.ok) log(job.op, "→", result.error);
  await send([result]);
}

let stopping = false;
process.on("SIGINT", () => { if (stopping) process.exit(130); stopping = true; log("Stopping (Ctrl+C again to quit now)…"); setTimeout(() => process.exit(0), 1500); });

console.log(`Morphie Runner ${VERSION}\n  server:   ${server}\n  projects: ${dir}\n  shell:    ${platform}\nWaiting for work. Leave this running; Ctrl+C stops it.`);
let failures = 0;
while (!stopping) {
  try {
    const r = await fetch(`${server}/api/runner/jobs?wait=25000`, { headers });
    if (r.status === 401) { console.error("Morphie rejected this runner's token: it was removed or is wrong. Add the runner again in Settings → Runners."); process.exit(1); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { jobs } = await r.json();
    if (failures) log("Connected again.");
    failures = 0;
    for (const job of jobs ?? []) void run(job);
  } catch (e) {
    failures++;
    if (failures === 1 || failures % 10 === 0) log(`Can't reach ${server} (${e.message}). Retrying…`);
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
  }
}
