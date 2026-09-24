import { MemchorError } from "../errors.js";
import type { ExternalRef } from "../schemas.js";
import { type Db, requireTransaction } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL, type RecordRow, VISIBLE_SQL } from "./eligibility.js";

/**
 * Lexical search over the derived `chunks` / `chunks_fts` projection.
 *
 * The projection is a pure function of canonical `records` rows ({@link chunksFor}), so
 * {@link rebuildSearchIndex} can always regenerate it and ranking stays identical.
 * `chunks_fts` is an external-content FTS5 table over `chunks`; the two are only ever
 * written together inside the caller's write transaction.
 */

const CHUNK_BYTES = 1_000;
/** Candidates loaded per page; far above what any budget can pack, so budgets, not this, bound a page. */
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
  requireTransaction(db, "indexRecord");
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
  requireTransaction(db, "rebuildSearchIndex");
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
  /** Best-matching body chunk for the query, else the body itself. */
  excerpt_source: string;
}

/**
 * Upper bound on a recall sequence. Page 1 freezes at most this many ranked records;
 * anything beyond is reported as omitted (`candidate_limit`), never silently dropped.
 */
export const SEQUENCE_CAP = 500;

export interface RankRequest {
  workstreamId: string;
  /** Already converted with {@link toFtsQuery}; null lists recent records instead. */
  match: string | null;
  kinds: readonly string[] | null;
}

/**
 * The frozen order of a recall sequence: record `seq`s in a total, deterministic order
 * (capped at {@link SEQUENCE_CAP}), plus how many eligible records match in all.
 * Scope and eligibility are part of the WHERE clause, so they apply before ORDER BY /
 * LIMIT: ineligible rows can neither outrank nor displace eligible ones. (bm25's corpus
 * statistics do include ineligible rows; that can change scores, never eligibility.)
 *
 * Order with a query: bm25 of the best-matching chunk, then newest first, then seq.
 * Order without a query: newest first, then seq.
 */
export function rankSequence(db: Db, request: RankRequest): { seqs: number[]; total: number } {
  const params = {
    workstreamId: request.workstreamId,
    kinds: request.kinds === null ? null : JSON.stringify(request.kinds),
    match: request.match,
    cap: SEQUENCE_CAP,
  };
  const filters = `${RECALL_ELIGIBLE_SQL} AND ($kinds IS NULL OR r.kind IN (SELECT value FROM json_each($kinds)))`;
  const ranked =
    request.match === null
      ? `SELECT r.seq AS seq, r.created_at AS created_at, 0 AS rank FROM records r WHERE ${filters}`
      : // MATERIALIZED keeps bm25() evaluated in its full-text query rather than flattened into the aggregate.
        `WITH chunk_hits AS MATERIALIZED (
           SELECT c.record_id, bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH $match
         ),
         hits AS (SELECT record_id, min(rank) AS rank FROM chunk_hits GROUP BY record_id)
         SELECT r.seq AS seq, r.created_at AS created_at, h.rank AS rank
         FROM hits h JOIN records r ON r.id = h.record_id WHERE ${filters}`;
  const seqs = (
    db.prepare(`SELECT seq FROM (${ranked}) ORDER BY rank, created_at DESC, seq DESC LIMIT $cap`).all(params) as { seq: number }[]
  ).map((row) => row.seq);
  const { total } = db.prepare(`SELECT count(*) AS total FROM (${ranked})`).get(params) as { total: number };
  return { seqs, total };
}

/**
 * Loads the given records in the given order, re-applying scope and eligibility (a
 * record that became ineligible since page 1 is dropped, never shown). With a query,
 * `excerpt_source` is the best-matching body chunk.
 */
export function loadCandidates(db: Db, request: { workstreamId: string; match: string | null; seqs: readonly number[] }): Candidate[] {
  if (request.seqs.length === 0) return [];
  const params = { workstreamId: request.workstreamId, seqs: JSON.stringify(request.seqs), match: request.match };
  const wanted = `wanted AS (SELECT CAST(value AS INTEGER) AS seq, key AS pos FROM json_each($seqs))`;
  if (request.match === null) {
    return db
      .prepare(`WITH ${wanted} SELECT r.*, r.body AS excerpt_source FROM wanted w JOIN records r ON r.seq = w.seq WHERE ${VISIBLE_SQL} ORDER BY w.pos`)
      .all(params) as Candidate[];
  }
  return db
    .prepare(
      `WITH ${wanted},
       ids AS (SELECT r.id FROM wanted w JOIN records r ON r.seq = w.seq),
       hits AS MATERIALIZED (
         SELECT c.record_id, c.text, c.ordinal, bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH $match AND c.field = 'body' AND c.record_id IN (SELECT id FROM ids)
       ),
       best AS (SELECT record_id, text, row_number() OVER (PARTITION BY record_id ORDER BY rank, ordinal) AS n FROM hits)
       SELECT r.*, coalesce(b.text, r.body) AS excerpt_source
       FROM wanted w JOIN records r ON r.seq = w.seq LEFT JOIN best b ON b.record_id = r.id AND b.n = 1
       WHERE ${VISIBLE_SQL} ORDER BY w.pos`,
    )
    .all(params) as Candidate[];
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
