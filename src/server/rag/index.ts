import type { DocumentView } from "@/lib/types";
import { checkLimit, recheckLimit } from "../plans";
import { LIMITS } from "../config";
import { randomId, sha256 } from "../crypto";
import type { Actor } from "../auth/actor";
import * as store from "../data/documents";
import { now } from "../db";
import { checkSignature, DocumentError, loadDocument, SUPPORTED, type Kind } from "./loaders";
import { stem, tokenize, words } from "../text";

export { DocumentError };

const DIM = 256;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const MIN_SCORE = 0.08;

// ---------------------------------------------------------------- chunking

/** Pack whitespace-separated words into ~size-char chunks with trailing overlap; never splits a normal word. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  size = Math.max(50, size);
  overlap = Math.max(0, Math.min(overlap, size >> 1));
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const add = w.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > size) {
      chunks.push(cur.join(" "));
      const carry: string[] = [];
      let carryLen = 0;
      for (let k = cur.length - 1; k >= 0; k--) {
        const extra = cur[k].length + (carry.length ? 1 : 0);
        if (carryLen + extra > overlap) break;
        carry.unshift(cur[k]);
        carryLen += extra;
      }
      if (carry.length === cur.length || carryLen + add > size) { cur = []; len = 0; }
      else { cur = carry; len = carryLen; }
      continue;
    }
    cur.push(w);
    len += add;
    i++;
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

// -------------------------------------------------------------- embeddings

function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic signed feature hashing over stemmed words + bigrams. Local, free, offline. */
export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const toks = words(text).map(stem);
  const push = (tok: string, weight: number) => {
    const h = fnv(tok);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  toks.forEach((w, i) => { push(w, 1); if (i > 0) push(toks[i - 1] + " " + w, 0.5); });
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/** Embeddings are stored as base64 text (portable to D1). Older local rows hold a raw BLOB; both read back the same. */
const toStored = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const fromStored = (s: string | Uint8Array) => {
  const b = typeof s === "string" ? Buffer.from(s, "base64") : Buffer.from(s);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

// --------------------------------------------------------------- documents

const toView = (r: store.DocRow): DocumentView => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, chunkCount: r.chunk_count, createdAt: r.created_at });

export async function listDocuments(actor: Actor): Promise<DocumentView[]> {
  return (await store.listDocumentRows(actor)).map(toView);
}

export const deleteDocument = store.deleteDocument;
export const clearDocuments = store.clearDocuments;

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 100).trim();
}

export async function ingest(actor: Actor, filename: string, bytes: Uint8Array, maxBytes: number): Promise<{ doc: DocumentView; created: boolean }> {
  const safe = sanitizeFilename(filename);
  const ext = safe.includes(".") ? safe.split(".").pop()!.toLowerCase() : "";
  if (!(SUPPORTED as readonly string[]).includes(ext)) throw new DocumentError(`Unsupported file type ".${ext}". Supported: ${SUPPORTED.join(", ")}.`);
  const kind = ext as Kind;
  if (!bytes.length) throw new DocumentError("The uploaded file is empty.");
  if (bytes.length > maxBytes) throw new DocumentError(`File is too large. The limit is ${Math.round(maxBytes / 1048576)} MB.`);
  checkSignature(kind, bytes);

  const hash = sha256(bytes);
  const dup = await store.findDocumentByHash(actor, hash);
  if (dup) return { doc: toView(dup), created: false };
  await checkLimit(actor, "documents", () => store.countDocuments(actor));
  if (await store.countDocuments(actor) >= LIMITS.maxDocsPerUser) throw new DocumentError(`You can keep up to ${LIMITS.maxDocsPerUser} documents. Delete one first.`);

  const pages = await loadDocument(kind, bytes);
  if (!pages.length) throw new DocumentError("No readable text could be extracted from this file.");
  const pieces = pages.flatMap((p) => chunkText(p.text).map((t) => (p.page ? `[p.${p.page}] ${t}` : t)));
  if (!pieces.length) throw new DocumentError("No text could be extracted from this file.");
  if (pieces.length > LIMITS.maxChunksPerDoc) throw new DocumentError(`This document is too long (${pieces.length} sections; the limit is ${LIMITS.maxChunksPerDoc}).`);

  const row = await store.insertDocumentWithChunks(
    actor,
    { id: randomId(9), name: safe, kind, size: bytes.length, sha256: hash, created_at: now() },
    pieces.map((text, idx) => ({ idx, text, embedding: toStored(embed(text)) })),
  );
  await recheckLimit(actor, "documents", () => store.countDocuments(actor), () => store.deleteDocument(actor, row.id));
  return { doc: toView(row), created: true };
}

// ------------------------------------------------------------------ search

export interface Hit { documentId: string; document: string; text: string; score: number; idx: number }

/** Hybrid retrieval: cosine over hashed embeddings + coverage of the query's keywords. */
export async function searchDocuments(actor: Actor, query: string, opts: { topK?: number; documentIds?: string[] } = {}): Promise<Hit[]> {
  const q = embed(query);
  const terms = [...tokenize(query)];
  if (!terms.length) return [];
  const ids = opts.documentIds?.filter((x) => /^[A-Za-z0-9_-]+$/.test(x));
  const rows = await store.searchChunkRows(actor, ids);
  const hits: Hit[] = [];
  for (const r of rows) {
    const cosine = dot(q, fromStored(r.embedding));
    const words = tokenize(r.text);
    const coverage = terms.filter((t) => words.has(t)).length / terms.length;
    const score = 0.55 * Math.max(0, cosine) + 0.45 * coverage;
    if (score >= MIN_SCORE && (coverage > 0 || cosine > 0.25)) hits.push({ documentId: r.document_id, document: r.name, text: r.text, score, idx: r.idx });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.topK ?? 5);
}

export const hasDocuments = store.hasDocuments;
