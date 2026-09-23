import { MemchorError } from "../errors.js";
import type { ExternalRef } from "../schemas.js";
import type { Db } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL, type RecordRow } from "./eligibility.js";

/**
 * Lexical search over the derived `chunks` / `chunks_fts` projection.
 *
 * The projection is a pure function of canonical `records` rows ({@link chunksFor}), so
 * {@link rebuildSearchIndex} can always regenerate it and ranking stays identical.
 * `chunks_fts` is an external-content FTS5 table over `chunks`; the two are only ever
 * written together inside the caller's write transaction.
 */

const CHUNK_BYTES = 1_000;
/** Candidates fetched per page; far above what any budget can pack, so budgets, not this, bound a page. */
export const PAGE_CANDIDATES = 200;
const MAX_QUERY_TERMS = 32;

interface IndexableRecord {
  id: string;
  title: string | null;
  body: string;
  externalRefs: readonly ExternalRef[];
}

type ChunkField = "title" | "body" | "refs";

/** Title, body (split at whitespace into ≤1000-byte chunks) and reference locators, in that order. */
function chunksFor(record: IndexableRecord): { field: ChunkField; text: string }[] {
  const chunks: { field: ChunkField; text: string }[] = [];
  if (record.title !== null) chunks.push({ field: "title", text: record.title });
  for (const text of splitText(record.body, CHUNK_BYTES)) chunks.push({ field: "body", text });
  const refs = record.externalRefs.map((ref) => [ref.locator, ref.path].filter(Boolean).join(" ")).join("\n");
  if (refs !== "") chunks.push({ field: "refs", text: refs });
  return chunks;
}

/** Adds a record's chunks to the projection. Call inside the transaction that inserts the record. */
export function indexRecord(db: Db, record: IndexableRecord): void {
  const insertChunk = db.prepare("INSERT INTO chunks (record_id, ordinal, field, text) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)");
  chunksFor(record).forEach((chunk, ordinal) => {
    const { lastInsertRowid } = insertChunk.run(record.id, ordinal, chunk.field, chunk.text);
    insertFts.run(lastInsertRowid, chunk.text);
  });
}

/**
 * Discards and regenerates the whole projection from canonical records.
 * Call inside a write transaction; canonical tables are only read.
 */
export function rebuildSearchIndex(db: Db): { records: number; chunks: number } {
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('delete-all'); DELETE FROM chunks;");
  const rows = db.prepare("SELECT id, title, body, external_refs FROM records ORDER BY seq").all() as {
    id: string;
    title: string | null;
    body: string;
    external_refs: string;
  }[];
  for (const row of rows) {
    indexRecord(db, { id: row.id, title: row.title, body: row.body, externalRefs: JSON.parse(row.external_refs) as ExternalRef[] });
  }
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('integrity-check')");
  const chunks = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  return { records: rows.length, chunks };
}

/**
 * Turns free text into a safe FTS5 expression: every term is double-quoted (so FTS
 * operators, column filters and syntax errors cannot be injected) and terms are OR-ed,
 * letting bm25 rank records that match more and rarer terms first.
 */
export function toFtsQuery(query: string): string {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) {
    throw new MemchorError("invalid_input", "The query contains no searchable words.", { details: { query } });
  }
  return terms.map((term) => `"${term}"`).join(" OR ");
}

export interface Candidate extends RecordRow {
  /** Best-matching body chunk (or the body start when the match was in the title or references). */
  excerpt_source: string;
}

export interface RankRequest {
  workstreamId: string;
  /** Already converted with {@link toFtsQuery}; null lists recent records instead. */
  match: string | null;
  kinds: readonly string[] | null;
  /** Snapshot bound: records created after the first page never enter the sequence. */
  seqMax: number;
  offset: number;
}

/**
 * One page of recall candidates in a total, deterministic order, plus the size of the
 * whole eligible sequence. Scope and eligibility are part of the WHERE clause, so they
 * apply before ORDER BY / LIMIT: ineligible rows can neither outrank nor displace
 * eligible ones.
 *
 * Order with a query: bm25 (best chunk per record), then newest first, then seq.
 * Order without a query: newest first, then seq.
 */
export function rankCandidates(db: Db, request: RankRequest): { rows: Candidate[]; total: number } {
  const params = {
    workstreamId: request.workstreamId,
    seqMax: request.seqMax,
    kinds: request.kinds === null ? null : JSON.stringify(request.kinds),
    match: request.match,
    limit: PAGE_CANDIDATES,
    offset: request.offset,
  };
  const filters = `${RECALL_ELIGIBLE_SQL} AND r.seq <= $seqMax
    AND ($kinds IS NULL OR r.kind IN (SELECT value FROM json_each($kinds)))`;

  if (request.match === null) {
    const from = `FROM records r WHERE ${filters}`;
    const rows = db
      .prepare(`SELECT r.*, r.body AS excerpt_source ${from} ORDER BY r.created_at DESC, r.seq DESC LIMIT $limit OFFSET $offset`)
      .all(params) as Candidate[];
    const { total } = db.prepare(`SELECT count(*) AS total ${from}`).get(params) as { total: number };
    return { rows, total };
  }

  const ranked = `
    WITH hits AS (
      SELECT c.record_id, c.ordinal, c.field, bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH $match
    ), best AS (
      SELECT record_id, ordinal, field, rank,
             row_number() OVER (PARTITION BY record_id ORDER BY rank, ordinal) AS n
      FROM hits
    )
    SELECT r.*, b.rank AS rank,
           CASE WHEN b.field = 'body' THEN (SELECT text FROM chunks WHERE record_id = r.id AND ordinal = b.ordinal)
                ELSE r.body END AS excerpt_source
    FROM best b JOIN records r ON r.id = b.record_id
    WHERE b.n = 1 AND ${filters}`;
  const rows = db
    .prepare(`${ranked} ORDER BY b.rank, r.created_at DESC, r.seq DESC LIMIT $limit OFFSET $offset`)
    .all(params) as Candidate[];
  const { total } = db.prepare(`SELECT count(*) AS total FROM (${ranked})`).get(params) as { total: number };
  return { rows, total };
}

export function currentSeqMax(db: Db): number {
  return (db.prepare("SELECT coalesce(max(seq), 0) AS n FROM records").get() as { n: number }).n;
}

function splitText(text: string, maxBytes: number): string[] {
  const parts = text.split(/(\s+)/u);
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim() !== "") chunks.push(current.trim());
    current = "";
  };
  for (const part of parts) {
    if (Buffer.byteLength(current + part, "utf8") <= maxBytes) {
      current += part;
      continue;
    }
    flush();
    // A single token longer than a chunk is split at code-point boundaries.
    let rest = part;
    while (Buffer.byteLength(rest, "utf8") > maxBytes) {
      const head = clipToBytes(rest, maxBytes);
      chunks.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  flush();
  return chunks;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
export function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
