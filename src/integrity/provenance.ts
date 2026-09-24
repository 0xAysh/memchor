import type { LinkRelation } from "../schemas.js";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import { requireVisibleRecord, VISIBLE_SQL } from "../retrieval/eligibility.js";

export interface Citation {
  recordId: string;
  relation: LinkRelation;
}

/**
 * Writes provenance links from a new record. Every target must be visible to the
 * writer's workstream (else `not_found` / `scope_denied`), so a record can never cite
 * across scope. Duplicate (target, relation) pairs collapse to one link.
 * Call inside the transaction that inserts `fromId`.
 */
export function insertLinks(db: Db, workstreamId: string, fromId: string, links: readonly Citation[], now: string): Citation[] {
  requireTransaction(db, "insertLinks");
  const unique = [...new Map(links.map((link) => [`${link.recordId}\u0000${link.relation}`, link])).values()];
  const insert = prepared(db, "INSERT INTO links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)");
  for (const link of unique) {
    requireVisibleRecord(db, workstreamId, link.recordId);
    insert.run(fromId, link.recordId, link.relation, now);
  }
  return unique;
}

/**
 * Outgoing citations of each record, restricted to targets the workstream can see —
 * a citation never discloses an out-of-scope or retracted record.
 */
export function citationsFor(db: Db, workstreamId: string, recordIds: readonly string[]): Map<string, Citation[]> {
  const result = new Map<string, Citation[]>(recordIds.map((id) => [id, []]));
  if (recordIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT l.from_id, l.to_id, l.relation FROM links l JOIN records r ON r.id = l.to_id
       WHERE l.from_id IN (SELECT value FROM json_each($ids)) AND ${VISIBLE_SQL}
       ORDER BY l.from_id, r.seq, l.relation`,
    )
    .all({ ids: JSON.stringify(recordIds), workstreamId }) as { from_id: string; to_id: string; relation: LinkRelation }[];
  for (const row of rows) result.get(row.from_id)?.push({ recordId: row.to_id, relation: row.relation });
  return result;
}

/** Both directions of a record's links, restricted to visible counterparts. */
export function linksOf(
  db: Db,
  workstreamId: string,
  recordId: string,
): { recordId: string; relation: LinkRelation; direction: "outgoing" | "incoming" }[] {
  return db
    .prepare(
      `SELECT r.id AS recordId, l.relation, 'outgoing' AS direction FROM links l JOIN records r ON r.id = l.to_id
         WHERE l.from_id = $recordId AND ${VISIBLE_SQL}
       UNION ALL
       SELECT r.id AS recordId, l.relation, 'incoming' AS direction FROM links l JOIN records r ON r.id = l.from_id
         WHERE l.to_id = $recordId AND ${VISIBLE_SQL}
       ORDER BY direction DESC, recordId, relation`,
    )
    .all({ recordId, workstreamId }) as { recordId: string; relation: LinkRelation; direction: "outgoing" | "incoming" }[];
}

/** Where an imported record came from. */
export interface ImportedSource {
  kind: "transcript";
  host: string;
  transcriptId: string;
  branch: string;
  eventId: string;
  observedAt: string;
}

/** Transcript provenance of the given records (records agents wrote directly have none). */
export function importedFrom(db: Db, recordIds: readonly string[]): Map<string, ImportedSource> {
  const result = new Map<string, ImportedSource>();
  if (recordIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT e.record_id, e.host, e.transcript_id, e.branch, e.event_id, r.created_at
       FROM import_events e JOIN records r ON r.id = e.record_id
       WHERE e.record_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(recordIds)) as { record_id: string; host: string; transcript_id: string; branch: string; event_id: string; created_at: string }[];
  for (const row of rows) {
    result.set(row.record_id, { kind: "transcript", host: row.host, transcriptId: row.transcript_id, branch: row.branch, eventId: row.event_id, observedAt: row.created_at });
  }
  return result;
}
