import { unzipSync } from "fflate";

export class DocumentError extends Error {}

export const SUPPORTED = ["pdf", "docx", "txt", "md", "csv", "json"] as const;
export type Kind = (typeof SUPPORTED)[number];

export interface LoadedPage { page?: number; text: string }

const MAX_PDF_PAGES = 300;
const MAX_UNPACKED = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export function checkSignature(kind: Kind, bytes: Uint8Array): void {
  const head = Buffer.from(bytes.subarray(0, 8));
  const pdf = head.subarray(0, 5).toString("latin1") === "%PDF-";
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (kind === "pdf" && !pdf) throw new DocumentError("This file's content doesn't look like a real PDF.");
  if (kind === "docx") {
    if (!zip) throw new DocumentError("This file's content doesn't look like a real Word document.");
    // Inspect the archive directory only; the filter rejects every entry so nothing is inflated.
    let entries = 0;
    let total = 0;
    try {
      unzipSync(bytes, { filter: (f) => { entries++; total += f.originalSize; return false; } });
    } catch {
      throw new DocumentError("This file's content doesn't look like a real Word document.");
    }
    if (entries > MAX_ENTRIES || total > MAX_UNPACKED) throw new DocumentError("This document is too large once unpacked, so it can't be processed.");
  }
  if ((kind === "txt" || kind === "md" || kind === "csv" || kind === "json") && (pdf || zip)) {
    throw new DocumentError(`This file's content doesn't look like a real .${kind} file.`);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0/g, "").replace(/^\uFEFF/, "");
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export async function loadDocument(kind: Kind, bytes: Uint8Array): Promise<LoadedPage[]> {
  switch (kind) {
    case "txt":
    case "md": {
      const text = decode(bytes).trim();
      return text ? [{ text }] : [];
    }
    case "json": {
      let parsed: unknown;
      try { parsed = JSON.parse(decode(bytes)); } catch { throw new DocumentError("This file isn't valid JSON."); }
      return [{ text: JSON.stringify(parsed, null, 2) }];
    }
    case "csv": {
      const rows = parseCsv(decode(bytes)).slice(0, 5001);
      if (rows.length < 1) return [];
      const [header, ...body] = rows;
      const lines = body.length
        ? body.map((r) => header.map((h, i) => `${h.trim() || `col${i + 1}`}: ${(r[i] ?? "").trim()}`).join("; "))
        : [header.join(", ")];
      return [{ text: lines.join("\n") }];
    }
    case "docx": {
      try {
        const mammoth = await import("mammoth");
        const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
        const text = value.trim();
        return text ? [{ text }] : [];
      } catch {
        throw new DocumentError("This Word document couldn't be read. It may be corrupt or password-protected.");
      }
    }
    case "pdf": {
      try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentError(`This PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
        const { text } = await extractText(pdf, { mergePages: false });
        return (text as string[]).map((t, i) => ({ page: i + 1, text: t.trim() })).filter((p) => p.text);
      } catch (e) {
        if (e instanceof DocumentError) throw e;
        throw new DocumentError("This PDF couldn't be read. It may be scanned images, encrypted or corrupt.");
      }
    }
  }
}
