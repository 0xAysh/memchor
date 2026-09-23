import type { LinkRelation } from "../schemas.js";
import type { Db } from "../storage/database.js";
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
  const unique = [...new Map(links.map((link) => [`${link.recordId}\u0000${link.relation}`, link])).values()];
  const insert = db.prepare("INSERT INTO links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)");
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
