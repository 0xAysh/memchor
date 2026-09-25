import { MemchorError } from "../errors.js";
import { IN_SCOPE_SQL, isEligible, type Lifecycle, type RecordRow, requireInScopeRecord, type Taint } from "../retrieval/eligibility.js";
import type { Applicability, Attribution, LinkRelation, RecordKind } from "../schemas.js";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";
import { type Propagation, taintDependents } from "./taints.js";

/**
 * The memory lifecycle: every change to whether a claim is current guidance.
 *
 * ```text
 *                  correct ──▶ corrected   (wrong; a `correction` record supersedes it)
 *   active ──────  supersede ─▶ superseded (right then, outdated now; a same-kind record replaces it)
 *     ▲            retract ──▶ retracted  (wrong; withdrawn without a replacement)
 *     └── restore ◀──────────────┘
 * ```
 *
 * Invariants, each upheld by one transaction per change (no model or network call inside):
 * - A claim is one *observation*: the record plus every in-scope copy of the same host event
 *   (a Claude Code `/branch` copy, an edited version). A change applies to all of them, and the
 *   event is suppressed so a later import of another copy or version cannot bring it back.
 * - Dependents are tainted in the same transaction (see `taints.ts`), so no reader ever sees
 *   a corrected claim gone while a restatement of it is still current.
 * - History is never rewritten: the old record keeps its body and provenance, the replacement
 *   is a new attributed record linked `supersedes`, and every change appends a
 *   `lifecycle_events` row (the audit trail and the correction watermark).
 * - Only a retraction made here can be restored, and a restore removes exactly the taints and
 *   suppressions that retraction added. A correction is undone by correcting again. Records the
 *   v3 migration retracted (unsafe tool output) can never be restored.
 *
 * Irreversible limits: a claim already loaded into a model's context, exported, or written in a
 * host transcript is not erased by any of this. A running session learns of changes through
 * the watermark on its next pack; what it does with what it already read is up to the agent.
 */

export type ChangeAction = "correct" | "supersede" | "retract";

export interface Actor {
  sessionId: string;
  host: string;
  attribution: Attribution;
  reason: string;
}

export interface ChangeScope {
  workstreamId: string;
}

/** Ids are listed up to this many per list; the rest are counted in `omitted`. */
const LISTED = 50;

export interface Affected {
  /** The records changed: the target and its in-scope copies of the same host event. */
  records: string[];
  /** In-scope records that restate the claim and are no longer current. */
  invalidated: string[];
  /** In-scope records that rest on the claim, or summarise it without lineage, and are no longer current. */
  quarantined: string[];
  /** Dependents in other workstreams (tainted too, not listed). */
  otherWorkstreams: number;
  /** Ids beyond the listing cap of each list. */
  omitted: number;
  /** Host events suppressed against re-import. */
  suppressedEvents: number;
}

export interface ChangeResult {
  recordId: string;
  replacementId: string | null;
  affected: Affected;
  watermark: number;
}

const NEXT_STATE: Record<ChangeAction, Lifecycle> = { correct: "corrected", supersede: "superseded", retract: "retracted" };
const PROPAGATION: Record<ChangeAction, Propagation> = { correct: "wrong", supersede: "outdated", retract: "wrong" };

/**
 * Corrects, supersedes or retracts a claim in the caller's write transaction. `body` is the
 * corrected claim (correct) or the new version (supersede). Throws `lifecycle_conflict` when
 * the claim is no longer active, naming its state and replacement.
 */
export function changeClaim(
  db: Db,
  scope: ChangeScope,
  request: { action: ChangeAction; recordId: string; body?: string; applicability: Applicability; actor: Actor },
): ChangeResult {
  requireTransaction(db, "changeClaim");
  const { action, actor } = request;
  const target = requireInScopeRecord(db, scope.workstreamId, request.recordId);
  if (target.lifecycle !== "active") throw lifecycleConflict(target, action);
  if (action === "supersede" && target.kind === "checkpoint") {
    throw new MemchorError("invalid_input", "A checkpoint is superseded by publishing the next revision with memory_checkpoint, not by memory_manage.", {
      details: { recordId: target.id },
    });
  }
  const now = new Date().toISOString();
  const observation = sameObservation(db, scope.workstreamId, target, "active");

  let replacementId: string | null = null;
  if (action !== "retract") {
    const body = request.body ?? "";
    replacementId = appendRecord(db, scope.workstreamId, {
      kind: action === "correct" ? "correction" : (target.kind as RecordKind),
      // The old title may state the wrong claim; a correction carries only the corrected one.
      title: action === "supersede" ? target.title : null,
      body: action === "correct" ? `${body}\n\nReason: ${actor.reason}` : body,
      workstreamId: target.workstream_id,
      sessionId: actor.sessionId,
      host: actor.host,
      attribution: actor.attribution,
      reviewState: "unreviewed",
      applicability: request.applicability,
      externalRefs: [],
      links: [{ recordId: target.id, relation: "supersedes" satisfies LinkRelation }],
      createdAt: now,
    }).recordId;
  }
  const update = prepared(
    db,
    `UPDATE records SET lifecycle = ?, superseded_by = ?, retracted_at = CASE WHEN ? = 'retracted' THEN ? ELSE retracted_at END WHERE id = ? AND lifecycle = 'active'`,
  );
  for (const id of observation.records) update.run(NEXT_STATE[action], replacementId, NEXT_STATE[action], now, id);

  const tainted = taintDependents(db, target.id, observation.records, PROPAGATION[action], now);
  const suppress = prepared(db, "INSERT OR IGNORE INTO suppressions (host, event_id, cause_id, created_at) VALUES (?, ?, ?, ?)");
  let suppressedEvents = 0;
  for (const event of observation.events) suppressedEvents += suppress.run(event.host, event.eventId, target.id, now).changes;

  const watermark = appendEvent(db, target, { action, replacementId, actor, now });
  return { recordId: target.id, replacementId, affected: describe(db, scope, observation.records, tainted, suppressedEvents), watermark };
}

export interface RestoreResult {
  recordId: string;
  affected: { records: string[]; released: string[]; omitted: number; suppressedEvents: number };
  watermark: number;
}

/** Undoes a retraction made through {@link changeClaim}: the claim, and every dependent it alone tainted, are current again. */
export function restoreClaim(db: Db, scope: ChangeScope, request: { recordId: string; actor: Actor }): RestoreResult {
  requireTransaction(db, "restoreClaim");
  const target = requireInScopeRecord(db, scope.workstreamId, request.recordId);
  const last = prepared(db, "SELECT action FROM lifecycle_events WHERE record_id = ? ORDER BY seq DESC LIMIT 1").get(target.id) as { action: string } | undefined;
  if (target.lifecycle !== "retracted" || last?.action !== "retract") throw lifecycleConflict(target, "restore");
  const now = new Date().toISOString();
  const observation = sameObservation(db, scope.workstreamId, target, "retracted");
  const ids = JSON.stringify(observation.records);
  const dependents = (prepared(db, "SELECT DISTINCT record_id FROM taints WHERE cause_id IN (SELECT value FROM json_each(?))").all(ids) as { record_id: string }[]).map(
    (row) => row.record_id,
  );
  prepared(db, "DELETE FROM taints WHERE cause_id IN (SELECT value FROM json_each(?))").run(ids);
  const suppressedEvents = prepared(db, "DELETE FROM suppressions WHERE cause_id IN (SELECT value FROM json_each(?))").run(ids).changes;
  prepared(db, "UPDATE records SET lifecycle = 'active', retracted_at = NULL WHERE id IN (SELECT value FROM json_each(?))").run(ids);
  const stillTainted = prepared(db, "SELECT 1 FROM taints WHERE record_id = ? LIMIT 1");
  const released = inScope(db, scope, dependents.filter((id) => stillTainted.get(id) === undefined)).listed;
  const watermark = appendEvent(db, target, { action: "restore", replacementId: null, actor: request.actor, now });
  return {
    recordId: target.id,
    affected: { records: observation.records, released: released.slice(0, LISTED), omitted: Math.max(0, released.length - LISTED), suppressedEvents },
    watermark,
  };
}

// ── The correction watermark ──

/** The newest lifecycle change in this workspace (0 before any). */
export function lifecycleWatermark(db: Db): number {
  return (prepared(db, "SELECT coalesce(max(seq), 0) AS seq FROM lifecycle_events").get() as { seq: number }).seq;
}

export interface LifecycleChange {
  recordId: string;
  action: ChangeAction | "restore" | "forget";
  replacementId: string | null;
  reason: string;
  host: string;
  createdAt: string;
}

/**
 * What changed in this workstream's scope since `since`: at most {@link LISTED_CHANGES} changes,
 * oldest first, the rest counted. Null when nothing in scope changed.
 */
export interface CorrectionNotice {
  /** Pass nothing back: Memchor remembers per session what it has told you. */
  watermark: number;
  changes: LifecycleChange[];
  omitted: number;
}

const LISTED_CHANGES = 5;
const REASON_CHARS = 200;

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
    (prepared(db, sql).all(params) as (Omit<Related, "eligible" | "excerpt"> & { body: string; tainted: number })[]).map(({ body, tainted, ...rest }) => ({
      ...rest,
      excerpt: excerpt(body),
      eligible: rest.lifecycle === "active" && tainted === 0,
    }));
  const columns = `r.id AS recordId, r.kind, r.body, r.lifecycle, r.created_at AS createdAt, EXISTS (SELECT 1 FROM taints t WHERE t.record_id = r.id) AS tainted`;
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
    replacement = { recordId: next.id, kind: next.kind, excerpt: excerpt(next.body), lifecycle: next.lifecycle, eligible: isEligible(db, next) };
  }
  return {
    row,
    lifecycle: row.lifecycle,
    eligible: row.lifecycle === "active" && taints.length === 0,
    taints,
    history: history.slice(-INSPECT_LISTED),
    replacement,
    evidence: evidence.slice(0, INSPECT_LISTED),
    conflicts: conflicts.slice(0, INSPECT_LISTED),
    derivations: derivations.slice(0, INSPECT_LISTED),
    counts: { evidence: evidence.length, conflicts: conflicts.length, derivations: derivations.length, history: history.length },
  };
}

// ── internals ──

/**
 * The target and its in-scope copies in `lifecycle`: every record imported from the same host
 * event (host + event id, across transcripts and versions), which is also how independent roots
 * identify one observation. A record agents wrote directly is its own observation.
 */
function sameObservation(db: Db, workstreamId: string, target: RecordRow, lifecycle: Lifecycle): { records: string[]; events: { host: string; eventId: string }[] } {
  const event = prepared(db, "SELECT host, event_id FROM import_events WHERE record_id = ? LIMIT 1").get(target.id) as { host: string; event_id: string } | undefined;
  if (event === undefined) return { records: [target.id], events: [] };
  const copies = (
    prepared(
      db,
      `SELECT DISTINCT r.id FROM import_events e JOIN records r ON r.id = e.record_id
       WHERE e.host = $host AND e.event_id = $eventId AND r.lifecycle = $lifecycle AND ${IN_SCOPE_SQL} ORDER BY r.seq`,
    ).all({ host: event.host, eventId: event.event_id, lifecycle, workstreamId }) as { id: string }[]
  ).map((row) => row.id);
  return { records: [target.id, ...copies.filter((id) => id !== target.id)], events: [{ host: event.host, eventId: event.event_id }] };
}

function appendEvent(db: Db, target: RecordRow, change: { action: LifecycleChange["action"]; replacementId: string | null; actor: Actor; now: string }): number {
  const { lastInsertRowid } = prepared(
    db,
    `INSERT INTO lifecycle_events (record_id, workstream_id, action, replacement_id, reason, attribution, session_id, host, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(target.id, target.workstream_id, change.action, change.replacementId, change.actor.reason, change.actor.attribution, change.actor.sessionId, change.actor.host, change.now);
  return Number(lastInsertRowid);
}

function describe(db: Db, scope: ChangeScope, records: string[], tainted: ReadonlyMap<string, Taint>, suppressedEvents: number): Affected {
  const of = (kind: Taint): { listed: string[]; elsewhere: number } => inScope(db, scope, [...tainted].filter(([, taint]) => taint === kind).map(([id]) => id));
  const invalidated = of("invalidated");
  const quarantined = of("quarantined");
  return {
    records,
    invalidated: invalidated.listed.slice(0, LISTED),
    quarantined: quarantined.listed.slice(0, LISTED),
    otherWorkstreams: invalidated.elsewhere + quarantined.elsewhere,
    omitted: Math.max(0, invalidated.listed.length - LISTED) + Math.max(0, quarantined.listed.length - LISTED),
    suppressedEvents,
  };
}

/** Splits ids into those in the scope (listed, in storage order) and a count of the rest. */
function inScope(db: Db, scope: ChangeScope, ids: readonly string[]): { listed: string[]; elsewhere: number } {
  if (ids.length === 0) return { listed: [], elsewhere: 0 };
  const listed = (
    prepared(db, `SELECT r.id FROM records r WHERE r.id IN (SELECT value FROM json_each($ids)) AND ${IN_SCOPE_SQL} ORDER BY r.seq`).all({
      ids: JSON.stringify(ids),
      workstreamId: scope.workstreamId,
    }) as { id: string }[]
  ).map((row) => row.id);
  return { listed, elsewhere: ids.length - listed.length };
}

const PAST: Record<string, string> = { correct: "corrected", supersede: "superseded", retract: "retracted", restore: "restored", forget: "forgotten" };

function lifecycleConflict(target: RecordRow, action: string): MemchorError {
  const state = target.lifecycle === "active" ? "active (only a retraction made with memory_manage can be restored)" : target.lifecycle;
  return new MemchorError(
    "lifecycle_conflict",
    `Record ${target.id} is ${state}, so it cannot be ${PAST[action] ?? action}${target.superseded_by === null ? "" : `; its replacement is ${target.superseded_by}`}. Inspect it with memory_manage.`,
    { details: { recordId: target.id, lifecycle: target.lifecycle, ...(target.superseded_by === null ? {} : { replacementId: target.superseded_by }) } },
  );
}

function excerpt(body: string): string {
  return body.length <= EXCERPT_CHARS ? body : `${body.slice(0, EXCERPT_CHARS - 1)}…`;
}
