import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MemchorError } from "../errors.js";
import { IN_SCOPE_SQL, isEligible, type Lifecycle, type RecordRow, requireInScopeRecord, type Taint } from "../retrieval/eligibility.js";
import type { Applicability, Attribution, LinkRelation, RecordKind } from "../schemas.js";
import { type Db, openDatabase, prepared, requireTransaction, writeTransaction } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";
import { appendLedger, type LedgerEntry, readLedger } from "./ledger.js";
import { findDependents, insertTaints, type Propagation } from "./taints.js";

/**
 * The memory lifecycle: every change to whether a claim is current guidance.
 *
 * ```text
 *                  correct ──▶ corrected   (wrong; a `correction` record supersedes it)
 *   active ──────  supersede ─▶ superseded (right then, outdated now; a same-kind record replaces it)
 *     ▲            retract ──▶ retracted  (wrong; withdrawn without a replacement)
 *     └── restore ◀──────────────┘
 *   any state but forgotten ── forget (preview, then a confirmed call) ──▶ forgotten (payload removed; final)
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
 *   `lifecycle_events` row (the audit trail and the correction watermark) and a ledger entry.
 * - Only a retraction made here can be restored, and a restore removes exactly the taints and
 *   suppressions that retraction added. A correction is undone by correcting again. Records the
 *   v3 migration retracted (unsafe tool output) can never be restored.
 * - Forgetting is the one change that deletes: the payload, search chunks and links go, a
 *   tombstone row (id, kind, lifecycle, provenance ids) and the suppressions stay. It needs the
 *   token of a preview whose impact is unchanged, so the user confirms what actually happens.
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

const NEXT_STATE: Record<ChangeAction | "forget", Lifecycle> = { correct: "corrected", supersede: "superseded", retract: "retracted", forget: "forgotten" };
const PROPAGATION: Record<ChangeAction | "forget", Propagation> = { correct: "wrong", supersede: "outdated", retract: "wrong", forget: "removed" };

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
  const observation = sameObservation(db, scope.workstreamId, target, (lifecycle) => lifecycle === "active");

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
  const entry = ledgerEntry(action, target.id, replacementId, actor, observation.events, now);
  const effects = applyEffects(db, entry, target, observation.records, actor, new Set(observation.records));
  appendLedger(db, entry);
  return { recordId: target.id, replacementId, affected: describe(db, scope, observation.records, effects.tainted, effects.suppressed), watermark: effects.watermark };
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
  const observation = sameObservation(db, scope.workstreamId, target, (lifecycle) => lifecycle === "retracted");
  if (!restorable(db, target, observation.records)) throw lifecycleConflict(target, "restore");
  const now = new Date().toISOString();
  const dependents = (prepared(db, "SELECT DISTINCT record_id FROM taints WHERE cause_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(observation.records)) as {
    record_id: string;
  }[]).map((row) => row.record_id);
  const entry = ledgerEntry("restore", target.id, null, request.actor, observation.events, now);
  const effects = applyEffects(db, entry, target, observation.records, request.actor, new Set());
  appendLedger(db, entry);
  const stillTainted = prepared(db, "SELECT 1 FROM taints WHERE record_id = ? LIMIT 1");
  const released = inScope(db, scope, dependents.filter((id) => stillTainted.get(id) === undefined)).listed;
  return {
    recordId: target.id,
    affected: { records: observation.records, released: released.slice(0, LISTED), omitted: Math.max(0, released.length - LISTED), suppressedEvents: effects.suppressed },
    watermark: effects.watermark,
  };
}

// ── Forgetting ──

/** A confirmation is valid this long after its preview: the user confirms what they were just shown. */
const CONFIRMATION_TTL_MS = 30 * 60 * 1000;
export const MAX_FORGET_TARGETS = 50;

export interface ForgetTarget {
  recordId: string;
  kind: RecordKind;
  title: string | null;
  excerpt: string;
  lifecycle: Lifecycle;
  workspaceLevel: boolean;
  host: string;
  createdAt: string;
}

export interface ForgetImpact {
  /** Every record whose payload goes: the requested ones and their in-scope copies of the same host event. */
  records: string[];
  /** Records that restate them and will stop being current (their own content is kept). */
  invalidated: string[];
  /** Records that rest on them, or summarise them without lineage, and will stop being current. */
  quarantined: string[];
  otherWorkstreams: number;
  omitted: number;
  /** Provenance links removed. */
  links: number;
  /** Search chunks removed. */
  chunks: number;
  /** Host events (the claim's own, and a tool result's call) blocked from re-import. */
  suppressedEvents: number;
  /** Whether the workstream's head checkpoint is among the records. */
  headCheckpoint: boolean;
}

export interface ForgetPreview {
  targets: ForgetTarget[];
  impact: ForgetImpact;
  confirmToken: string;
  expiresAt: string;
}

interface ForgetPlan {
  groups: { target: RecordRow; records: string[]; events: { host: string; eventId: string }[]; tainted: Map<string, Taint> }[];
  impact: ForgetImpact;
  digest: string;
}

export interface ConfirmationKey {
  secret: Buffer;
  workspaceId: string;
  workstreamId: string;
}

/** What forgetting `recordIds` would remove and invalidate, and the token that confirms exactly that. Read-only. */
export function previewForget(db: Db, scope: ChangeScope, key: ConfirmationKey, recordIds: readonly string[], now = Date.now()): ForgetPreview {
  const plan = planForget(db, scope, recordIds);
  const expiresAt = new Date(now + CONFIRMATION_TTL_MS).toISOString();
  const payload = Buffer.from(JSON.stringify({ v: 1, ids: [...new Set(recordIds)], d: plan.digest, exp: expiresAt })).toString("base64url");
  return {
    targets: plan.groups.map(({ target }) => ({
      recordId: target.id,
      kind: target.kind as RecordKind,
      title: target.title,
      excerpt: excerpt(target.body),
      lifecycle: target.lifecycle,
      workspaceLevel: target.workstream_id === null,
      host: target.host,
      createdAt: target.created_at,
    })),
    impact: plan.impact,
    confirmToken: `${payload}.${signConfirmation(key, payload)}`,
    expiresAt,
  };
}

export interface ForgetResult {
  forgotten: string[];
  affected: Affected;
  watermark: number;
}

/**
 * Forgets what a preview showed, in the caller's write transaction. The token must be this
 * scope's, unexpired, and its impact must still be what the preview showed (`preview_outdated`
 * otherwise: preview again and ask the user again).
 */
export function confirmForget(db: Db, scope: ChangeScope, key: ConfirmationKey, request: { confirmToken: string; actor: Actor }, now = Date.now()): ForgetResult {
  requireTransaction(db, "confirmForget");
  const token = openConfirmation(key, request.confirmToken, now);
  const plan = planForget(db, scope, token.ids);
  if (plan.digest !== token.d) {
    throw new MemchorError("invalid_input", "Memory changed since the forget preview, so the confirmation no longer describes what would happen. Preview again and ask the user to confirm the new impact.", {
      details: { reason: "preview_outdated" },
    });
  }
  const at = new Date(now).toISOString();
  const forgotten = new Set(plan.groups.flatMap((group) => group.records));
  let watermark = 0;
  let suppressed = 0;
  const tainted = new Map<string, Taint>();
  for (const group of plan.groups) {
    const entry = ledgerEntry("forget", group.target.id, null, request.actor, group.events, at);
    const effects = applyEffects(db, entry, group.target, group.records, request.actor, forgotten);
    appendLedger(db, entry);
    watermark = effects.watermark;
    suppressed += effects.suppressed;
    for (const [id, kind] of effects.tainted) if (tainted.get(id) !== "invalidated") tainted.set(id, kind);
  }
  return { forgotten: [...forgotten], affected: describe(db, scope, [...forgotten], tainted, suppressed), watermark };
}

function planForget(db: Db, scope: ChangeScope, recordIds: readonly string[]): ForgetPlan {
  const requested = [...new Set(recordIds)];
  const groups: ForgetPlan["groups"] = [];
  const all = new Set<string>();
  for (const recordId of requested) {
    if (all.has(recordId)) continue; // already a copy of an earlier target
    const target = requireInScopeRecord(db, scope.workstreamId, recordId);
    if (target.lifecycle === "forgotten") throw lifecycleConflict(target, "forget");
    const observation = sameObservation(db, scope.workstreamId, target, (lifecycle) => lifecycle !== "forgotten");
    for (const id of observation.records) all.add(id);
    groups.push({ target, records: observation.records, events: [...observation.events, ...callEventsOf(db, observation.records)], tainted: new Map() });
  }
  const tainted = new Map<string, Taint>();
  for (const group of groups) {
    group.tainted = findDependents(db, group.records, "removed", all);
    for (const [id, kind] of group.tainted) if (tainted.get(id) !== "invalidated") tainted.set(id, kind);
  }
  const ids = JSON.stringify([...all]);
  const count = (sql: string): number => (prepared(db, sql).get(ids) as { n: number }).n;
  const links = (prepared(db, "SELECT count(*) AS n FROM links WHERE from_id IN (SELECT value FROM json_each($ids)) OR to_id IN (SELECT value FROM json_each($ids))").get({ ids }) as { n: number }).n;
  const chunks = count("SELECT count(*) AS n FROM chunks WHERE record_id IN (SELECT value FROM json_each(?))");
  const events = new Set(groups.flatMap((group) => group.events.map((event) => `${event.host}\u0000${event.eventId}`)));
  const head = prepared(db, "SELECT c.record_id FROM workstreams w JOIN checkpoints c ON c.workstream_id = w.id AND c.revision = w.head_revision WHERE w.id = ?").get(scope.workstreamId) as
    | { record_id: string }
    | undefined;
  const described = describe(db, scope, [...all], tainted, events.size);
  const impact: ForgetImpact = { ...described, links, chunks, headCheckpoint: head !== undefined && all.has(head.record_id) };
  const digest = createHash("sha256")
    .update(JSON.stringify([groups.map((g) => [g.target.id, g.target.lifecycle, g.records]), [...tainted].sort(), links, chunks, [...events].sort()]))
    .digest("base64url");
  return { groups, impact, digest };
}

function signConfirmation(key: ConfirmationKey, payload: string): string {
  return createHmac("sha256", key.secret).update(`forget\u0000${key.workspaceId}\u0000${key.workstreamId}\u0000${payload}`).digest("base64url");
}

function openConfirmation(key: ConfirmationKey, token: string, now: number): { ids: string[]; d: string } {
  const invalid = (why: string): MemchorError =>
    new MemchorError("invalid_input", `The confirmToken is not valid here (${why}). Call memory_manage with action forget_preview, show the user the impact, and use the new token.`, {
      details: { reason: "invalid_confirmation" },
    });
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) throw invalid("malformed");
  const expected = Buffer.from(signConfirmation(key, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid("signature mismatch, or issued in another workspace or workstream");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v: number; ids: string[]; d: string; exp: string };
  if (decoded.v !== 1) throw invalid("unsupported version");
  if (Date.parse(decoded.exp) < now) throw invalid("expired");
  return decoded;
}

/** The call events of forgotten tool results: their bookkeeping holds the call's summary, which goes too. */
function callEventsOf(db: Db, recordIds: readonly string[]): { host: string; eventId: string }[] {
  return prepared(
    db,
    `SELECT DISTINCT c.host, c.event_id AS eventId FROM import_events e
     JOIN import_events c ON c.host = e.host AND c.transcript_id = e.transcript_id AND c.disposition = 'tool_call'
       AND json_extract(c.meta, '$.callId') = json_extract(e.meta, '$.callId')
     WHERE e.record_id IN (SELECT value FROM json_each(?)) AND json_extract(e.meta, '$.callId') IS NOT NULL`,
  ).all(JSON.stringify(recordIds)) as { host: string; eventId: string }[];
}

// ── The ledger: re-applying changes an older database copy lacks ──

/**
 * Opens a workspace database for use: migrated (see `openDatabase`), then brought up to date
 * with the lifecycle ledger, so no reader or importer ever sees an older copy's resurrected claims.
 */
export function openWorkspaceDatabase(path: string, options: { busyTimeoutMs?: number } = {}): Db {
  const db = openDatabase(path, options);
  try {
    replayLedger(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const REPLAYED = "Re-applied from the lifecycle ledger: this database was older than the change (restored from a copy).";

/**
 * Re-applies every ledger entry this database lacks (see ledger.ts). Cheap when nothing is
 * missing: the check runs without the write lock, and only a gap takes it.
 */
export function replayLedger(db: Db): number {
  const missing = (): LedgerEntry[] => {
    const entries = readLedger(db);
    if (entries.length === 0) return [];
    const applied = new Set((prepared(db, "SELECT ledger_id FROM lifecycle_events").all() as { ledger_id: string }[]).map((row) => row.ledger_id));
    return entries.filter((entry) => !applied.has(entry.id));
  };
  if (missing().length === 0) return 0;
  // Re-read under the write lock: a change in flight in another process appends its entry
  // inside its own transaction, so it is either committed by now or was never committed.
  return writeTransaction(db, () => {
    const entries = missing();
    for (const entry of entries) replayEntry(db, entry);
    return entries.length;
  });
}

function replayEntry(db: Db, entry: LedgerEntry): void {
  const target = prepared(db, "SELECT * FROM records WHERE id = ?").get(entry.recordId) as RecordRow | undefined;
  const actor: Actor = { sessionId: "", host: entry.host, attribution: entry.attribution, reason: REPLAYED };
  const keep = (lifecycle: Lifecycle): boolean =>
    entry.action === "restore" ? lifecycle === "retracted" : entry.action === "forget" ? lifecycle !== "forgotten" : lifecycle === "active";
  const records = target === undefined ? [entry.recordId] : sameObservationIn(db, target.workstream_id, target, keep).records;
  const applies = target !== undefined && keep(target.lifecycle) && (entry.action !== "restore" || restorable(db, target, records));
  if (target === undefined || !applies) {
    // Nothing to change in the rows (the record predates this copy, or is already in that state),
    // but the events are still blocked (or released), and the entry is marked applied.
    effectsOnEvents(db, entry, records);
    appendEvent(db, entry, target?.workstream_id ?? null, actor);
    return;
  }
  const replacement = entry.replacementId !== null && prepared(db, "SELECT 1 FROM records WHERE id = ?").get(entry.replacementId) !== undefined ? entry.replacementId : null;
  applyEffects(db, { ...entry, replacementId: replacement }, target, records, actor, new Set(records));
}

// ── Effects: the one place rows change ──

/**
 * Applies a change's effects to its records: lifecycle (and payload removal for forget), taints,
 * suppressions, and the audit row. Shared by live changes and ledger replay, so a replayed
 * change has exactly the effects the original had.
 */
function applyEffects(
  db: Db,
  entry: LedgerEntry,
  target: RecordRow,
  records: readonly string[],
  actor: Actor,
  exclude: ReadonlySet<string>,
): { tainted: Map<string, Taint>; suppressed: number; watermark: number } {
  const ids = JSON.stringify(records);
  let tainted = new Map<string, Taint>();
  if (entry.action === "restore") {
    prepared(db, "DELETE FROM taints WHERE cause_id IN (SELECT value FROM json_each(?))").run(ids);
    prepared(db, "UPDATE records SET lifecycle = 'active', retracted_at = NULL WHERE id IN (SELECT value FROM json_each(?))").run(ids);
  } else {
    // Found before a forget deletes the links that lead to the dependents.
    tainted = findDependents(db, records, PROPAGATION[entry.action], exclude);
    insertTaints(db, target.id, tainted, entry.at);
    if (entry.action === "forget") removePayload(db, records, entry.events);
    prepared(
      db,
      `UPDATE records SET lifecycle = $lifecycle, superseded_by = coalesce($replacement, superseded_by),
         retracted_at = CASE WHEN $lifecycle IN ('retracted', 'forgotten') THEN $at ELSE retracted_at END
       WHERE id IN (SELECT value FROM json_each($ids))`,
    ).run({ lifecycle: NEXT_STATE[entry.action], replacement: entry.replacementId, at: entry.at, ids });
  }
  const suppressed = effectsOnEvents(db, entry, records);
  const watermark = appendEvent(db, entry, target.workstream_id, actor);
  return { tainted, suppressed, watermark };
}

/** Suppresses the entry's host events (or, for a restore, releases what the restored records caused). */
function effectsOnEvents(db: Db, entry: LedgerEntry, records: readonly string[]): number {
  if (entry.action === "restore") return prepared(db, "DELETE FROM suppressions WHERE cause_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(records)).changes;
  const suppress = prepared(db, "INSERT OR IGNORE INTO suppressions (host, event_id, cause_id, created_at) VALUES (?, ?, ?, ?)");
  let n = 0;
  for (const event of entry.events) n += suppress.run(event.host, event.eventId, entry.recordId, entry.at).changes;
  return n;
}

/**
 * Deletes what a forgotten record said: title, body, references, applicability and content
 * hash, its search chunks (and their FTS entries, then merged away), its links, the summary its
 * tool call left in import bookkeeping, and the reasons of its earlier lifecycle changes (they
 * may quote it). Ids, kind, host, times and provenance ids stay as the tombstone.
 */
function removePayload(db: Db, records: readonly string[], events: readonly { host: string; eventId: string }[]): void {
  const ids = JSON.stringify(records);
  const chunks = prepared(db, "SELECT id, text FROM chunks WHERE record_id IN (SELECT value FROM json_each(?))").all(ids) as { id: number; text: string }[];
  const unindex = prepared(db, "INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', ?, ?)");
  for (const chunk of chunks) unindex.run(chunk.id, chunk.text);
  prepared(db, "DELETE FROM chunks WHERE record_id IN (SELECT value FROM json_each(?))").run(ids);
  // Rewrites the index without the deleted entries, instead of leaving them in older segments.
  if (chunks.length > 0) db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize')");
  prepared(db, "DELETE FROM links WHERE from_id IN (SELECT value FROM json_each($ids)) OR to_id IN (SELECT value FROM json_each($ids))").run({ ids });
  prepared(
    db,
    `UPDATE records SET title = NULL, body = '', external_refs = '[]', applicability = '{}', content_hash = 'forgotten'
     WHERE id IN (SELECT value FROM json_each(?))`,
  ).run(ids);
  prepared(db, "UPDATE lifecycle_events SET reason = '[forgotten]' WHERE record_id IN (SELECT value FROM json_each(?))").run(ids);
  const scrubCall = prepared(
    db,
    `UPDATE import_events SET meta = json_object('callId', json_extract(meta, '$.callId'), 'tool', json_extract(meta, '$.tool'),
       'summary', '[forgotten]', 'retention', json_extract(meta, '$.retention'), 'paths', json('[]'), 'urls', json('[]'), 'sensitive', json('false'))
     WHERE host = ? AND event_id = ? AND disposition = 'tool_call'`,
  );
  for (const event of events) scrubCall.run(event.host, event.eventId);
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

function ledgerEntry(action: LedgerEntry["action"], recordId: string, replacementId: string | null, actor: Actor, events: LedgerEntry["events"], at: string): LedgerEntry {
  return { v: 1, id: `led_${randomUUID().replaceAll("-", "")}`, action, recordId, replacementId, attribution: actor.attribution, host: actor.host, events, at };
}

/**
 * Whether a retracted record was retracted through memory_manage (so it is restorable): the
 * newest change to its observation (the record or a copy the change was made through) is a retraction.
 */
function restorable(db: Db, target: RecordRow, observation: readonly string[]): boolean {
  if (target.lifecycle !== "retracted") return false;
  const last = prepared(db, "SELECT action FROM lifecycle_events WHERE record_id IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT 1").get(JSON.stringify(observation)) as
    | { action: string }
    | undefined;
  return last?.action === "retract";
}

/**
 * The target and its in-scope copies whose lifecycle passes `keep`: every record imported from
 * the same host event (host + event id, across transcripts and versions), which is also how
 * independent roots identify one observation. A record agents wrote directly is its own observation.
 */
function sameObservation(db: Db, workstreamId: string, target: RecordRow, keep: (lifecycle: Lifecycle) => boolean): { records: string[]; events: { host: string; eventId: string }[] } {
  return sameObservationIn(db, workstreamId, target, keep);
}

/** As {@link sameObservation}; a null scope (ledger replay of a workspace-level record) sees workspace-level copies. */
function sameObservationIn(db: Db, workstreamId: string | null, target: RecordRow, keep: (lifecycle: Lifecycle) => boolean): { records: string[]; events: { host: string; eventId: string }[] } {
  const event = prepared(db, "SELECT host, event_id FROM import_events WHERE record_id = ? LIMIT 1").get(target.id) as { host: string; event_id: string } | undefined;
  if (event === undefined) return { records: [target.id], events: [] };
  const copies = (
    prepared(
      db,
      `SELECT DISTINCT r.id, r.lifecycle FROM import_events e JOIN records r ON r.id = e.record_id
       WHERE e.host = $host AND e.event_id = $eventId AND ${IN_SCOPE_SQL} ORDER BY r.seq`,
    ).all({ host: event.host, eventId: event.event_id, workstreamId }) as { id: string; lifecycle: Lifecycle }[]
  )
    .filter((row) => row.id !== target.id && keep(row.lifecycle))
    .map((row) => row.id);
  return { records: [target.id, ...copies], events: [{ host: event.host, eventId: event.event_id }] };
}

function appendEvent(db: Db, entry: LedgerEntry, workstreamId: string | null, actor: Actor): number {
  const { lastInsertRowid } = prepared(
    db,
    `INSERT INTO lifecycle_events (ledger_id, record_id, workstream_id, action, replacement_id, reason, attribution, session_id, host, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.recordId, workstreamId, entry.action, entry.replacementId, actor.reason, entry.attribution, actor.sessionId === "" ? null : actor.sessionId, entry.host, entry.at);
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
  const state =
    target.lifecycle === "active" ? "active" : target.lifecycle === "retracted" && action === "restore" ? "retracted, but not by memory_manage (it cannot be restored)" : target.lifecycle;
  return new MemchorError(
    "lifecycle_conflict",
    `Record ${target.id} is ${state}, so it cannot be ${PAST[action] ?? action}${target.superseded_by === null ? "" : `; its replacement is ${target.superseded_by}`}. Inspect it with memory_manage.`,
    { details: { recordId: target.id, lifecycle: target.lifecycle, ...(target.superseded_by === null ? {} : { replacementId: target.superseded_by }) } },
  );
}

function excerpt(body: string): string {
  return body.length <= EXCERPT_CHARS ? body : `${body.slice(0, EXCERPT_CHARS - 1)}…`;
}
