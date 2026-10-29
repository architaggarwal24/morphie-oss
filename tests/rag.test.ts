import { testActor } from "./helpers/actor";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { DocumentError, chunkText, ingest, listDocuments, searchDocuments } from "@/server/rag";
import { parseCsv } from "@/server/rag/loaders";

const user = "user_rag_abcdefghijklmnopq";
testActor(user);
const MB = 1024 * 1024;
const enc = (s: string) => new TextEncoder().encode(s);

/** A genuine (tiny) PDF with correct xref offsets, one page per entry. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 14 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  });
}

describe("loaders", () => {
  it("reads a real PDF page by page and finds text on the right page", async () => {
    const { doc } = await ingest(testActor(user), "handbook.pdf", makePdf(["Onboarding checklist for new engineers", "Expense policy: receipts are required above fifty dollars"]), 5 * MB);
    expect(doc).toMatchObject({ kind: "pdf", name: "handbook.pdf" });
    const hits = await searchDocuments(testActor(user), "expense receipts required");
    expect(hits[0].document).toBe("handbook.pdf");
    expect(hits[0].text).toMatch(/^\[p\.2\]/);
  });

  it("reads a real DOCX", async () => {
    await ingest(testActor(user), "minutes.docx", makeDocx(["Quarterly planning meeting minutes.", "Decision: migrate the billing service to the new queue by March."]), 5 * MB);
    const hits = await searchDocuments(testActor(user), "billing service queue migration");
    expect(hits[0].document).toBe("minutes.docx");
    expect(hits[0].text).toContain("March");
  });

  it("turns CSV rows into searchable records and handles quotes", async () => {
    expect(parseCsv('name,notes\n"Ada, L.","said ""hi"""\nBob,plain')).toEqual([["name", "notes"], ["Ada, L.", 'said "hi"'], ["Bob", "plain"]]);
    await ingest(testActor(user), "people.csv", enc("name,team,city\nGrace Hopper,Compilers,Arlington\nAlan Turing,Crypto,Wilmslow\n"), MB);
    expect((await searchDocuments(testActor(user), "who works on crypto in Wilmslow"))[0].text).toContain("Alan Turing");
  });

  it("pretty-prints JSON and rejects invalid JSON", async () => {
    await ingest(testActor(user), "config.json", enc('{"service":{"retries":3,"region":"eu-west"}}'), MB);
    expect((await searchDocuments(testActor(user), "retries region"))[0].document).toBe("config.json");
    await expect(ingest(testActor(user), "broken.json", enc("{nope"), MB)).rejects.toThrow(/valid JSON/);
  });

  it("rejects disguised files, oversize files, corrupt PDFs, and decompression bombs", async () => {
    await expect(ingest(testActor(user), "x.pdf", enc("MZ not a pdf"), MB)).rejects.toThrow(/real PDF/);
    await expect(ingest(testActor(user), "x.docx", enc("plain text"), MB)).rejects.toThrow(/real Word/);
    await expect(ingest(testActor(user), "x.txt", makePdf(["hi"]), MB)).rejects.toThrow(/real \.txt/);
    await expect(ingest(testActor(user), "big.txt", new Uint8Array(2 * MB).fill(97), MB)).rejects.toThrow(/too large/);
    await expect(ingest(testActor(user), "corrupt.pdf", enc("%PDF-1.4\nthis is garbage"), MB)).rejects.toThrow(DocumentError);
    // 150 MB of zeros compresses to ~150 KB: must be refused without being inflated.
    const bomb = zipSync({ "word/document.xml": new Uint8Array(150 * MB) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1 * MB);
    await expect(ingest(testActor(user), "bomb.docx", bomb, 5 * MB)).rejects.toThrow(/too large once unpacked/);
  });

  it("de-duplicates by content and sanitises names", async () => {
    const bytes = enc("Unique content for the dedupe test, long enough to be indexed.");
    const a = await ingest(testActor(user), "a.txt", bytes, MB);
    const b = await ingest(testActor(user), "b.txt", bytes, MB);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.doc.id).toBe(a.doc.id);
    expect((await ingest(testActor(user), "..\\..\\etc/pass wd?.txt", enc("another file with a nasty name"), MB)).doc.name).toBe("pass wd_.txt");
    expect((await listDocuments(testActor(user))).length).toBeGreaterThan(5);
  });
});

describe("chunking & ranking", () => {
  it("never splits words and overlaps neighbouring chunks", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(words, 200, 40);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) { expect(c.length).toBeLessThanOrEqual(200); expect(c.split(" ").every((w) => /^word\d+$/.test(w))).toBe(true); }
    const last = chunks[0].split(" ").slice(-1)[0];
    expect(chunks[1].split(" ")).toContain(last);                        // overlap
    expect(chunks.join(" ").includes("word399")).toBe(true);
  });

  it("ranks the relevant passage first and returns nothing for unrelated queries", async () => {
    const u = "user_rank_abcdefghijklmnopq";
    testActor(u);
    await ingest(testActor(u), "cooking.txt", enc("To make sourdough, mix flour, water and salt, then let the starter ferment overnight before baking in a hot dutch oven."), MB);
    await ingest(testActor(u), "travel.txt", enc("Our trip to Lisbon includes a tram ride, pastel de nata tasting and a day trip to Sintra by train."), MB);
    expect((await searchDocuments(testActor(u), "how do I bake sourdough bread"))[0].document).toBe("cooking.txt");
    expect((await searchDocuments(testActor(u), "train to Sintra"))[0].document).toBe("travel.txt");
    expect(await searchDocuments(testActor(u), "quantum chromodynamics lagrangian")).toEqual([]);
    expect((await searchDocuments(testActor(u), "sourdough", { documentIds: [] }))[0].document).toBe("cooking.txt");
  });

  it("keeps each user's documents private", async () => {
    expect(await searchDocuments(testActor("someone_else_abcdefghijklmn"), "sourdough")).toEqual([]);
  });
});
