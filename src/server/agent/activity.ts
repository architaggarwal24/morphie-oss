/**
 * The live activity line: while the model streams a tool call, say what it's about to do
 * ("Writing src/app/page.tsx", "Preparing: npm test") from the arguments received so far.
 */

/** A string field from partial JSON (the value may still be cut off). */
export function partialField(args: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args);
  if (!m) return undefined;
  const raw = m[1].replace(/\\$/, "");
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeActivity(name: string, args: string): string {
  const path = partialField(args, "path");
  switch (name) {
    case "write_file": case "workspace_write": return path ? `Writing ${short(path)}` : "Writing a file";
    case "edit_file": return path ? `Editing ${short(path)}` : "Editing a file";
    case "read_file": case "workspace_read": return path ? `Opening ${short(path)}` : "Opening a file";
    case "bash": { const c = partialField(args, "command"); return c ? `Preparing: ${short(c.split("\n")[0], 50)}` : "Preparing a command"; }
    case "update_plan": return "Updating the plan";
    case "ask_user": return "Writing questions for you";
    case "web_search": { const q = partialField(args, "query"); return q ? `Searching for “${short(q, 50)}”` : "Searching the web"; }
    case "fetch_url": { const u = partialField(args, "url"); return u ? `Opening ${short(u, 50)}` : "Opening a page"; }
    case "task": return "Briefing a sub-agent";
    case "use_skill": { const s = partialField(args, "name"); return s ? `Loading the ${s} skill` : "Loading a skill"; }
    case "create_project": return "Setting up a project";
    case "verify_project": return "Getting ready to verify";
    default: return `Preparing ${name.replace(/_/g, " ")}`;
  }
}

/** Calls `emit` at most every `ms` (and always for a new tool call), so a fast stream doesn't flood the client. */
export function throttledActivity(emit: (text: string, chars: number) => void, ms = 250, now: () => number = Date.now) {
  let last = 0;
  let lastKey = "";
  return (d: { index: number; name: string; args: string }) => {
    const key = `${d.index}:${d.name}`;
    const t = now();
    if (key === lastKey && t - last < ms) return;
    last = t;
    lastKey = key;
    emit(describeActivity(d.name, d.args), d.args.length);
  };
}
