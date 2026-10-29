export * from "./data/conversations";

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 48 ? t || "New conversation" : t.slice(0, 47).replace(/\s+\S*$/, "") + "…";
}
