import { ELIGIBLE_STATE_SQL, eligibilityOf, IN_SCOPE_SQL, type Lifecycle, type RecordRow, requireInScopeRecord, type Taint } from "../retrieval/eligibility.js";
import type { Attribution, LinkRelation, RecordKind } from "../schemas.js";
import { type Db, prepared } from "../storage/database.js";
import type { LedgerEntry } from "./ledger.js";

/**
 * Read-only views of the memory lifecycle (src/integrity/lifecycle.ts owns every change):
 * the correction watermark a running session is told about, and the inspection of one record
 * whatever its state.
 */

// ── The correction watermark ──

/** The newest lifecycle change in this workspace (0 before any). */
export function lifecycleWatermark(db: Db): number {
  return (prepared(db, "SELECT coalesce(max(seq), 0) AS seq FROM lifecycle_events").get() as { seq: number }).seq;
}

export interface LifecycleChange {
  recordId: string;
  action: LedgerEntry["action"];
  replacementId: string | null;
  reason: string;
  host: string;
  createdAt: string;
}

/** Lifecycle changes in a session's scope it has not been told about yet. */
export interface CorrectionNotice {
  /** Pass nothing back: Memchor remembers per session what it has told you. */
  watermark: number;
  changes: LifecycleChange[];
  omitted: number;
}

const LISTED_CHANGES = 5;
const REASON_CHARS = 200;

/**
 * What changed in this workstream's scope since `since`: at most {@link LISTED_CHANGES} changes,
 * oldest first, the rest counted. Null when nothing in scope changed.
 */
export function changesSince(db: Db, workstreamId: string, since: number): CorrectionNotice | null {
  const watermark = lifecycleWatermark(db);
  if (watermark <= since) return null;
  const inScope = `seq > $since AND (workstream_id = $workstreamId OR workstream_id IS NULL)`;
  const rows = prepared(
    db,
    `SELECT record_id, action, replacement_id, reason, host, created_at FROM lifecycle_events WHERE ${inScope} ORDER BY seq LIMIT ${LISTED_CHANGES}`,
  ).all({ since, workstreamId }) as { record_id: string; action: LifecycleChange["action"]; replacement_id: string | null; reason: string; host: string; created_at: string }[];
  if (rows.length === 0) return null;
  const total = (prepared(db, `SELECT count(*) AS n FROM lifecycle_events WHERE ${inScope}`).get({ since, workstreamId }) as { n: number }).n;
  return {
    watermark,
    changes: rows.map((row) => ({
      recordId: row.record_id,
      action: row.action,
      replacementId: row.replacement_id,
      reason: row.reason.length <= REASON_CHARS ? row.reason : `${row.reason.slice(0, REASON_CHARS - 1)}…`,
      host: row.host,
      createdAt: row.created_at,
    })),
    omitted: total - rows.length,
  };
}

// ── Inspection ──

export interface HistoryEntry {
  action: LifecycleChange["action"];
  reason: string;
  attribution: Attribution;
  replacementId: string | null;
  host: string;
  sessionId: string | null;
  createdAt: string;
}

export interface Related {
  recordId: string;
  relation: LinkRelation;
  kind: RecordKind;
  excerpt: string;
  lifecycle: Lifecycle;
  eligible: boolean;
  createdAt: string;
}

export interface Inspection {
  row: RecordRow;
  lifecycle: Lifecycle;
  eligible: boolean;
  taints: { causeId: string; taint: Taint }[];
  history: HistoryEntry[];
  replacement: { recordId: string; kind: RecordKind; excerpt: string; lifecycle: Lifecycle; eligible: boolean } | null;
  /** What the record rests on or restates (outgoing supported_by / derived_from). */
  evidence: Related[];
  /** Other versions of the same host event, and records it is loosely related to. */
  conflicts: Related[];
  /** Known downstream derivations (incoming derived_from / supported_by). */
  derivations: (Related & { taint: Taint | null })[];
  counts: { evidence: number; conflicts: number; derivations: number; history: number };
}

const INSPECT_LISTED = 20;
const EXCERPT_CHARS = 300;

/** Everything Memchor knows about one in-scope record, whatever its state. Read-only. */
export function inspectRecord(db: Db, workstreamId: string, recordId: string): Inspection {
  const row = requireInScopeRecord(db, workstreamId, recordId);
  const taints = prepared(db, "SELECT cause_id AS causeId, taint FROM taints WHERE record_id = ? ORDER BY created_at, cause_id").all(row.id) as { causeId: string; taint: Taint }[];
  const history = prepared(
    db,
    `SELECT action, reason, attribution, replacement_id AS replacementId, host, session_id AS sessionId, created_at AS createdAt
     FROM lifecycle_events WHERE record_id = ? OR replacement_id = ? ORDER BY seq`,
  ).all(row.id, row.id) as HistoryEntry[];

  const params = { recordId: row.id, workstreamId };
  const related = (sql: string): Related[] =>
    (prepared(db, sql).all(params) as (Omit<Related, "eligible" | "excerpt"> & { body: string; eligible: number })[]).map(({ body, eligible, ...rest }) => ({
      ...rest,
      excerpt: excerpt(body),
      eligible: eligible === 1,
    }));
  const columns = `r.id AS recordId, r.kind, r.body, r.lifecycle, r.created_at AS createdAt, ${ELIGIBLE_STATE_SQL} AS eligible`;
  const evidence = related(
    `SELECT ${columns}, l.relation FROM links l JOIN records r ON r.id = l.to_id
     WHERE l.from_id = $recordId AND l.relation IN ('supported_by', 'derived_from') AND ${IN_SCOPE_SQL} ORDER BY r.seq`,
  );
  const conflicts = related(
    `SELECT ${columns}, 'related_to' AS relation FROM records r
     WHERE r.id IN (SELECT o.record_id FROM import_events e JOIN import_events o ON o.host = e.host AND o.event_id = e.event_id
                    WHERE e.record_id = $recordId AND o.record_id IS NOT NULL AND o.record_id <> $recordId)
       AND ${IN_SCOPE_SQL}
     UNION
     SELECT ${columns}, l.relation FROM links l JOIN records r ON r.id = l.to_id WHERE l.from_id = $recordId AND l.relation = 'related_to' AND ${IN_SCOPE_SQL}
     ORDER BY createdAt`,
  );
  const taintOf = prepared(db, "SELECT taint FROM taints WHERE record_id = ? AND cause_id = ?");
  const derivations = related(
    `SELECT ${columns}, l.relation FROM links l JOIN records r ON r.id = l.from_id
     WHERE l.to_id = $recordId AND l.relation IN ('supported_by', 'derived_from') AND ${IN_SCOPE_SQL} ORDER BY r.seq`,
  ).map((d) => ({ ...d, taint: ((taintOf.get(d.recordId, row.id) as { taint: Taint } | undefined)?.taint ?? null) }));

  let replacement: Inspection["replacement"] = null;
  if (row.superseded_by !== null) {
    const next = prepared(db, "SELECT id, kind, body, lifecycle FROM records WHERE id = ?").get(row.superseded_by) as { id: string; kind: RecordKind; body: string; lifecycle: Lifecycle };
    replacement = { recordId: next.id, kind: next.kind, excerpt: excerpt(next.body), lifecycle: next.lifecycle, eligible: eligibilityOf(db, next).eligible };
  }
  return {
    row,
    lifecycle: row.lifecycle,
    eligible: eligibilityOf(db, row).eligible,
    taints,
    history: history.slice(-INSPECT_LISTED),
    replacement,
    evidence: evidence.slice(0, INSPECT_LISTED),
    conflicts: conflicts.slice(0, INSPECT_LISTED),
    derivations: derivations.slice(0, INSPECT_LISTED),
    counts: { evidence: evidence.length, conflicts: conflicts.length, derivations: derivations.length, history: history.length },
  };
}

/** A bounded glimpse of a body, for listings (inspect, forget previews). */
export function excerpt(body: string): string {
  return body.length <= EXCERPT_CHARS ? body : `${body.slice(0, EXCERPT_CHARS - 1)}…`;
}
