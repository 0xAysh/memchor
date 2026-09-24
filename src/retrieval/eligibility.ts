import { MemchorError } from "../errors.js";
import { type Db, prepared } from "../storage/database.js";

/**
 * The single definition of which records a workstream may see. Workspace isolation is
 * physical (one database file per workspace), so only workstream scope and review state
 * are decided here.
 *
 * A record is *visible* to workstream W when it belongs to W or is workspace-level
 * (workstream_id IS NULL), and it is not retracted. Visibility governs direct reads,
 * link targets, and citations.
 *
 * A record is *recall-eligible* when it is visible and is not a checkpoint: the head
 * checkpoint is surfaced separately at the top of every first page, and superseded
 * checkpoint revisions are history, not current guidance (still readable directly).
 *
 * Both clauses go into the WHERE of the ranking query, so ineligible records never
 * compete for rank, budget, or continuation positions. Callers bind `$workstreamId`.
 */
export const VISIBLE_SQL = `(r.review_state <> 'retracted' AND (r.workstream_id = $workstreamId OR r.workstream_id IS NULL))`;
export const RECALL_ELIGIBLE_SQL = `(${VISIBLE_SQL} AND r.kind <> 'checkpoint')`;

export interface RecordRow {
  seq: number;
  id: string;
  kind: string;
  title: string | null;
  body: string;
  workstream_id: string | null;
  session_id: string | null;
  host: string;
  attribution: string;
  review_state: string;
  applicability: string;
  freshness: string;
  external_refs: string;
  content_hash: string;
  created_at: string;
}

/**
 * Loads a record the workstream is allowed to see, or explains why not:
 * unknown id or retracted → `not_found`; another workstream's record → `scope_denied`.
 */
export function requireVisibleRecord(db: Db, workstreamId: string, recordId: string): RecordRow {
  const row = prepared(db, "SELECT * FROM records WHERE id = ?").get(recordId) as RecordRow | undefined;
  if (row === undefined || row.review_state === "retracted") {
    throw new MemchorError("not_found", `No eligible record ${recordId} exists in this workspace.`, {
      details: { recordId },
    });
  }
  if (row.workstream_id !== null && row.workstream_id !== workstreamId) {
    throw new MemchorError("scope_denied", `Record ${recordId} belongs to another workstream and is not visible here.`, {
      details: { recordId },
    });
  }
  return row;
}
