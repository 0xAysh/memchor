import { randomUUID } from "node:crypto";
import { MemchorError } from "../errors.js";
import { eligibilityOf, type RecordRow, VISIBLE_SQL } from "../retrieval/eligibility.js";
import { type Db, prepared, writeTransaction } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";
import { changeClaim, type LiveActor } from "./lifecycle.js";
import { normalizeForEcho } from "./restatement.js";

/**
 * Preferences the user confirmed (PRD §5.6).
 *
 * ```text
 *   memory_record(kind: preference) ─▶ candidate (a question, never memory)
 *        Everywhere ─▶ active, global.sqlite          This repo only ─▶ active, workspace-level record
 *        No ─────────▶ nothing (a marker in this process stops asking again this session)
 *        no answer ──▶ pending ─▶ asked once more at the next session start ─▶ dropped
 *   an agent-inferred change or removal of an active preference ─▶ candidate (proposal) ─▶ yes: applied / no: kept
 * ```
 *
 * A candidate becomes a preference only through an answer that came from the user: settled by
 * the transport after asking them directly (MCP elicitation), or, when the question could not be
 * asked that way, relayed by the agent and recorded as `agent_reported`. A candidate the user
 * was shown and dismissed cannot be answered by the agent (`relay` refused).
 *
 * Active preferences are ordinary `preference` records, so the lifecycle (supersede, retract,
 * restore, forget), eligibility and lineage apply to them as to any record. Global ones live in
 * `$MEMCHOR_HOME/global.sqlite`, a database with the workspace schema shared by every repository.
 * Applying an answer writes the preference first and deletes the candidate second (they may be
 * two databases); after a crash in between, the candidate is asked again and the answer finds
 * the preference already active.
 */

export type PreferenceAnswer = "everywhere" | "repo" | "no" | "yes";
export type Settlement = { answer: PreferenceAnswer } | "cancelled" | "unavailable";
export type ConfirmedBy = "user" | "agent_reported";

export interface PreferenceQuestion {
  /** Null when there is nothing to answer (already active, or declined this session). */
  candidateId: string | null;
  kind: "new" | "change" | "remove";
  /** The proposed preference (new, change) or the one to remove. */
  text: string;
  /** The preference a change or removal is about. */
  targetId: string | null;
  question: string;
  choices: { value: PreferenceAnswer; label: string }[];
  /**
   * pending: waiting for the user · active: stored (new) · declined: the user said no, nothing
   * stored · applied / kept: a proposed change or removal was accepted / refused · dropped: never answered.
   */
  state: "pending" | "active" | "declined" | "applied" | "kept" | "dropped";
  scope: "global" | "repo" | null;
  /** The preference record now in force, if any. */
  recordId: string | null;
  confirmedBy: ConfirmedBy | null;
  /**
   * While pending: `allowed` when the user has not been asked directly (the agent should ask in
   * chat and relay their exact answer with memory_manage answer_preference); `refused` when they
   * were asked and dismissed it (do not ask again now; it comes back at the next session start).
   */
  relay: "allowed" | "refused" | null;
}

export interface ActivePreference {
  recordId: string;
  scope: "global" | "repo";
  text: string;
  /** Null for a preference recorded before confirmation existed. */
  confirmedBy: ConfirmedBy | null;
}

export interface PreferenceBlock {
  note: string;
  items: ActivePreference[];
  /** Active preferences left out to keep the block within {@link BLOCK_BYTES}. */
  omitted: number;
  /** Unanswered questions from earlier sessions, asked once more now; dropped if unanswered again. */
  pending: PreferenceQuestion[];
}

/** Where preferences are read and written for one session. */
export interface PreferenceStores {
  repo: Db;
  /** Opens `global.sqlite` on first use. */
  global: () => Db;
  /** The workstream bound for reads (workspace-level records are in every scope). */
  workstreamId: string;
  actor: Omit<LiveActor, "attribution" | "reason">;
}

const BLOCK_BYTES = 4_096;
const NOTE =
  "The user's confirmed preferences: defaults for how to work. When the user asks for something different now, do that; a stated preference never overrides the current request.";
const NEW_CHOICES: PreferenceQuestion["choices"] = [
  { value: "everywhere", label: "Everywhere" },
  { value: "repo", label: "This repo only" },
  { value: "no", label: "No, just now" },
];
const YES_NO: PreferenceQuestion["choices"] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

interface CandidateRow {
  id: string;
  kind: "new" | "change" | "remove";
  body: string;
  target_id: string | null;
  target_scope: "global" | "repo" | null;
  reason: string | null;
  relay: "allowed" | "refused";
}

/** The candidate for a proposed preference, or why none is needed. `declined` holds this session's "no"s. */
export function proposePreference(stores: PreferenceStores, body: string, declined: ReadonlySet<string>): PreferenceQuestion {
  const text = body.trim();
  const key = normalizeForEcho(text);
  const base = { kind: "new" as const, text, targetId: null, question: `Save "${text}" as a preference?`, choices: NEW_CHOICES };
  if (declined.has(key)) return { ...base, candidateId: null, state: "declined", scope: null, recordId: null, confirmedBy: null, relay: null };
  const existing = activePreferences(stores).find((preference) => normalizeForEcho(preference.text) === key);
  if (existing !== undefined) return { ...base, candidateId: null, state: "active", scope: existing.scope, recordId: existing.recordId, confirmedBy: existing.confirmedBy, relay: null };
  const row = writeTransaction(stores.repo, () => {
    const pending = (prepared(stores.repo, "SELECT * FROM preference_candidates WHERE kind = 'new'").all() as CandidateRow[]).find((candidate) => normalizeForEcho(candidate.body) === key);
    if (pending !== undefined) return pending;
    const created = { kind: "new" as const, body: text, target_id: null, target_scope: null, reason: null };
    return { ...created, id: insertCandidate(stores, created), relay: "allowed" as const };
  });
  return questionFor(row, "");
}

/** An agent-inferred change or removal of an active preference: stored as a proposal, never applied. */
export function proposeChange(stores: PreferenceStores, target: { row: RecordRow; scope: "global" | "repo" }, change: { kind: "change" | "remove"; body: string; reason: string }): PreferenceQuestion {
  const candidateId = writeTransaction(stores.repo, () =>
    insertCandidate(stores, { kind: change.kind, body: change.kind === "change" ? change.body.trim() : "", target_id: target.row.id, target_scope: target.scope, reason: change.reason }),
  );
  return questionFor({ id: candidateId, kind: change.kind, body: change.body.trim(), target_id: target.row.id, target_scope: target.scope, reason: change.reason, relay: "allowed" }, target.row.body);
}

/**
 * Applies what happened to a question. An answer from the user (or relayed by the agent, which
 * `confirmedBy` records) writes or changes the preference, or declines it; `cancelled` (the user
 * dismissed it, or it timed out) keeps it pending and stops the agent from answering in the
 * user's place; `unavailable` (the question could not be shown) keeps it pending for the agent to relay.
 */
export function settleCandidate(stores: PreferenceStores, candidateId: string, settlement: Settlement, confirmedBy: ConfirmedBy, declined: Set<string>): PreferenceQuestion {
  const row = prepared(stores.repo, "SELECT * FROM preference_candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  if (row === undefined) {
    throw new MemchorError("not_found", `No pending preference question ${candidateId}: it was answered, or dropped after going unanswered twice.`, { details: { candidateId } });
  }
  const target = row.target_id === null ? null : targetOf(stores, row);
  const pending = questionFor(row, target?.row.body ?? "");
  if (settlement === "cancelled" || settlement === "unavailable") {
    const relay = settlement === "cancelled" ? "refused" : "allowed";
    writeTransaction(stores.repo, () => prepared(stores.repo, "UPDATE preference_candidates SET relay = ? WHERE id = ?").run(relay, row.id));
    return { ...pending, relay };
  }
  if (confirmedBy === "agent_reported" && row.relay === "refused") {
    throw new MemchorError(
      "lifecycle_conflict",
      "The user was asked this directly and dismissed it, so an answer relayed by the agent does not count. It will be asked again at the next session start.",
      { details: { candidateId, relay: "refused" } },
    );
  }
  const { answer } = settlement;
  if (!pending.choices.some((choice) => choice.value === answer)) {
    throw new MemchorError("invalid_input", `"${answer}" is not an answer to this question; expected one of ${pending.choices.map((c) => c.value).join(", ")}.`, {
      details: { candidateId, answer },
    });
  }
  let outcome: PreferenceQuestion;
  if (answer === "no") {
    if (row.kind === "new") declined.add(normalizeForEcho(row.body));
    outcome = { ...pending, candidateId: null, state: row.kind === "new" ? "declined" : "kept", scope: target?.scope ?? null, recordId: target?.row.id ?? null, relay: null };
  } else if (row.kind === "new") {
    const scope = answer === "everywhere" ? "global" : "repo";
    outcome = { ...pending, candidateId: null, state: "active", scope, recordId: storePreference(stores, scope, row.body, confirmedBy), confirmedBy, relay: null };
  } else {
    outcome = { ...pending, candidateId: null, state: "applied", scope: target?.scope ?? null, recordId: applyProposal(stores, row, confirmedBy), confirmedBy, relay: null };
  }
  writeTransaction(stores.repo, () => prepared(stores.repo, "DELETE FROM preference_candidates WHERE id = ?").run(row.id));
  return outcome;
}

/**
 * At a session start: drops questions already asked once more by an earlier session, and puts
 * the other unanswered questions from earlier sessions to this one (once).
 */
export function reaskAtSessionStart(stores: PreferenceStores): PreferenceQuestion[] {
  const sessionId = stores.actor.sessionId;
  const rows = writeTransaction(stores.repo, () => {
    prepared(stores.repo, "DELETE FROM preference_candidates WHERE session_id <> $s AND reasked_session IS NOT NULL AND reasked_session <> $s").run({ s: sessionId });
    prepared(stores.repo, "UPDATE preference_candidates SET reasked_session = $s, relay = 'allowed' WHERE session_id <> $s AND reasked_session IS NULL").run({ s: sessionId });
    return prepared(stores.repo, "SELECT * FROM preference_candidates WHERE reasked_session = ? ORDER BY created_at, id").all(sessionId) as CandidateRow[];
  });
  return rows.map((row) => questionFor(row, row.target_id === null ? "" : (targetOf(stores, row)?.row.body ?? "")));
}

/** Active preferences, this repository's first, each newest first, capped at {@link BLOCK_BYTES}. */
export function preferenceBlock(stores: PreferenceStores, pending: PreferenceQuestion[]): PreferenceBlock {
  const all = activePreferences(stores);
  const items: ActivePreference[] = [];
  let bytes = 2; // the JSON array's brackets
  for (const preference of all) {
    const size = Buffer.byteLength(JSON.stringify(preference), "utf8") + (items.length === 0 ? 0 : 1);
    if (bytes + size > BLOCK_BYTES) break;
    items.push(preference);
    bytes += size;
  }
  return { note: NOTE, items, omitted: all.length - items.length, pending };
}

/** Which store holds a preference record, if either does. */
export function locatePreference(stores: PreferenceStores, recordId: string, globalExists: boolean): { db: Db; scope: "global" | "repo" } | null {
  if (prepared(stores.repo, "SELECT 1 FROM records WHERE id = ?").get(recordId) !== undefined) return { db: stores.repo, scope: "repo" };
  if (!globalExists) return null;
  const global = stores.global();
  return prepared(global, "SELECT 1 FROM records WHERE id = ?").get(recordId) === undefined ? null : { db: global, scope: "global" };
}

/** Makes this session known to the global store before it writes there (records cite their session). */
export function ensureGlobalSession(global: Db, actor: PreferenceStores["actor"]): void {
  prepared(global, "INSERT OR IGNORE INTO sessions (id, host, workstream_id, started_at) VALUES (?, ?, NULL, ?)").run(actor.sessionId, actor.host, new Date().toISOString());
}

// ── internals ──

function activePreferences(stores: PreferenceStores): ActivePreference[] {
  const query = `SELECT r.* FROM records r WHERE r.kind = 'preference' AND ${VISIBLE_SQL} ORDER BY r.created_at DESC, r.seq DESC`;
  const from = (db: Db, scope: "global" | "repo"): ActivePreference[] =>
    (prepared(db, query).all({ workstreamId: stores.workstreamId }) as RecordRow[]).map((row) => ({
      recordId: row.id,
      scope,
      text: row.body,
      confirmedBy: (JSON.parse(row.applicability) as { confirmation?: ConfirmedBy }).confirmation ?? null,
    }));
  return [...from(stores.repo, "repo"), ...from(stores.global(), "global")];
}

function insertCandidate(stores: PreferenceStores, row: Omit<CandidateRow, "id" | "relay">): string {
  const id = `pc_${randomUUID().replaceAll("-", "")}`;
  prepared(
    stores.repo,
    "INSERT INTO preference_candidates (id, kind, body, target_id, target_scope, reason, session_id, host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, row.kind, row.body, row.target_id, row.target_scope, row.reason, stores.actor.sessionId, stores.actor.host, new Date().toISOString());
  return id;
}

function questionFor(row: CandidateRow, targetText: string): PreferenceQuestion {
  const base = { candidateId: row.id, targetId: row.target_id, state: "pending" as const, scope: null, recordId: null, confirmedBy: null, relay: row.relay };
  switch (row.kind) {
    case "new":
      return { ...base, kind: "new", text: row.body, question: `Save "${row.body}" as a preference?`, choices: NEW_CHOICES };
    case "change":
      return { ...base, kind: "change", text: row.body, question: `Change your preference "${targetText}" to "${row.body}"?`, choices: YES_NO };
    case "remove":
      return { ...base, kind: "remove", text: targetText, question: `Remove your preference "${targetText}"?`, choices: YES_NO };
  }
}

function targetOf(stores: PreferenceStores, row: CandidateRow): { row: RecordRow; scope: "global" | "repo" } | null {
  if (row.target_id === null || row.target_scope === null) return null;
  const db = row.target_scope === "global" ? stores.global() : stores.repo;
  const target = prepared(db, "SELECT * FROM records WHERE id = ?").get(row.target_id) as RecordRow | undefined;
  return target === undefined ? null : { row: target, scope: row.target_scope };
}

function storePreference(stores: PreferenceStores, scope: "global" | "repo", body: string, confirmedBy: ConfirmedBy): string {
  const db = scope === "global" ? stores.global() : stores.repo;
  const key = normalizeForEcho(body);
  return writeTransaction(db, () => {
    const already = (prepared(db, `SELECT r.* FROM records r WHERE r.kind = 'preference' AND ${VISIBLE_SQL}`).all({ workstreamId: stores.workstreamId }) as RecordRow[]).find(
      (row) => normalizeForEcho(row.body) === key,
    );
    if (already !== undefined) return already.id;
    if (scope === "global") ensureGlobalSession(db, stores.actor);
    return appendRecord(db, stores.workstreamId, {
      kind: "preference",
      title: null,
      body,
      workstreamId: null,
      sessionId: stores.actor.sessionId,
      host: stores.actor.host,
      attribution: "user_direction",
      reviewState: "accepted",
      applicability: { confirmation: confirmedBy },
      externalRefs: [],
      links: [],
    }).recordId;
  });
}

function applyProposal(stores: PreferenceStores, row: CandidateRow, confirmedBy: ConfirmedBy): string | null {
  const target = targetOf(stores, row);
  // Already changed or gone since it was proposed: nothing left to apply.
  if (target === null || !eligibilityOf(target.scope === "global" ? stores.global() : stores.repo, target.row).eligible) return null;
  const db = target.scope === "global" ? stores.global() : stores.repo;
  const actor: LiveActor = { ...stores.actor, attribution: "user_direction", reason: `The user confirmed a proposed ${row.kind}${row.reason === null ? "" : `: ${row.reason}`}` };
  return writeTransaction(db, () => {
    if (target.scope === "global") ensureGlobalSession(db, stores.actor);
    const changed = changeClaim(db, { workstreamId: stores.workstreamId }, {
      action: row.kind === "change" ? "supersede" : "retract",
      recordId: target.row.id,
      ...(row.kind === "change" ? { body: row.body } : {}),
      applicability: { confirmation: confirmedBy },
      actor,
    });
    return changed.replacementId;
  });
}
