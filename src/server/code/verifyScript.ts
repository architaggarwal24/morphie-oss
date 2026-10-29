/**
 * The program verify_project runs inside the project (as .morphie/verify.mjs, with Node). It is plain JavaScript with
 * no dependencies so it works the same in the Cloudflare container, on Linux, macOS and Windows:
 *
 *   detect → install → type-check → lint → build → test → start the app → load pages → screenshot → stop the app
 *
 * It reads its options from .morphie/verify.json, writes each step's full log to .morphie/logs/, and prints one JSON
 * report after the marker line. Kept free of backticks and "${" so it can live in this template string.
 */
export const VERIFY_MARK = "@@MORPHIE_VERIFY@@";

export const VERIFY_SCRIPT = String.raw`// Written by Morphie's verify_project. Safe to delete; it's recreated when needed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const root = process.cwd();
const opts = JSON.parse(fs.readFileSync(path.join(root, ".morphie", "verify.json"), "utf8"));
const skip = new Set(opts.skip || []);
const logs = path.join(root, ".morphie", "logs");
const shots = path.join(root, ".morphie", "shots");
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const win = process.platform === "win32";
const report = { steps: [], pages: [], screenshots: [], notes: [], noTests: false, kind: "unknown" };
const exists = (p) => fs.existsSync(path.join(root, p));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), "utf8")); } catch { return null; } };
const tail = (s, n) => { const lines = s.split(/\r?\n/); return lines.slice(Math.max(0, lines.length - n)).join("\n"); };

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]); else process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
}

function run(name, command, { timeoutMs = 300000, env = {}, warnOnly = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let timedOut = false;
    const child = spawn(command, { cwd: root, shell: true, detached: !win, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", ...env } });
    const take = (b) => { if (out.length < 4000000) out += b.toString(); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const log = path.join(".morphie", "logs", "verify-" + name + ".log");
      fs.writeFileSync(path.join(root, log), "$ " + command + "\n\n" + out);
      const ok = !timedOut && code === 0;
      const step = { name, command, ok, warnOnly, exitCode: code, ms: Date.now() - started, timedOut, log, tail: ok ? "" : tail(out, 60).slice(-6000) };
      report.steps.push(step);
      resolve(step);
    });
    child.on("error", (e) => { out += String(e); });
  });
}

function has(cmd) {
  const r = spawnSync(win ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

// ------------------------------------------------------------------ detect
const pkg = readJson("package.json");
const scripts = (pkg && pkg.scripts) || {};
const deps = Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies);
let pm = "npm";
if (exists("pnpm-lock.yaml")) pm = "pnpm";
else if (exists("yarn.lock")) pm = "yarn";
else if (exists("bun.lockb") || exists("bun.lock")) pm = "bun";
if (pm !== "npm" && !has(pm)) { report.notes.push(pm + " isn't installed here, so npm was used."); pm = "npm"; }
const runScript = (s) => (pm === "npm" ? "npm run " + s : pm + " run " + s);
const pyProject = exists("requirements.txt") || exists("pyproject.toml");
report.kind = pkg ? (deps.next ? "next" : deps.vite ? "vite" : deps.astro ? "astro" : "node") : pyProject ? "python" : exists("index.html") ? "static" : "unknown";

// ------------------------------------------------------------------ install
if (pkg && !skip.has("install")) {
  const nm = path.join(root, "node_modules");
  const stale = !fs.existsSync(nm) || fs.statSync(path.join(root, "package.json")).mtimeMs > fs.statSync(nm).mtimeMs;
  if (stale || opts.reinstall) {
    const cmd = pm === "npm" ? "npm install --no-audit --no-fund --loglevel=error" : pm === "yarn" ? "yarn install --non-interactive" : pm + " install";
    const s = await run("install", cmd, { timeoutMs: 420000 });
    if (s.ok) { try { const t = new Date(); fs.utimesSync(nm, t, t); } catch {} }
  } else report.notes.push("Dependencies were already installed.");
}
if (pyProject && !skip.has("install") && exists("requirements.txt") && (has("pip3") || has("pip"))) {
  await run("install-python", (has("pip3") ? "pip3" : "pip") + " install -q -r requirements.txt", { timeoutMs: 420000, env: { PIP_BREAK_SYSTEM_PACKAGES: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
}
const installFailed = report.steps.some((s) => s.name.startsWith("install") && !s.ok);

// ------------------------------------------------------------------ static checks
const buildScript = scripts.build || "";
if (pkg && !installFailed) {
  if (!skip.has("typecheck")) {
    const tc = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
    if (tc) await run("typecheck", runScript(tc));
    else if (exists("tsconfig.json") && !/\btsc\b/.test(buildScript) && fs.existsSync(path.join(root, "node_modules", "typescript"))) {
      const tsconfig = readJson("tsconfig.json");
      if (!(tsconfig && Array.isArray(tsconfig.references) && tsconfig.references.length)) await run("typecheck", "npx --no-install tsc --noEmit -p .");
    }
  }
  if (!skip.has("lint") && scripts.lint) await run("lint", runScript("lint"), { warnOnly: true });
  if (!skip.has("build") && buildScript) await run("build", runScript("build"), { timeoutMs: 480000 });
}
if (report.kind === "python" && !skip.has("build")) {
  const py = has("python3") ? "python3" : "python";
  await run("compile", py + " -m compileall -q -x \"(node_modules|\\.venv|venv)\" .", { timeoutMs: 120000 });
}

// ------------------------------------------------------------------ tests
if (!skip.has("test")) {
  const t = scripts.test || "";
  if (pkg && t && !/no test specified/i.test(t) && !installFailed) {
    const watchy = /\bvitest\b(?!\s+run)/.test(t) && !/--run\b/.test(t);
    await run("test", watchy ? runScript("test") + " -- --run" : runScript("test"), { timeoutMs: 420000 });
  } else if (report.kind === "python" && (exists("tests") || exists("test")) && (has("pytest") || has("python3"))) {
    await run("test", has("pytest") ? "pytest -q" : "python3 -m pytest -q", { timeoutMs: 420000 });
  } else if (report.kind !== "static" && report.kind !== "unknown") report.noTests = true;
}

// ------------------------------------------------------------------ start the app, load pages
const buildOk = !report.steps.some((s) => s.name === "build" && !s.ok);
function freePort() {
  return new Promise((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function startCommand(port) {
  const host = " --host 127.0.0.1";
  if (deps.next) return buildOk && exists(".next") ? "npx --no-install next start -p " + port : "npx --no-install next dev -p " + port;
  if (deps.vite) return buildOk && exists("dist") ? "npx --no-install vite preview --port " + port + " --strictPort" + host : "npx --no-install vite --port " + port + " --strictPort" + host;
  if (deps.astro) return buildOk && exists("dist") ? "npx --no-install astro preview --port " + port + host : "npx --no-install astro dev --port " + port + host;
  if (scripts.start) return runScript("start");
  if (scripts.dev) return runScript("dev");
  if (scripts.preview) return runScript("preview");
  return null;
}
const staticRoot = ["dist", "build", "public", "."].find((d) => exists(path.join(d, "index.html")));

async function fetchText(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, redirect: "follow" }); const body = await r.text(); return { status: r.status, type: r.headers.get("content-type") || "", body }; }
  catch (e) { return { status: 0, type: "", body: String(e && e.message || e) }; }
  finally { clearTimeout(t); }
}

let server = null;
let serverOut = "";
let base = null;
if (!skip.has("serve") && (pkg || staticRoot) && !installFailed) {
  const port = await freePort();
  const cmd = pkg ? startCommand(port) : null;
  if (cmd) {
    server = spawn(cmd, { cwd: root, shell: true, detached: !win, windowsHide: true, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", CI: "1", NODE_ENV: /next start|preview/.test(cmd) ? "production" : "development" } });
    server.stdout.on("data", (b) => { if (serverOut.length < 400000) serverOut += b.toString(); });
    server.stderr.on("data", (b) => { if (serverOut.length < 400000) serverOut += b.toString(); });
    report.serve = { command: cmd, port };
  } else if (staticRoot) {
    const dir = path.join(root, staticRoot);
    const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
    server = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      let f = path.join(dir, p);
      if (!f.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
      if (!fs.existsSync(f) && !path.extname(f)) f = f + ".html";
      if (!fs.existsSync(f)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
      res.writeHead(200, { "content-type": types[path.extname(f).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(f).pipe(res);
    }).listen(port, "127.0.0.1");
    report.serve = { command: "static files from " + staticRoot, port };
  }
  if (report.serve) {
    const started = Date.now();
    base = "http://127.0.0.1:" + port;
    let up = false;
    while (Date.now() - started < 120000) {
      if (server && server.exitCode !== null && server.exitCode !== undefined) break;
      const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/.exec(serverOut);
      if (m && m[1] !== String(port)) base = "http://127.0.0.1:" + m[1];
      const r = await fetchText(base + "/", 3000);
      if (r.status > 0) { up = true; break; }
      await new Promise((r) => setTimeout(r, 700));
    }
    report.serve.ok = up;
    report.serve.ms = Date.now() - started;
    if (!up) report.serve.tail = tail(serverOut, 60).slice(-6000) || "(the app printed nothing)";
    if (up) {
      for (const p of (opts.paths && opts.paths.length ? opts.paths : ["/"]).slice(0, 8)) {
        const r = await fetchText(base + p, 30000);
        const title = (/<title[^>]*>([^<]{0,120})/i.exec(r.body) || [])[1] || "";
        const overlay = /vite-error-overlay|nextjs__container_errors|__next_error__|Application error: a (?:client|server)-side exception|Internal Server Error|Traceback \(most recent call last\)/i.test(r.body);
        report.pages.push({ path: p, status: r.status, type: r.type.split(";")[0], bytes: r.body.length, title: title.trim(), ok: r.status >= 200 && r.status < 400 && !overlay, overlay });
      }
    }
  }
}

// ------------------------------------------------------------------ browser: rendered DOM + screenshot
function findBrowser() {
  const candidates = [process.env.CHROME_PATH, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
  for (const c of candidates) if (c && (path.isAbsolute(c) ? fs.existsSync(c) : has(c))) return c;
  const fixed = win
    ? [path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"), path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"), path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"), path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return fixed.find((f) => f && fs.existsSync(f)) || null;
}
// Asynchronous on purpose: a static site is served from this very process, so blocking here would starve it.
function browse(command) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, { shell: true, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (b) => { if (out.length < 20000000) out += b.toString(); });
    const timer = setTimeout(() => killTree(child), 60000);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
  });
}
if (base && report.pages.length && !skip.has("screenshot")) {
  const browser = findBrowser();
  if (!browser) report.notes.push("No Chrome/Chromium found here, so pages weren't rendered or screenshotted (set CHROME_PATH to enable it).");
  else {
    const q = (s) => (win ? '"' + s + '"' : "'" + s.replace(/'/g, "'\\''") + "'");
    // A fresh temporary profile each time (headless's default), no proxy for the local app.
    const flags = "--headless=new --disable-gpu --no-sandbox --hide-scrollbars --no-first-run --disable-dev-shm-usage --no-proxy-server --virtual-time-budget=6000";
    for (const pg of report.pages.filter((x) => x.ok).slice(0, 3)) {
      const url = base + pg.path;
      const html = await browse(q(browser) + " " + flags + " --dump-dom " + q(url));
      const body = html.replace(/<head[\s\S]*?<\/head>/i, " ");
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const visual = /<(canvas|img|svg|video|iframe)\b/i.test(body);
      pg.renderedChars = text.length;
      pg.renderedText = text.slice(0, 300);
      if (!html) report.notes.push("The browser couldn't render " + pg.path + " (it may not run here), so it wasn't checked visually.");
      // Nothing on screen at all: typically a single-page app that crashed while starting.
      if (html && !text && !visual) { pg.ok = false; pg.blank = true; }
      const file = path.join(shots, (pg.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home") + ".png");
      try { fs.rmSync(file, { force: true }); } catch {}
      await browse(q(browser) + " " + flags + " --window-size=1280,800 --screenshot=" + q(file) + " " + q(url));
      if (fs.existsSync(file)) report.screenshots.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
}

killTree(server);
if (server && server.close) try { server.close(); } catch {}
if (serverOut) fs.writeFileSync(path.join(logs, "verify-serve.log"), serverOut);
report.serverTail = tail(serverOut, 30).slice(-3000);
console.log("${VERIFY_MARK}");
console.log(JSON.stringify(report));
process.exit(0);
`;
