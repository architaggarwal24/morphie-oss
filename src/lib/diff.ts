/** Parse a unified diff (git diff or a single-file patch) into files → hunks → numbered lines. */
export interface DiffLine { kind: "add" | "del" | "ctx" | "note"; text: string; oldNo?: number; newNo?: number }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; oldPath: string | null; newPath: string | null; added: number; removed: number; hunks: DiffHunk[]; binary?: boolean }

const strip = (p: string) => (p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, ""));

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  const start = (oldPath: string | null, newPath: string | null) => {
    file = { path: newPath ?? oldPath ?? "?", oldPath, newPath, added: 0, removed: 0, hunks: [] };
    files.push(file);
    hunk = null;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      start(m ? m[1] : null, m ? m[2] : null);
      continue;
    }
    if (line.startsWith("--- ") && (!hunk || !file)) {
      const old = strip(line.slice(4));
      if (!file || (file as DiffFile).hunks.length) start(old, null);
      else (file as DiffFile).oldPath = old;
      continue;
    }
    if (line.startsWith("+++ ") && file && !hunk) {
      const f = file as DiffFile;
      f.newPath = strip(line.slice(4));
      f.path = f.newPath ?? f.oldPath ?? f.path;
      continue;
    }
    if (line.startsWith("Binary files") && file) { (file as DiffFile).binary = true; continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h && file) {
      hunk = { header: line, lines: [] };
      (file as DiffFile).hunks.push(hunk);
      oldNo = Number(h[1]); newNo = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]); newLeft = h[4] === undefined ? 1 : Number(h[4]);
      continue;
    }
    if (!hunk || !file) continue;
    if (oldLeft <= 0 && newLeft <= 0 && !line.startsWith("\\") && !line.startsWith("…")) {
      // The hunk is complete: this line starts something else (a new file's "---", or noise).
      hunk = null;
      if (line.startsWith("--- ")) start(strip(line.slice(4)), null);
      continue;
    }
    const f = file as DiffFile, hk = hunk as DiffHunk;
    if (line.startsWith("+")) { hk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ }); f.added++; newLeft--; }
    else if (line.startsWith("-")) { hk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ }); f.removed++; oldLeft--; }
    else if (line.startsWith(" ") || line === "") { hk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); oldLeft--; newLeft--; }
    else if (line.startsWith("\\") || line.startsWith("…")) hk.lines.push({ kind: "note", text: line });
  }
  return files;
}
