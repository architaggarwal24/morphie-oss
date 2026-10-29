# Morphie

A multi-provider AI workspace you run yourself: **Chat**, an autonomous **Agent**, a **Design studio**, **Documents** (RAG) and long-term **Memory**, all in one Next.js app with the backend built in.

- **Bring any model.** OpenAI, Anthropic, Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, Together, Fireworks, Cerebras, Perplexity, Ollama, LM Studio, APMIX.AI, and a fully configurable **OpenAI-compatible** option for everything else.
- **Real agent mode.** It plans, calls tools, reads the results, adapts, and pauses for your approval before doing anything that changes your files. You watch every step live.
- **Private by default.** Keys are encrypted on disk and never sent back to the browser. Everything lives in a local SQLite file.

## Editions

One codebase, two repositories:

| | **Community** (open source) | **Cloud** (hosted by you) |
|---|---|---|
| Who runs it | Anyone, on their own machine or Cloudflare account | You, for your users |
| AI | Bring your own keys (any provider) | **Morphie AI** (your keys, by plan) + own keys from Shape up |
| Plans, credits, payments | Off | Sketch / Shape / Shift / Morph, UPI checkout, Admin |
| Code projects | Server sandbox, Lite, Morphie Runner | the same |
| Switch | (default) | `MORPHIE_PLANS=on` + `MORPHIE_ADMIN_EMAILS` + `MORPHIE_AI_*` secrets |

Develop in the private (Cloud) repository. To publish, commit, then run `npm run export:oss -- ../morphie-oss`, where `../morphie-oss` is a clone of your public repository: it copies the files git tracks (never scratch or ignored files) with your deployment's ids replaced by placeholders, leaves out `hosted/` (your private overlay) and local state, removes files you deleted, keeps the public repo's git history, and refuses to finish if anything listed in `hosted/private-strings.txt` would leak. Then commit and push there. Because the hosted features are in the code but off unless `MORPHIE_PLANS=on`, the two editions never drift apart; contributions to the public repo can be pulled back in as they are.

Before the first push, add a license: put the `LICENSE` file in this (private) repository, so every export carries it (the export removes files in the public repo that don't exist here). For an open-core project whose hosted version is your business, **AGPL-3.0** is the usual choice: anyone may self-host and modify it, but someone running a modified copy as a service must publish their changes. MIT or Apache-2.0 allow closed forks.

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:3000 (or http://localhost:3000)
```

`npm run dev` listens on this machine only (`127.0.0.1`). That matters because in development the sign-in code is also shown in the popup (below). To reach the dev server from another device on purpose, run `npx next dev -H 0.0.0.0`, and know that anyone who can reach it can then sign in as any address with the code the popup shows.

Requires Node ≥ 22.13 (Morphie uses the built-in `node:sqlite`). Everything except viewing the page and the **Chat** tab needs an account. A visitor can look around and type in the Chat box; clicking any other tab, Send, or **Login / Sign up** opens a **Log in or sign up** popup: **email + password** (no mail server needed), or an **email code** (in development, with no mail server configured, the code is shown right in the popup and filled in for you, as well as printed to the terminal), or Google/GitHub when configured. Whatever you were about to do resumes afterwards: the tab you clicked, provider setup, and your typed draft (restored, never auto-sent). A brand-new account with nothing pending lands on **Settings → Providers**: add a provider, pick a model, and you're chatting. No `.env` needed locally.

Production: `npm run build && npm start`.

## Connecting any OpenAI-compatible provider

Settings → Providers → **OpenAI-compatible** (or Add provider → *OpenAI-compatible (custom)*). Everything is configured in the UI; nothing is read from environment variables.

| Field | What it does |
|---|---|
| **Preset** | Pre-fills the URL and defaults: CodeCraft API, LiteLLM, vLLM, llama.cpp, Azure OpenAI, or blank. |
| **Base URL** | Usually ends in `/v1`. Morphie appends `/chat/completions` and `/models`. |
| **API key** | Stored AES-256-GCM encrypted; shown only as `••••1234` afterwards. Leave blank for keyless local servers. |
| **Model** | Type any ID, or press **Fetch** to list the provider's models. |
| **Authentication** | `Authorization: Bearer`, `x-api-key`, `api-key` (Azure), a custom header name, or none. |
| **Extra headers** | Team/org IDs etc. Values are encrypted and never shown again. |
| **Query parameters** | e.g. `api-version` for Azure. |
| **Chat / models path** | Override `/chat/completions` and `/models` for non-standard gateways. |
| **Stream responses** | Turn off if a gateway breaks on streaming. |
| **Native tool calling** | Turn off and Morphie emulates tools with prompts, so agent mode works even on models/gateways without function calling. |
| **Temperature, Top P, max tokens, token parameter, timeout, system-prompt prefix** | Per-provider tuning. |

**Test connection** sends a one-word request and then probes tool calling, so you know up front whether agent mode will work. Example for [CodeCraft API](https://codecraftapi.com/docs/coding-agents): choose the *CodeCraft API* preset (`https://codecraftapi.com/v1`), paste your key, press **Fetch**, pick a model, **Save & use**.

You can save up to 24 providers and switch between them from the model chip in the composer or with <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>.

## Agent mode

Open the **Agent** tab and describe a task. Each run is a loop of *plan → act → observe*:

1. For multi-step work the agent writes a checklist (`update_plan`) that ticks off live in the task panel.
2. It calls tools, reads results, and adapts. Commentary, tool calls (with arguments, output, timing) and approvals form a collapsible timeline.
3. Risky tools pause and ask: **Allow**, **Deny**, or **Always allow this tool**. You can also ask before *every* tool, or auto-approve everything (with a warning).
4. It works **until the task is done**, within a **token budget** (Settings → Chat & agent, 20k–1M tokens per task, default 500k; a provider can set its own). Every model call of the run counts: sub-agents, summaries and memory too, with prompt-cache hits at a tenth. At 80% the model is told to wrap up; when the budget is spent it writes a status and the reply ends with **Continue**, which picks the run up where it stopped with a fresh budget. Errors, Stop, an unanswered approval and a server restart end the same way (a run lost to a restart in the last 15 minutes continues by itself when you open it). There is no step setting: the agent takes as many steps as the task needs, and only a server-side safety cap (`MORPHIE_MAX_AGENT_STEPS`, default 300) catches a model that loops. If a model forgets to tick off its checklist, it's shown its own plan again every few rounds.
5. **Runs keep going without you.** Close the tab or lose the connection and the run carries on; the sidebar shows it as *Working…*, and opening the conversation (on any device) follows it live from where it is. Only **Stop** stops it. On Cloudflare each conversation's runs live in their own Durable Object (`AgentRunner`); on Node, in the server process.
6. **Tasks that need code get a real project.** Asked to build an app, a site or a script, the agent calls `create_project` (subject to your approval setting: it asks under "Ask", it just does it under "Auto-approve"), moves the task into the new project and works there with the code tools below.
7. **It feels alive.** Between steps a live line says what it's doing right now (*Thinking*, *Writing src/app/page.tsx · 2.4k chars*, *Preparing: npm test*), with a timer. Before a big or open-ended task it may ask you **1–4 multiple-choice questions** in a card (pick options, type your own, or *Skip, use your judgment*) instead of guessing; an unanswered card pauses the run after 30 minutes. In another tab? It chimes, shows a desktop notification and marks the tab title when a task finishes, pauses or needs you (Settings → Chat & agent).
8. **It delivers files, not steps.** A finished reply lists what it produced: up to 10 files to download one by one, more as a single zip named after the project (`friday-landing.zip`, without `node_modules`, build output or `.git`).

| Tool | Modes | Asks first |
|---|---|---|
| Calculator (safe recursive-descent parser, no `eval`) | chat, agent | no |
| Clock (any city or IANA timezone) | chat, agent | no |
| Web search (Tavily key in Settings → Tools) | chat, agent | no |
| Search documents (your uploads) | chat, agent | no |
| Read web page (public pages only; SSRF-hardened) | agent | no |
| Plan checklist | agent | no |
| Workspace list / read | agent | no |
| Workspace write / delete (sandboxed folder, 200 KB per file) | agent | **yes** |
| Save memory | agent | **yes** |
| Design a website (calls the Design agent) | agent | no |
| Create project (when the task needs code that runs) | agent | **yes** |
| Ask you questions (multiple choice, `ask_user`) | agent | no |
| Use a skill / read a skill's file | agent | no |

Text returned by tools (web pages, documents, files) is wrapped as **untrusted data** and the model is told never to follow instructions inside it. Repeated identical tool calls are cut off. Files the agent writes appear in the task panel with view, download and delete.

### Skills

Skills are playbooks in the [Agent Skills](https://agentskills.io) format (a folder with a `SKILL.md`: `name` and `description` front-matter, then instructions, plus optional scripts and references), the same format Claude Code uses, so skills written for it work here.

- **Loaded when they match:** only each skill's name and description sit in the agent's instructions; when a task matches, it calls `use_skill` to load the full playbook (and `read_skill_file` for its references). In a code project the skill's text files are copied into `.morphie/skill-files/<name>/` so its scripts can run.
- **You decide too:** type `/skill-name your task` in the agent to use one for that message, **pin** one (Settings → Skills) to use it on every task, switch any off, or mark one `disable-model-invocation: true` so it's only used when you ask.
- **Built in:** clarify-first, plan-and-track, scaffold-web-app, tdd-loop, debug-systematically, verify-before-done, review-changes, write-a-skill, frontend-aesthetics, accessible-ui and landing-page-copy.
- **Library:** one-click installs of popular open-source skills straight from their repositories (Anthropic's `anthropics/skills`, `obra/superpowers`, `mattpocock/skills`, `vercel-labs/agent-skills` and more; each keeps its own license, install counts from skills.sh).
- **Add your own:** paste a GitHub link (a skill folder, or a repository to pick from), upload a `SKILL.md`, a `.zip` or a `.skill` file, write one in the editor, or use **Make a skill from this conversation** in a task's header. A project's own `.morphie/skills/` or `.claude/skills/` folders are picked up automatically and win over installed ones with the same name.
- **Design agent:** skills marked *Design* or *Agent + Design* guide the Design agent too: the relevant ones are applied automatically, or pick them in the composer's *Skills* chip.

### Code projects (the Claude Code–style agent)

Pick a **project** in the Agent header (clone a repository, `owner/repo` for GitHub, or start empty) and the agent becomes a coding agent working on that repository in an isolated sandbox:

- **Tools:** `bash`, `read_file`, `edit_file` (exact string replacement), `write_file`, `list_files`, `glob`, `grep` (ripgrep syntax), `task` (read-only **sub-agents**, several run in parallel), `update_plan` (the todo list), `verify_project` and `create_pull_request`. The private-workspace tools are hidden inside a project.
- **Done means verified:** `verify_project` installs dependencies (npm/pnpm/yarn/bun, pip), type-checks, lints, builds and runs the tests, then starts the app (Next, Vite, Astro, `npm start`/`dev`, or a static server for plain HTML), loads its pages, and renders and screenshots them in headless Chrome/Chromium when one is available (screenshots go to models that accept images). Every failure comes back with the end of its log; full logs are in `.morphie/logs/` (kept out of git). A run that built something can't end until it has verified (or explained exactly what can't pass), and a project without tests is asked for a few basic ones. Allow it once with the rule `Verify`.
- **Diffs you control:** every edit is previewed as a diff in the approval card. The **Changes** panel shows `git status` + the full diff; **accept** (stage) or **reject** (revert) per file or all at once, commit, push, and open a pull request.
- **Live preview** (the Preview tab): with the local sandbox (`npm run dev`), **Start dev server** runs the project's dev server in the background (`next dev`, `vite`, `astro dev`, or its `dev`/`start` script, installing dependencies first) and shows the app live as the agent edits; it stops when you stop it or after 20 minutes nobody's looking. Static sites (an `index.html`, or a build's `dist/`) show under **Files** and reload as files change, and **Shots** shows the screenshots from `verify_project`. Previews run in a sandboxed frame with their own opaque origin, served through a signed link that expires after 6 hours, so a project's scripts can never act as you. On Cloudflare there's no live dev server: the preview shows the static files and screenshots.
- **Checkpoints and rewind:** before each task in a project Morphie snapshots the files (a git commit built through a private index, kept under `refs/morphie/`, so your staging area, branches and `git log` are untouched). Hover one of your messages and press **Rewind** to put back the code, the conversation (your message returns to the composer), or both. Rewinding the files saves their current state first, so the toast offers **Undo files**.
- **Terminal:** the agent's commands stream into the Terminal panel, and you can run your own there too. **Files** browses the tree with a syntax-highlighted viewer.
- **Plan mode** (the Plan chip, `Shift+Tab` or `/plan`): read-only research, then `exit_plan_mode` shows a plan you approve before anything changes.
- **Permission rules**, like Claude Code's: `Bash(npm test *)`, `Bash(git status)`, `Edit(src/**)`, `Read(**/.env)`, `WebFetch(domain:github.com)`. Allow rules skip the prompt, deny rules refuse outright (deny wins). Compound commands are split (`a && b`) and every part must be allowed; `$(…)`, backticks and file redirects always ask. "Always allow" on a command saves a narrow rule (`Bash(npm test *)`), not the whole tool. A repository's own `.morphie/settings.json` may add **deny** rules only.
- **Project memory:** `MORPHIE.md` (or `CLAUDE.md` / `AGENTS.md`) at the root is read into every task. `/init` writes one.
- **Slash commands:** `/plan`, `/clear`, `/help`, `/init`, `/review`, `/commit`, `/pr`, `/test`, `/explain`, `/fix`, plus your own Markdown files in `.morphie/commands/` or `.claude/commands/` (`$ARGUMENTS`, `$1`… are filled in; `description:` / `argument-hint:` front-matter is shown in the menu).
- **GitHub:** add a token in Settings → Tools (fine-grained: Contents + Pull requests read/write). It is stored encrypted and never enters the sandbox: on Cloudflare the sandbox's outbound gateway adds it to GitHub requests; locally it's provided through a git credential helper that reads it from the environment.

Where projects run: on **Cloudflare**, one Linux container per project (Cloudflare Sandbox SDK, `worker/sandbox.ts`), with no direct Internet (only GitHub and package registries are reachable) and the project folder backed up to R2 after every run; on **Node**, a folder under `MORPHIE_DATA_DIR/projects/` and your local shell (`bash`, or Git Bash on Windows). Local projects are on by default in development; in production set `MORPHIE_LOCAL_SANDBOX=1` (commands then run as the server's user, so keep approvals on).

## The other tabs

- **Chat:** streaming Markdown with code highlighting, edit-and-re-run, regenerate, searchable history grouped by date, pinning, renaming.
- **Design:** describe a site and get a validated design with live preview (desktop / tablet / mobile), tweak it in plain language ("make it darker"), undo/redo, 20-version history, 7 theme presets, and export to **HTML + CSS** or a **React (Vite)** project as a `.zip`. Previews run in a fully sandboxed iframe (no scripts).
  - **Visual editing:** turn on *Edit visually* and click any text in the preview to edit it in place (Enter saves, Esc cancels); click a section to move it, duplicate it or delete it; change palette colours from the details panel. Every edit is one undoable version, re-validated like everything else. The editor frame may run exactly one nonce'd script, in a sandbox without same-origin access, and the page accepts only well-formed messages from that frame.
  - **Design systems** (the *Systems* switch in the Design sidebar): generate one from a **description**, a **website** (colours, fonts and corner radii are measured from the page and its stylesheets, then the model assigns roles), a **screenshot** (its palette is extracted in your browser; the image never leaves the device) or an **existing design**. A system holds ten colour roles (with generated 50–950 ramps), heading/body/code fonts, a modular type scale, spacing, radii, elevation, voice and do/don't guidelines, and comes with a living **documentation page** (contrast scores, specimens, components and page patterns rendered in its tokens). Edit tokens and the docs update live. **Apply** a system to any design (an undoable version) or start new designs from one; **export** it as CSS variables, Tailwind (v4 `@theme` + v3 config), W3C design tokens JSON, or a small React component kit.
- **Documents:** PDF, Word, text, Markdown, CSV, JSON. Indexed locally (hashed embeddings + keyword scoring; no embedding API needed) and used automatically by Chat and Agent with file-name citations.
- **Memory:** short facts saved only from what *you* say, never secrets or instruction-like text. Fully editable.
- **Settings:** providers, agent defaults (token budget, helper model, approvals), tools, **Usage**, theme, data export, delete-everything.
  - **Usage:** tokens by day (input, cached input, output), by feature (chat, agent, code, sub-agents, summaries, memory, design…), by model, and the conversations and designs that used the most. Every model call is recorded; providers that don't report usage are estimated (marked *).
  - **Helper model:** pick one of your saved providers for research sub-agents, summarising long runs and memory. A small, fast model there saves most of a long task's tokens.

### How Morphie keeps token use down

- **Prompt caching:** system prompts put everything that never changes first; Anthropic gets explicit cache breakpoints (system, tools, the newest message), and OpenAI-compatible providers with automatic prefix caching reuse the same prefix. Cached tokens are reported per reply and on the Usage page.
- **Small tool output:** files are read 600 lines at a time by default, long command output keeps its start and end (the rest goes to a log file the model can grep), searches return fewer matches.
- **Old results are cleared, long runs are summarised:** once tool output piles up, older results become one-line stubs (all at once, so the cached prefix stays valid in between); near 60% of the model's context window the middle of the run is summarised by the helper model while the task and the latest steps stay verbatim. Set a provider's context window and whether it accepts images in its advanced options.
- **Design:** simple edits ("remove the pricing section", "rename it to …", "more rounded", "use Inter") are applied without the model; the rest are small operations on the current design, and a nearly valid new design is fixed with operations instead of being written again.

## Look and feel

The UI ("Aurora") is dark-first with a light theme: glass panels over slow-drifting violet/pink/cyan colour fields, a dock-style rail whose icons magnify under the pointer, highlights that spring between tabs, list items and palette rows (Motion `layoutId`), suggestion cards that tilt and light up under the cursor, a magnetic send button, blur-in headlines with gradient text, a light beam around the composer while Morphie works, and a living orb as Morphie's avatar. Built with [Motion](https://motion.dev) 14.1 and [Radix](https://www.radix-ui.com) primitives (tooltips, account menu) on Tailwind 4; the effects kit is `src/components/fx.tsx` and the tokens and CSS effects are in `src/app/globals.css`. Text meets 4.5:1 contrast in both themes. With the OS's *reduce motion* setting everything is still: Motion follows it through `<MotionConfig reducedMotion="user">`, and a global CSS rule freezes every keyframe and transition.

## Interaction details

- **Loading:** lists and chat history show gray placeholder rows in the real layout, but only if loading takes longer than 300 ms. Data already seen is shown at once and refreshed in the background on every revisit, when the window regains focus, and when the network comes back.
- **Deleting** a chat, task, design, document, memory or workspace file happens immediately with an **Undo** toast for 7 s; the request is only sent afterwards (or right away if you close the toast or the page). Bulk and irreversible actions (Clear all memories, Remove provider, Delete everything) still ask first.
- **Optimistic:** switching provider, pinning and renaming update at once and roll back with a message if the server refuses.
- **Keyboard:** <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> searches every page, setting, recent chat and action. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>⇧</kbd>+<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> undo and redo the design, never while you're typing in a field. Shortcuts are shown with ⌘ on Apple devices and Ctrl elsewhere.
- **Motion:** menus, toasts and dialogs use transitions that reverse from where they are when interrupted; tab switches are a 180 ms view transition. Everything is instant with *reduce motion*.
- **Touch & screens:** controls grow to 44 px on touch screens; the layout respects the notch and home indicator (`viewport-fit=cover` + `env(safe-area-inset-*)`).

## Architecture

```
src/
  app/                 Next.js App Router: one page + /api route handlers
  components/          React UI (chat/, design/, library/, settings/, ui primitives)
  lib/                 client store (Zustand), SSE client, agent-event reducer, shared types
  middleware.ts        per-request CSP nonce
  server/
    providers/         OpenAI-compatible · Anthropic · Gemini · Ollama · prompted-tools fallback · catalog
    agent/             the plan→act→observe loop, approvals, prompts
    tools/             calculator, clock, web search, fetch_url, documents, workspace, plan, design
    design/            schema, components, themes, renderer, operations agent, versioned service, export
    rag/               loaders, chunker, local embeddings, SQLite search
    memory.ts  profiles.ts  conversations.ts  settings.ts  workspace.ts
    http.ts  security.ts  crypto.ts  db.ts  sse.ts
tests/                 tests (providers, agent loop, API, sessions, login, ownership, SSRF, design parity, RAG, UI flows)
```

Data lives in `./data` (`morphie.db`, `.encryption_key`, `.session_secret`, `workspace/`).

## Security model

- **Keys:** AES-256-GCM at rest; never returned by any endpoint or included in exports. Error text is scrubbed of key material.
- **Accounts only:** there is no guest mode. A visitor who hasn't signed in has no identity, no cookie and no database rows; they can load the page, use the Chat box as a plain text field, and start the login flow, and every other route answers `401`. In the UI that means the Chat tab only: the other tabs are listed as *log in required* and open the login popup instead of switching, Settings is replaced by **Login / Sign up** until there is an account, and the command palette's navigation and action commands open the popup too (theme commands still work). Every row is scoped to the signed-in account.
- **CSRF:** cross-origin writes are rejected (Origin / Sec-Fetch-Site check).
- **CSP:** per-request nonce with `strict-dynamic`; `frame-ancestors 'none'`; remote images are blocked and rendered as links.
- **SSRF:** every outbound call (providers, `fetch_url`, web search, email API) goes through `guardedFetch`, which resolves the name, rejects private/loopback/link-local/IPv4-mapped/NAT64/6to4 addresses, and connects to exactly the addresses it validated, so DNS rebinding and redirects can't slip through. Provider URLs may be local only where `MORPHIE_ALLOW_PRIVATE_URLS` allows it (default: true in development, **false in production**); `fetch_url` never allows it.
- **No code execution:** nothing model- or user-provided is ever `eval`'d or run. The agent's file tools are confined to a per-user sandbox directory (no `..`, no symlinks, no dotfiles).
- **Uploads:** extension allow-list plus content sniffing, size caps, zip-bomb inspection for DOCX, content-hash de-duplication.
- **Design output:** model JSON is validated against a strict allow-listed schema, all text is escaped in HTML and JSX, and the preview is sandboxed with its own CSP.
- **Rate limits** on chat, design, uploads, provider tests.
- **Idempotency keys:** sending, designing, uploading, adding a memory and saving a provider each carry an `Idempotency-Key` made when you start the action. A connection that drops is retried automatically with the same key, and `route()` runs a keyed POST at most once per account: a repeat gets the stored answer (`idempotent-replayed: true`), `409 idempotency_in_progress` while the first is running, `409 idempotency_replayed` for a stream that already started, `422` if the key is reused for a different request. Failures aren't stored, so they can be retried. Kept in memory for 24 h (`src/server/idempotency.ts`), like the rate limits.

## Accounts and sessions

- **Sessions** are opaque: the cookie holds 32 random bytes and the database stores only their SHA-256, so a leaked database can't be replayed as cookies. Over https the cookie is `__Host-morphie_session` (Secure, no Domain); over plain http (localhost) it is `morphie_session`. Always `HttpOnly; SameSite=Lax`.
- **Sign-in is also sign-up.** The email code, Google and GitHub flows create the account the first time a verified address completes them. Nothing is created before that: asking for a code, starting an OAuth redirect or loading `/api/bootstrap` leaves no user, session or cookie behind. Signed-in sessions last up to 30 days (14 idle, both configurable). Tokens are rotated on login; sign out revokes immediately; "Sign out everywhere" revokes every session of the account. If a session ends while the page is open, the next request answers `401` and the page drops back to the logged-out view (Chat only), clearing everything of the account from memory.
- **Every route declares who may call it** (`route({ auth: "public" | "user" }, ...)`; leaving it out, or writing any other level, is a type error). The only `public` routes are the page's own needs: `/api/bootstrap` (anonymous callers get just the version, the login methods and `session: null`; signed-in users get the full payload), `/api/auth/session`, `/api/health` and the login/logout flow. All SQL lives in `src/server/data/`, where every function takes an `Actor` and scopes by owner. `tests/anonymous.test.ts` discovers every route file, pins the exact list of public routes, and calls every other route with no cookie (expecting `401` and no new `users` or `sessions` rows); `tests/ownership.test.ts` fails on a route that takes an id without a cross-user test.
- **Login methods:** an email code (6 digits, 10 minutes, single use, 5 tries, 60 s resend cooldown, stored only as a keyed hash; answers are identical for known and unknown addresses), Google, and GitHub. Accounts link **only by verified email**: an unverified provider email never creates or links anything. At least one method must be configured in production, or nobody can sign in.
- **Email + password** (`/api/auth/password/signup`, `/api/auth/password/login`): on by default, off with `MORPHIE_PASSWORD_LOGIN=false`. Passwords are 10 to 200 characters, stored only as scrypt hashes (N=2¹⁵, r=8, p=1, 32-byte salt). A wrong password and an unknown address get the same answer after the same work; attempts are limited per IP and per address (10 per 15 minutes). Sign-up does say when an address already has an account, which the email-code flow never reveals: that's the price of a sign-up form.
- **Unverified addresses and takeover.** A password account's email isn't proven, so it links to nothing. When the address is later proven (email code, Google or GitHub), the proven owner takes the account over: its password is removed and every session signed out, and the login says so. Without that rule, someone could register your address first and be inside your account the day you sign in with Google.
- **Forgot password?** in the popup switches to an email code (where email works); after logging in, set a new password in **Account**. Without a working mailer, an operator can run `npm run reset-password -- someone@example.com` on the server: it asks for the new password twice (not echoed), stores it the way the app does and signs that account out everywhere.
- **Account page** (Settings → Account, or the avatar at the bottom of the rail): edit your display name; see whether your email is verified; set or change a password (changing needs the current one and signs out your other devices); see Google/GitHub link status; list every signed-in device with browser, OS, IP and last activity and sign any of them out; delete the account (type your email to confirm), which removes everything it owns.
- **A magic link is deliberately not offered**: it would only sign in whichever browser opens it, which breaks the "type the code in the same tab" flow.
- **The login popup** is the shared `Dialog` (labelled, focus-trapped, closes with Esc, an outside click or the X, and returns focus to whatever opened it) over a dimmed, blurred page that is `inert` while it is open. For Google/GitHub the page leaves and comes back, so only `{ tab, draft }` is kept in `sessionStorage` across the round trip and it is removed as soon as it is read.

### Setting up sign-in

Set `MORPHIE_PUBLIC_URL` first (e.g. `https://morphie.example.com`; `http://localhost:3000` is fine for development). Redirect URIs must match exactly.

**Email codes.** Pick a transport with `MORPHIE_EMAIL_TRANSPORT`:
- `smtp`: set `MORPHIE_SMTP_URL` (for example `smtps://user:password@smtp.example.com:465`) and `MORPHIE_EMAIL_FROM`.
- `resend`: set `RESEND_API_KEY` (and verify your sending domain in Resend) and `MORPHIE_EMAIL_FROM`.
- Development only: with nothing set, codes are printed to the server console **and handed to the popup**, which shows and fills them in (so signing in locally just works). The console transport is refused in production at startup and again when the transport is created.

**Not getting a code?** The popup says why where it can:
- *"Development mode: no email is sent."* You are on the console transport. Nothing is emailed; the code is printed in the terminal running `npm run dev`, on lines starting with `[email:dev]`.
- *"We couldn't send the email just now."* The mail server rejected the send. The server log has the reason on a line starting `[auth] couldn't send the sign-in email`, with what to check (usually `MORPHIE_SMTP_URL`, or a `MORPHIE_EMAIL_FROM` your provider won't send from; for Resend, `RESEND_API_KEY` and a verified domain). SMTP connections give up after 10 seconds instead of nodemailer's two minutes, so this shows up quickly.
- Nothing at all, and no warning: check spam, then the resend limits (one code per address per minute, five per hour).

**Google.** In Google Cloud Console → APIs & Services → Credentials → *Create credentials → OAuth client ID* → *Web application*. Add the authorised redirect URI `<MORPHIE_PUBLIC_URL>/api/auth/oauth/google/callback`. Configure the consent screen (scopes `openid`, `email`, `profile` are all that's requested). Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Only accounts whose email Google reports as verified can sign in.

**GitHub.** Settings → Developer settings → OAuth Apps → *New OAuth App*. Authorization callback URL: `<MORPHIE_PUBLIC_URL>/api/auth/oauth/github/callback`. Put the client id and a generated client secret in `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. The scope requested is `user:email`; Morphie uses the **verified primary** address from `/user/emails` (never the public profile email).

PKCE (S256) and a browser-bound `state` are used for both. There is no OAuth library: the flow is a small, tested module (`src/server/auth/oauth.ts`) because the commonly used one (Arctic) is marked deprecated on npm.

### Upgrading from a build that had guests

Earlier builds could create anonymous "guest" users (and, before sessions existed, an anonymous `morphie_uid` cookie). Both are gone. Migration `003_remove_guests` runs once at startup: it prints a **dry-run count** (guest users, how many were old pre-session identities, their sessions, and rows per table) and only then deletes those users with their sessions, data and workspace folders, and drops the columns that only existed for them. A row counts as a guest only if it is flagged as one **and** has no email, so an account can never be caught by it. An empty database prints nothing.

To see the same numbers before upgrading, run this against `data/morphie.db`: `SELECT COUNT(*) FROM users WHERE is_guest = 1 AND email IS NULL;`

`SESSION_SECRET` is still required in production, but nothing signs with it any more (it only verified the old cookie).

## Releasing

Never ship `data/` (database, keys, workspace). `npm run release:zip` builds `morphie.zip` from an allow-by-exclusion tree walk and re-checks the result; `npm run check:release -- some.zip` (or `-- --tree`) fails on `data/`, `.env*`, `*.db*`, key files, `node_modules` and `.next` at any depth.

## Plans and Morphie AI (hosted edition)

Off unless `MORPHIE_PLANS=on`. Without it Morphie is exactly the open-source app: bring your own keys, no limits, and none of the code below touches the database.

With plans on, the server provides **Morphie AI**: models it runs on its own keys (`MORPHIE_AI_*`), shown in the composer's model menu next to anyone's own providers. Four plans:

| Plan | Models (adds) | Usage limits (defaults) | Also |
|---|---|---|---|
| **Sketch** (free) | Gemini 3.8 Flash, Gemini 3.5 Flash-Lite | 50 free-model credits a day · 2 projects · 5 documents · 5 designs · 200k-token tasks | |
| **Shape** ₹499 / $7 | GPT-6 Luna, GPT-6.1 Terra, Claude Haiku 5.5 | 300 premium credits a month (100 a day) · 100 free a day · 5 projects · 25 documents · 25 designs · 2 design systems · 400k tasks | own keys, skill imports, GitHub repos, web search |
| **Shift** ₹1,499 / $19 | GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 3.1 Pro | 1,000 a month (300 a day) · 200 free a day · 20 projects · 50 documents · 100 designs · 10 design systems · 1M tasks | + sub-agents |
| **Morph** ₹3,999 / $49 | Claude Opus 5.5, Claude Fable 5.1, GPT-6 Astra, Gemini 4 Argon | 2,500 a month (800 a day) · 400 free a day · 100 projects · 500 designs · 30 design systems | everything |

Yearly is ten times the monthly price (two months free).

- **Credits:** 1 credit = $0.01 of model use at the vendor's list price (cache hits are cheaper), so Opus uses credits about 40× faster than Haiku. Premium models use the monthly credits (with a daily cap); the free Gemini models use a separate daily allowance, so nobody is ever locked out. When premium credits run out mid-task the run pauses (Continue picks it up), or, if the person allows it (Settings → Plan), carries on with the free model.
- **Admins** (`MORPHIE_ADMIN_EMAILS`, verified email) get Settings → Admin: give any email a plan for a time or until removed (even before they sign up), with or without limits; add bonus credits; edit every plan's limits, features and prices and the model list (prices, which plan has which model, on/off); and set a **monthly budget per vendor**: past 80% the Spend tab warns, at 100% that vendor's models pause for everyone until next month.
- Plans only apply to **verified** emails.

### Payments: UPI with no gateway fees

Settings → Admin → Payments: turn on UPI checkout and enter your UPI ID. "Get Shift" then makes an order for the plan's ₹ price plus a few paise that make the amount unique (₹1,499.37), shows a QR code (and an "Open in a UPI app" button on phones), and asks for the 12-digit UPI reference (UTR) after paying. $ prices show "coming soon" until a card gateway is added.

A payment is confirmed either way:

- **By you:** the To check list in Admin → Payments shows the amount and UTR; check your bank app, then Approve (or Reject with a reason the buyer sees). You can also paste a bank alert there and it finds the order.
- **Automatically from your bank's alert emails** (Cloudflare): set `MORPHIE_INBOUND_SECRET` (24+ characters), enable Email Routing on your domain, add a custom address (say `payments@your-domain`) whose action is *Send to a Worker → morphie*, and send your bank's credit alerts there (set it as the alert address, or auto-forward them). In Admin → Payments, turn on *Confirm automatically* and enter your bank's email domain (`hdfcbank.net`, `icicibank.com`…). Every alert must carry a valid **DKIM signature** from that domain (checked against the bank's key in DNS) with a matching From address; otherwise it is ignored. Its amount (and UTR) are matched to the open order, and the plan switches on within a minute.

A paid order starts the plan today for a month or a year; paying again for the same plan adds to its end date. Buyers and admins get an email when it's confirmed (if email sending is set up). Apply `0008_payments.sql` with the other migrations.
- Cloudflare: apply `0007_plans.sql` (`npx wrangler d1 migrations apply morphie --remote`) and set the variables above as secrets.

## Configuration

See `.env.example` for every setting and its default. In production the server refuses to start without valid `ENCRYPTION_KEY` and `SESSION_SECRET`.

## Deploying

Two supported shapes. The code picks its storage at runtime: **Cloudflare D1 + R2** when running on Workers, a **local SQLite file + data folder** everywhere else (`next dev`, `next start`, tests). The same async data layer (`src/server/db.ts`, `src/server/blobs.ts`) sits over both.

### Deploying to Cloudflare (Workers + D1 + R2 + a Durable Object)

One-time setup:

```bash
npx wrangler d1 create morphie                 # put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create morphie-files    # the FILES bucket (agent workspace files)
npx wrangler d1 migrations apply morphie --remote
npx wrangler secret put ENCRYPTION_KEY         # >= 32 chars; back it up
npx wrangler secret put SESSION_SECRET         # >= 32 chars, different from the key
npx wrangler secret put MORPHIE_PUBLIC_URL     # https://your-domain (or set it under "vars")
```

**Agent runs on Cloudflare** live in the `AgentRunner` Durable Object (one per conversation, declared in `wrangler.jsonc`), so they continue after the browser closes; an alarm keeps the object awake while a run is in progress. Upgrading from an earlier version: apply the new D1 migrations (`0005_usage.sql`, the usage ledger; `0006_skills.sql`, installed skills) with `npx wrangler d1 migrations apply morphie --remote`.

**Code projects on Cloudflare** use [Containers](https://developers.cloudflare.com/containers/) (Workers Paid plan). `wrangler deploy` builds `sandbox/Dockerfile`, so **Docker must be running** on the machine that deploys (Docker Desktop on Windows/macOS). The first deploy with containers can take a few minutes while the image uploads. Don't want code projects on Cloudflare yet? Remove the `containers` block, the `SANDBOX` binding and the `MorphieSandbox` export from `wrangler.jsonc`; everything else keeps working and the project picker simply doesn't appear.

Deploy: `npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy`. In **Workers Builds** use the deploy command
`npx wrangler d1 migrations apply morphie --remote && npx opennextjs-cloudflare deploy` so new migrations go out with the code.

- **Schema changes go in two places:** a new numbered file in `migrations/` (D1) and a step in `src/server/migrations.ts` (local SQLite). `tests/d1-schema.test.ts` fails if they drift. Never edit an applied migration file.
- **Email on Workers:** use `MORPHIE_EMAIL_TRANSPORT=resend` (SMTP needs raw sockets, which Workers doesn't offer to nodemailer; Morphie refuses it there with a clear message).
- **Outbound calls** (AI providers, `fetch_url`, OAuth): on Workers, hosts are checked over DNS-over-HTTPS before connecting and private addresses are refused; Workers itself can't reach private networks, which closes the rest of the rebinding window. Local providers (Ollama, LM Studio) can't be reached from Cloudflare.
- **Check it locally on the real runtime:** `npx opennextjs-cloudflare build`, `npx wrangler d1 migrations apply morphie --local`, put the secrets in `.dev.vars`, then `npx wrangler dev`.
- `npm run test:cloudflare` runs the whole test suite through the D1 and R2 code paths (an in-process D1/R2 look-alike).

### On the Workers Free plan

`wrangler.free.jsonc` is `wrangler.jsonc` without the code-project containers (they need Workers Paid), with two settings for the free plan's limits: `MORPHIE_SANDBOX=none` (no code projects; the agent works with its workspace files and can still build static sites there) and `MORPHIE_RUN_SLICE_STEPS=6` (a free invocation may make only 50 outbound requests, so an agent run carries on in a fresh Durable Object invocation every six steps; it stays one run, one stream and one reply). The Worker is built with webpack (`open-next.config.ts`), which keeps it at about 2.8 MB gzipped, under the free plan's 3 MB.

In **Workers Builds** use:

- Build command: `npx opennextjs-cloudflare build`
- Deploy command: `npx wrangler d1 migrations apply morphie --remote -c wrangler.free.jsonc && npx wrangler deploy -c wrangler.free.jsonc`

Moving to Workers Paid later: switch the deploy command back to `wrangler.jsonc` (with Docker available for the container image). `tests/slices.test.ts` keeps the two configs in step.

### Where code projects run

Each project picks its place when it's made (New project → *Where it runs*):

- **This server / Cloud sandbox**: the server's own sandbox (a local folder with `MORPHIE_LOCAL_SANDBOX=1`, or a container per project on Workers Paid).
- **Lite**: files only, kept in R2 / the data folder, no shell. It works on every plan (Workers Free included) and costs nothing to run: the agent builds plain HTML/CSS/JS sites with the file tools and the Preview tab serves them. Shell tools (bash, verify_project, pull requests) are left out.
- **Morphie Runner**: your own computer or VM. Settings → Runners → *Add runner* gives a one-line command (`node morphie-runner.mjs --server … --token …`, Node 18+, no dependencies; the script is served at `/morphie-runner.mjs`). It connects out to Morphie and long-polls for work, so no ports are opened; each project is a folder under `~/morphie-projects` and the agent's commands run there as you, with your tools. Only a hash of the runner's token is stored; removing the runner revokes it.

### Running on your own server (Node)

- **Persistent disk required.** The SQLite file and workspace folder live under `MORPHIE_DATA_DIR` (default `./data`); use a VM/container with a volume.
- **Run one instance.** Without the Durable Objects, approvals, rate-limit counters, the per-conversation "busy" lock and running agent runs are in process memory (a restart turns a running task into a paused one you can Continue).
- **Code projects** need `git` (and `bash`; on Windows, Git for Windows provides it) and `MORPHIE_LOCAL_SANDBOX=1`.
- **On a cloud VM, lock down its metadata service.** The local sandbox runs the agent's commands on the server, and the sandbox can reach whatever the server can. On AWS require IMDSv2 with a hop limit of 1 (`aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 1`), give the instance a role with no more than it needs, and do the same on other clouds (GCP/Azure: no broad service-account scopes). Better still, run code projects on Morphie Runners or the Cloudflare sandbox rather than on the server itself.

### Either way

- **Set `ENCRYPTION_KEY` and `SESSION_SECRET`** (required in production; back them up: losing the encryption key makes stored provider keys unreadable), set **`MORPHIE_PUBLIC_URL`** and (behind a reverse proxy) **`MORPHIE_TRUSTED_PROXY`**, and serve over https (private URLs are already off by default in production).
- **On Cloudflare the visitor's IP comes from `CF-Connecting-IP`** (set by Cloudflare's edge), so `MORPHIE_TRUSTED_PROXY` isn't needed there. Sign-in, sign-up and email-code limits are kept in the database so they hold across every Worker instance; new passwords are checked against known breaches (Have I Been Pwned, k-anonymity; `MORPHIE_BREACHED_PASSWORD_CHECK=off` to skip) and the whole site sends at most `MORPHIE_EMAIL_HOURLY_CAP` sign-in emails an hour (default 300).
- **Configure at least one sign-in method** (email transport, Google or GitHub; see *Setting up sign-in*). There is no guest mode, so a deployment with none configured shows a login popup nobody can use.

## Testing

```bash
npm test                 # local SQLite + data folder
npm run test:cloudflare  # the same suite through the D1 + R2 code paths
npm run typecheck
```

Covered: every provider wire format (mock servers, including prompt-cache usage and images), the agent loop (approvals, denial, step limit, token budget and Continue, context clearing and compaction, create_project, the verify gate, deliverables, loop guard, stop, prompt-injection wrapping, memory), background runs (re-attach by sequence number, stop, recovery after a restart), `verify_project` against real Node and static projects (with a headless browser when one is installed), the full HTTP API with cookies and CSRF, SSE streaming, byte-for-byte parity of the design engine against the original Python implementation, real PDF/DOCX ingestion, and the main UI flows (provider setup, streaming chat, approvals, sandboxed preview).

## Honest notes

- **Verified here:** the test suite, a production build, and a live run of the production server over real HTTP (CSP nonces on every script tag, incremental SSE, approvals, Stop cancelling the upstream call).
- **Not verified here:** the UI hasn't been viewed in a real browser (only through jsdom component tests), and providers were tested against mock servers that mimic each wire format, not against the live vendor APIs. Expect to adjust a CSS detail or a vendor quirk.
- **Agent runs:** a full build (create project → write files → verify → deliver), background runs that survive a closed tab, Continue after a spent budget, and Stop were exercised end to end against a scripted model, on Node and on workerd (`wrangler dev`, through the `AgentRunner` Durable Object). The Cloudflare *container* (including Chromium for screenshots) couldn't be built here, so `verify_project` inside it is untested; on Node it ran against real projects. How well a task goes still depends mostly on the model you connect.
- **Skills, questions, preview and rewind** were exercised in a browser against a scripted model on `npm run dev` (question card, activity line, live static preview, rewind of code and conversation), and the question flow, skills and rewind on workerd too. Library installs fetch from GitHub when you click Install (without a GitHub token, GitHub allows about 60 API requests an hour). Weaker models use skills and `ask_user` less reliably than strong ones; pinning a skill or typing `/skill-name` always works.
- **Model IDs change quickly.** Presets use conservative defaults; use **Fetch** to list what your key can actually use.
- **Fonts** are system stacks (no network needed). **Embeddings** are local hashing, good for keyword-ish retrieval and not a substitute for a neural embedding model on large corpora.
- **Data from the old Flask app is not migrated** (it kept one in-memory conversation per session, so there's little to carry over).

## License

Copyright (C) 2026 Archit Aggarwal.

Morphie is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3 (`AGPL-3.0-only`), as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

If you run a modified version of Morphie for other people over a network, the AGPL asks you to offer them its source code.
