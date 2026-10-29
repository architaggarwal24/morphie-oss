import { createTwoFilesPatch } from "diff";

export const DIFF_CAP = 12_000;

/** A git-style unified diff of one file, plus line counts. `before` null = new file, `after` null = deleted. */
export function fileDiff(path: string, before: string | null, after: string | null): { diff: string; added: number; removed: number } {
  const a = before ?? "", b = after ?? "";
  const raw = createTwoFilesPatch(before === null ? "/dev/null" : `a/${path}`, after === null ? "/dev/null" : `b/${path}`, a, b, "", "", { context: 3 });
  // Drop the "=====" banner createTwoFilesPatch puts first; keep ---/+++ and the hunks.
  const lines = raw.split("\n").filter((l, i) => !(i === 0 && /^=+$/.test(l)));
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  const text = lines.join("\n").replace(/\n\\ No newline at end of file/g, "");
  return { diff: capDiff(text), added, removed };
}

export function capDiff(text: string, cap = DIFF_CAP): string {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap);
  return `${text.slice(0, cut > 0 ? cut : cap)}\n… diff truncated (${(text.length - cap).toLocaleString()} more characters)`;
}
