import type { Sandbox } from "../sandbox";

/**
 * Checkpoints: a snapshot of the project's files taken before each agent run, so you can rewind the code to how it was
 * before a message. They're plain git commits built through a private index (your staging area, HEAD and branches are
 * never touched) and kept alive by refs under refs/morphie/, so they don't show up in `git log` or get pushed.
 * Ignored files (node_modules, build output, .morphie scratch) aren't part of them.
 */

const SHA = /^[0-9a-f]{40}$/;
const GIT_ID = "-c user.name=Morphie -c user.email=morphie@localhost -c commit.gpgsign=false";

/** Shell snippet: point git at a private index file (in .git, so nothing appears in the project). */
const privateIndex = (name: string) => `GD="$(git rev-parse --git-dir 2>/dev/null)" || exit 0; export GIT_INDEX_FILE="$GD/${name}"; rm -f "$GIT_INDEX_FILE";`;

/** Snapshot the working tree. Returns the checkpoint's commit id, or null (not a git project, or git failed). */
export async function createCheckpoint(sb: Sandbox, label: string): Promise<string | null> {
  const msg = label.replace(/[^\w .,:;!?()/-]/g, " ").slice(0, 80) || "checkpoint";
  const cmd = [
    privateIndex("morphie-cp-index"),
    "git add -A >/dev/null 2>&1 || exit 0;",
    'T=$(git write-tree) || exit 0; P=$(git rev-parse -q --verify HEAD 2>/dev/null);',
    `C=$(git ${GIT_ID} commit-tree "$T" \${P:+-p "$P"} -m "Morphie checkpoint: ${msg}") || exit 0;`,
    'git update-ref "refs/morphie/cp/$C" "$C" && echo "CP:$C"; rm -f "$GIT_INDEX_FILE"',
  ].join(" ");
  try {
    const r = await sb.exec(cmd, { timeoutMs: 60_000 });
    const sha = /CP:([0-9a-f]{40})/.exec(r.output)?.[1];
    return sha ?? null;
  } catch { return null; }
}

/**
 * Put the project's files back the way they were at `sha`: changed files are restored, files made since are removed
 * (ignored ones are left alone). The current state is saved as a checkpoint first, so the rewind itself can be undone.
 */
export async function restoreCheckpoint(sb: Sandbox, sha: string): Promise<{ undo: string | null; removed: number; restored: boolean }> {
  if (!SHA.test(sha)) return { undo: null, removed: 0, restored: false };
  const exists = await sb.exec(`git cat-file -e ${sha}^{commit} 2>/dev/null && echo OK`, { timeoutMs: 20_000 }).catch(() => null);
  if (!exists || !/OK/.test(exists.output)) return { undo: null, removed: 0, restored: false };
  const undo = await createCheckpoint(sb, "before rewinding");
  const cmd = [
    privateIndex("morphie-rw-index"),
    "git add -A >/dev/null 2>&1;",
    // Files that exist now but not in the checkpoint: made after it, so they go.
    `git diff --cached --name-only --diff-filter=A -z ${sha} | xargs -0 -r rm -f --;`,
    `N=$(git diff --cached --name-only --diff-filter=A ${sha} | wc -l);`,
    `git read-tree ${sha} && git checkout-index -a -f && echo "RESTORED:$N"; rm -f "$GIT_INDEX_FILE"`,
  ].join(" ");
  const r = await sb.exec(cmd, { timeoutMs: 120_000 });
  const m = /RESTORED:\s*(\d+)/.exec(r.output);
  return { undo, removed: m ? Number(m[1]) : 0, restored: !!m };
}
