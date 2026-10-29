import type { Actor } from "../auth/actor";
import { db, stmt } from "../db";
import { NotFoundError } from "./errors";

export interface DocRow { id: string; name: string; kind: string; size: number; sha256: string; chunk_count: number; created_at: number }
/** `embedding` is stored as base64 text (D1 hands BLOBs back as plain number arrays, which is slow and bulky). */
export interface ChunkInsert { idx: number; text: string; embedding: string }
/** Older local databases hold the embedding as a BLOB; newer rows (and every D1 row) as base64 text. */
export interface ChunkRow { document_id: string; idx: number; text: string; embedding: string | Uint8Array; name: string }

export async function listDocumentRows(actor: Actor): Promise<DocRow[]> {
  return db().all<DocRow>("SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC", actor.userId);
}

export async function countDocuments(actor: Actor): Promise<number> {
  return (await db().get<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE user_id = ?", actor.userId))?.c ?? 0;
}

export async function findDocumentByHash(actor: Actor, sha256: string): Promise<DocRow | undefined> {
  return db().get<DocRow>("SELECT * FROM documents WHERE user_id = ? AND sha256 = ?", actor.userId, sha256);
}

export async function getDocumentRow(actor: Actor, id: string): Promise<DocRow | undefined> {
  return db().get<DocRow>("SELECT * FROM documents WHERE id = ? AND user_id = ?", id, actor.userId);
}

/** Document and its chunks are written together or not at all. */
export async function insertDocumentWithChunks(actor: Actor, doc: Omit<DocRow, "chunk_count">, chunks: ChunkInsert[]): Promise<DocRow> {
  await db().batch([
    stmt("INSERT INTO documents (id, user_id, name, kind, size, sha256, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      doc.id, actor.userId, doc.name, doc.kind, doc.size, doc.sha256, chunks.length, doc.created_at),
    ...chunks.map((c) => stmt("INSERT INTO chunks (document_id, user_id, idx, text, embedding) VALUES (?, ?, ?, ?, ?)", doc.id, actor.userId, c.idx, c.text, c.embedding)),
  ]);
  return (await getDocumentRow(actor, doc.id))!;
}

export async function deleteDocument(actor: Actor, id: string): Promise<void> {
  if (!(await getDocumentRow(actor, id))) throw new NotFoundError("Document not found");
  await db().batch([
    stmt("DELETE FROM chunks WHERE document_id = ? AND user_id = ?", id, actor.userId),
    stmt("DELETE FROM documents WHERE id = ? AND user_id = ?", id, actor.userId),
  ]);
}

export async function clearDocuments(actor: Actor): Promise<void> {
  await db().batch([
    stmt("DELETE FROM chunks WHERE user_id = ?", actor.userId),
    stmt("DELETE FROM documents WHERE user_id = ?", actor.userId),
  ]);
}

export async function searchChunkRows(actor: Actor, documentIds?: string[]): Promise<ChunkRow[]> {
  const ids = documentIds?.length ? documentIds : undefined;
  return db().all<ChunkRow>(
    `SELECT c.document_id, c.idx, c.text, c.embedding, d.name FROM chunks c
       JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
      WHERE c.user_id = ?${ids ? ` AND c.document_id IN (${ids.map(() => "?").join(",")})` : ""}`,
    actor.userId, ...(ids ?? []),
  );
}

export async function hasDocuments(actor: Actor): Promise<boolean> {
  return !!(await db().get("SELECT 1 AS x FROM documents WHERE user_id = ? LIMIT 1", actor.userId));
}
