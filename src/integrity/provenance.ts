import type { LinkRelation } from "../schemas.js";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import { requireInScopeRecord, requireVisibleRecord, VISIBLE_SQL } from "../retrieval/eligibility.js";

export interface Citation {
  recordId: string;
  relation: LinkRelation;
}

/**
 * Writes provenance links from a new record. Every target must be visible to the
 * writer's workstream (else `not_found` / `scope_denied`), so a record can never cite
 * across scope. With `lineage: "inherit"` (the importer) a target only needs to be in scope:
 * a copy of a corrected claim must still link to what it copies. Duplicate (target, relation)
 * pairs collapse to one link. Call inside the transaction that inserts `fromId`.
 */
export function insertLinks(db: Db, workstreamId: string, fromId: string, links: readonly Citation[], now: string, lineage: "strict" | "inherit" = "strict"): Citation[] {
  requireTransaction(db, "insertLinks");
  const unique = [...new Map(links.map((link) => [`${link.recordId}\u0000${link.relation}`, link])).values()];
  const insert = prepared(db, "INSERT INTO links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)");
  for (const link of unique) {
    if (lineage === "strict") requireVisibleRecord(db, workstreamId, link.recordId);
    else requireInScopeRecord(db, workstreamId, link.recordId);
    insert.run(fromId, link.recordId, link.relation, now);
  }
  return unique;
}

/**
 * Outgoing citations of each record, restricted to targets the workstream can see —
 * a citation never discloses an out-of-scope or ineligible record.
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

/** Relations that make a record a restatement of its target's claim rather than a new observation. */
const DERIVING_RELATIONS = ["derived_from", "supported_by"] as const;
/** Derivation chains are short in practice; the cap only guards against pathological graphs. */
const MAX_DERIVATION_DEPTH = 16;

/**
 * The independent root of each record: the one observation its claim ultimately comes from.
 *
 * - An imported record's root is its source event (host + event id). Transcript and branch
 *   are deliberately left out: a Claude Code `/branch` or resumed copy re-stores the same
 *   events under a new transcript id, and an edited event keeps its id, so every copy and
 *   version of one host event shares one root.
 * - A record that is `derived_from` or `supported_by` a visible record takes that record's
 *   root (derived_from first, then the earliest target): repeating or resting on a claim
 *   is not a second observation of it.
 * - Anything else is its own root. Memchor does not infer derivation from similar text;
 *   an uncited restatement cannot be told apart from an independent observation, so
 *   agents are told to cite instead of re-recording (and Memchor's own output in a
 *   transcript is never imported as a record at all). The one exception is verbatim: the
 *   importer links an agent's message that repeats memory Memchor echoed earlier in the
 *   same transcript `derived_from` that record (`restatedEchoes` in import/reconcile.ts).
 *
 * Only visible targets are followed, so a root never discloses an out-of-scope record.
 */
export function independentRoots(db: Db, workstreamId: string, recordIds: readonly string[]): Map<string, string> {
  const parent = new Map<string, string>();
  const outgoing = prepared(
    db,
    `SELECT l.from_id, l.to_id FROM links l JOIN records r ON r.id = l.to_id
     WHERE l.from_id IN (SELECT value FROM json_each($ids)) AND l.relation IN (SELECT value FROM json_each($relations)) AND ${VISIBLE_SQL}
     ORDER BY l.from_id, CASE l.relation WHEN 'derived_from' THEN 0 ELSE 1 END, r.seq`,
  );
  let frontier = [...new Set(recordIds)];
  const seen = new Set(frontier);
  for (let depth = 0; depth < MAX_DERIVATION_DEPTH && frontier.length > 0; depth++) {
    const rows = outgoing.all({ ids: JSON.stringify(frontier), relations: JSON.stringify(DERIVING_RELATIONS), workstreamId }) as { from_id: string; to_id: string }[];
    frontier = [];
    for (const row of rows) {
      if (parent.has(row.from_id)) continue;
      parent.set(row.from_id, row.to_id);
      if (!seen.has(row.to_id)) {
        seen.add(row.to_id);
        frontier.push(row.to_id);
      }
    }
  }
  const terminal = (id: string): string => {
    const visited = new Set<string>();
    let current = id;
    for (let next = parent.get(current); next !== undefined && !visited.has(next); next = parent.get(current)) {
      visited.add(current);
      current = next;
    }
    return current;
  };
  const terminals = new Map(recordIds.map((id) => [id, terminal(id)]));
  const events = new Map(
    (
      prepared(db, "SELECT record_id, host, event_id FROM import_events WHERE record_id IN (SELECT value FROM json_each(?))").all(
        JSON.stringify([...new Set(terminals.values())]),
      ) as { record_id: string; host: string; event_id: string }[]
    ).map((row) => [row.record_id, `event:${row.host}/${row.event_id}`]),
  );
  return new Map([...terminals].map(([id, root]) => [id, events.get(root) ?? `record:${root}`]));
}
