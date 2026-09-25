import { MemchorError } from "../errors.js";
import { type Db, prepared } from "../storage/database.js";

/**
 * The single definition of which records a workstream may see. Workspace isolation is
 * physical (one database file per workspace), so only workstream scope and lifecycle are
 * decided here.
 *
 * A record is *in scope* for workstream W when it belongs to W or is workspace-level
 * (workstream_id IS NULL). In-scope records can be inspected (`memory_manage`) whatever their
 * state, and serve as lineage targets for imported copies.
 *
 * A record is *visible* (eligible as current guidance) when it is in scope, its own lifecycle
 * is `active`, and no other record taints it (see src/integrity/lifecycle.ts). Visibility
 * governs recall, FTS ranking, direct reads, link and citation expansion, independent roots,
 * the head checkpoint, and everything built on recall (`memchor diag records`).
 *
 * A record is *recall-eligible* when it is visible and is not a checkpoint: the head
 * checkpoint is surfaced separately at the top of every first page, and superseded
 * checkpoint revisions are history, not current guidance (still readable directly).
 *
 * The clauses go into the WHERE of the ranking query, so ineligible records never
 * compete for rank, budget, or continuation positions. Callers bind `$workstreamId`.
 */
export const IN_SCOPE_SQL = `(r.workstream_id = $workstreamId OR r.workstream_id IS NULL)`;
export const VISIBLE_SQL = `(r.lifecycle = 'active' AND NOT EXISTS (SELECT 1 FROM taints t WHERE t.record_id = r.id) AND ${IN_SCOPE_SQL})`;
export const RECALL_ELIGIBLE_SQL = `(${VISIBLE_SQL} AND r.kind <> 'checkpoint')`;

export type Lifecycle = "active" | "corrected" | "superseded" | "retracted" | "forgotten";
export type Taint = "invalidated" | "quarantined";

export interface RecordRow {
  seq: number;
  id: string;
  kind: string;
  title: string | null;
  body: string;
  workstream_id: string | null;
  session_id: string | null;
  source_id: string | null;
  host: string;
  attribution: string;
  review_state: string;
  lifecycle: Lifecycle;
  applicability: string;
  freshness: string;
  external_refs: string;
  content_hash: string;
  superseded_by: string | null;
  created_at: string;
}

/**
 * Loads a record in this workstream's scope, whatever its lifecycle. Unknown id → `not_found`;
 * another workstream's record → `scope_denied` (its state is never disclosed).
 */
export function requireInScopeRecord(db: Db, workstreamId: string, recordId: string): RecordRow {
  const row = prepared(db, "SELECT * FROM records WHERE id = ?").get(recordId) as RecordRow | undefined;
  if (row === undefined) {
    throw new MemchorError("not_found", `No record ${recordId} exists in this workspace.`, { details: { recordId } });
  }
  if (row.workstream_id !== null && row.workstream_id !== workstreamId) {
    throw new MemchorError("scope_denied", `Record ${recordId} belongs to another workstream and is not visible here.`, {
      details: { recordId },
    });
  }
  return row;
}

/**
 * Loads a record the workstream is allowed to see as current guidance, or explains why not:
 * unknown → `not_found`; another workstream's → `scope_denied`; not active or tainted →
 * `not_found`, with its `lifecycle`, `replacementId` or `taint` so the agent can follow the
 * replacement or inspect the history with `memory_manage`.
 */
export function requireVisibleRecord(db: Db, workstreamId: string, recordId: string): RecordRow {
  const row = requireInScopeRecord(db, workstreamId, recordId);
  if (row.lifecycle !== "active") {
    throw new MemchorError(
      "not_found",
      `Record ${recordId} is ${row.lifecycle} and is no longer current guidance${row.superseded_by === null ? "" : `; its replacement is ${row.superseded_by}`}. Use memory_manage inspect for its history.`,
      { details: { recordId, lifecycle: row.lifecycle, ...(row.superseded_by === null ? {} : { replacementId: row.superseded_by }) } },
    );
  }
  const taint = prepared(db, "SELECT taint, cause_id FROM taints WHERE record_id = ? ORDER BY taint, cause_id LIMIT 1").get(recordId) as
    | { taint: Taint; cause_id: string }
    | undefined;
  if (taint !== undefined) {
    throw new MemchorError(
      "not_found",
      `Record ${recordId} is ${taint.taint} because ${taint.cause_id}, which it ${taint.taint === "invalidated" ? "restates" : "rests on"}, is no longer current. Use memory_manage inspect for details.`,
      { details: { recordId, lifecycle: row.lifecycle, taint: taint.taint, causeId: taint.cause_id } },
    );
  }
  return row;
}

/** Whether an in-scope row is current guidance (the row form of {@link VISIBLE_SQL}). */
export function isEligible(db: Db, row: Pick<RecordRow, "id" | "lifecycle">): boolean {
  return row.lifecycle === "active" && prepared(db, "SELECT 1 FROM taints WHERE record_id = ? LIMIT 1").get(row.id) === undefined;
}
