import type { Sandbox } from "../sandbox/types";

/** Morphie's own files in a project (logs, screenshots, the verify script). Never committed, never delivered. */
export const SCRATCH = [".morphie/logs/", ".morphie/shots/", ".morphie/chrome-profile/", ".morphie/verify.mjs", ".morphie/verify.json", ".morphie/preview.mjs", ".morphie/skill-files/"];

/**
 * Dependency and build folders. Kept out of git's untracked list locally (.git/info/exclude, which adds no file to
 * the project): without it a fresh `npm install` makes `git status` walk tens of thousands of files and the Changes
 * panel crawls. Files git already tracks are unaffected.
 */
const HEAVY = ["node_modules/", ".next/", ".open-next/", ".turbo/", ".cache/", ".vite/", ".venv/", "venv/", "__pycache__/", "coverage/", "dist/", "build/"];

/**
 * Keep the scratch files out of git without adding anything to the project: in a git repository they go in
 * .git/info/exclude (local only); otherwise in .morphie/.gitignore. Best effort.
 */
export async function ignoreScratch(sb: Sandbox): Promise<void> {
  try {
    if ((await sb.readFile(".git/HEAD")) !== null) {
      const cur = (await sb.readFile(".git/info/exclude")) ?? "";
      const missing = [...SCRATCH, ...HEAVY].filter((p) => !cur.split(/\r?\n/).includes(p));
      if (missing.length) await sb.writeFile(".git/info/exclude", `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}# Added by Morphie: its scratch files, dependencies and build output\n${missing.join("\n")}\n`);
      return;
    }
    if ((await sb.readFile(".morphie/.gitignore")) === null) await sb.writeFile(".morphie/.gitignore", SCRATCH.map((p) => p.replace(/^\.morphie\//, "")).join("\n") + "\n");
  } catch { /* not worth failing a tool over */ }
}
