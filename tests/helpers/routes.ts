import fs from "node:fs";
import path from "node:path";

export const API = path.resolve("src/app/api");
export const VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Every route.ts under src/app/api, found on disk so a new route can't be forgotten by a hand-kept list. */
export function discoverRouteFiles(dir = API, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) discoverRouteFiles(f, out); else if (e.name === "route.ts") out.push(f);
  }
  return out.sort();
}

/** e.g. /api/design/[id]/[action] */
export const routePattern = (file: string): string => ("/api/" + path.relative(API, path.dirname(file)).split(path.sep).filter(Boolean).join("/")).replace(/\/$/, "");
