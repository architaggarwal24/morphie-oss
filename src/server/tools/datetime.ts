import type { ToolDef } from "./types";
import { ToolError } from "./types";

const CITIES: Record<string, string> = {
  london: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin", madrid: "Europe/Madrid", rome: "Europe/Rome",
  moscow: "Europe/Moscow", "new york": "America/New_York", "los angeles": "America/Los_Angeles", chicago: "America/Chicago",
  toronto: "America/Toronto", tokyo: "Asia/Tokyo", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", delhi: "Asia/Kolkata",
  "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", bangalore: "Asia/Kolkata", dubai: "Asia/Dubai", singapore: "Asia/Singapore",
  sydney: "Australia/Sydney", "hong kong": "Asia/Hong_Kong", seoul: "Asia/Seoul", "sao paulo": "America/Sao_Paulo", utc: "UTC",
};

function resolveZone(input: string): string | null {
  const candidates = [input.trim(), CITIES[input.trim().toLowerCase()]].filter(Boolean) as string[];
  for (const tz of candidates) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return tz;
    } catch { /* try next */ }
  }
  return null;
}

export const currentTime: ToolDef = {
  name: "get_current_time",
  label: "Clock",
  description: "Get the current date and time in a city (e.g. 'London', 'Tokyo') or an IANA timezone (e.g. 'Europe/London'). Use whenever the user asks what time or date it is anywhere.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "City name or IANA timezone. Defaults to UTC." } },
  },
  risk: "safe",
  modes: ["chat", "agent"],
  readOnly: true,
  parallel: true,
  describeCall: (a) => `Check the time in ${String(a.location ?? "UTC")}`,
  async run(args) {
    const location = typeof args.location === "string" && args.location.trim() ? args.location.trim().slice(0, 60) : "UTC";
    const tz = resolveZone(location);
    if (!tz) throw new ToolError(`Unknown location '${location}'. Try a major city (e.g. 'London') or an IANA timezone (e.g. 'Europe/London').`);
    const text = new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(new Date());
    return { text: `${text} in ${location}.`, summary: `${location}: ${text}` };
  },
};
