/**
 * Morphie Runners: a small program people run on their own computer or VM (public/morphie-runner.mjs) so their code
 * projects run there, for free, with whatever tools that machine has. It authenticates with a token made here (only
 * its SHA-256 is kept) and connects out to Morphie: no open ports, no tunnel.
 */
import type { RunnerView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { coordinator } from "../coordinator";
import { randomId, randomToken, safeEqualHex, sha256 } from "../crypto";
import * as store from "../data/runners";
import { now } from "../db";
import { ApiError } from "../http";

export const MAX_RUNNERS = 5;
const SEEN_WRITE_MS = 60_000;

const view = async (actor: Actor, r: store.RunnerRow): Promise<RunnerView> => ({
  id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
  online: await coordinator(actor.userId).online(r.id).catch(() => false),
});

export async function listRunners(actor: Actor): Promise<RunnerView[]> {
  return Promise.all((await store.listRunnerRows(actor)).map((r) => view(actor, r)));
}

/** A new runner and its token (shown once). */
export async function createRunner(actor: Actor, name: string): Promise<{ runner: RunnerView; token: string }> {
  if ((await store.countRunners(actor)) >= MAX_RUNNERS) throw new ApiError(400, `You can have up to ${MAX_RUNNERS} runners. Remove one first.`, "limit");
  const id = randomId(9).replace(/[^A-Za-z0-9]/g, "x");
  const secret = randomToken();
  await store.insertRunner(actor, { id, name: name || "My computer", tokenHash: sha256(secret) });
  return { runner: (await listRunners(actor)).find((r) => r.id === id)!, token: `mr_${id}.${secret}` };
}

export async function removeRunner(actor: Actor, id: string): Promise<void> {
  if (!(await store.deleteRunner(actor, id))) throw new ApiError(404, "That runner doesn't exist.", "not_found");
}

/** The runner behind an `Authorization: Bearer mr_<id>.<secret>` header, or a 401. */
export async function runnerFromRequest(req: Request): Promise<store.RunnerRow> {
  const m = /^Bearer mr_([A-Za-z0-9]{6,40})\.([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") ?? "");
  const row = m ? await store.runnerById(m[1]) : undefined;
  if (!m || !row || !safeEqualHex(row.token_hash, sha256(m[2]))) throw new ApiError(401, "That runner token isn't valid (it may have been removed in Settings → Runners).", "unauthenticated");
  return row;
}

/** Remember when a runner was last here (at most once a minute) and what it runs on. */
export async function sawRunner(row: store.RunnerRow, platform: string): Promise<void> {
  if (row.last_seen_at && now() - row.last_seen_at < SEEN_WRITE_MS && row.platform === platform) return;
  await store.touchRunner(row.id, platform);
}
