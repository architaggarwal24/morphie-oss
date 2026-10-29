export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function ms(n?: number): string {
  if (n == null) return "";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

/** Wall-clock time: "48 s", "4 min 12 s", "1 h 3 min". */
export function elapsed(n?: number): string {
  if (n == null) return "";
  const s = Math.round(n / 1000);
  if (s < 60) return `${Math.max(1, s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Token counts the way people say them: 950, 12.4k, 1.2M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}M`;
}

export type Group = "Pinned" | "Today" | "Yesterday" | "This week" | "Earlier";
export function groupByRecency<T extends { updatedAt: number; pinned?: boolean }>(items: T[], now = Date.now()): Array<[Group, T[]]> {
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const buckets: Record<Group, T[]> = { Pinned: [], Today: [], Yesterday: [], "This week": [], Earlier: [] };
  for (const it of items) {
    const age = startOfDay.getTime() - it.updatedAt;
    const key: Group = it.pinned ? "Pinned" : it.updatedAt >= startOfDay.getTime() ? "Today" : age <= day ? "Yesterday" : age <= 6 * day ? "This week" : "Earlier";
    buckets[key].push(it);
  }
  return (Object.entries(buckets) as Array<[Group, T[]]>).filter(([, v]) => v.length);
}

export function toolLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function argSummary(args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  return first ? (first.length > 90 ? first.slice(0, 89) + "…" : first).replace(/\s+/g, " ") : "";
}
