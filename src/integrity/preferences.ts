import { randomUUID } from "node:crypto";
import { MemchorError } from "../errors.js";
import { eligibilityOf, type RecordRow, VISIBLE_SQL } from "../retrieval/eligibility.js";
import type { Attribution, PREFERENCE_ANSWERS } from "../schemas.js";
import { type Db, prepared, requireTransaction, writeTransaction } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";
import { changeClaim, type LiveActor } from "./lifecycle.js";
import { normalizeForEcho } from "./restatement.js";

/**
 * Preferences the user confirmed (PRD §5.6).
 *
 * ```text
 *   memory_record(kind: preference) ─▶ candidate (a question, never memory)
 *        Everywhere ─▶ active, global.sqlite          This repo only ─▶ active, workspace-level record
 *        No, just now ─▶ nothing (a marker in this process stops asking again this session)
 *        no answer ──▶ pending ─▶ asked once more at the next session start ─▶ dropped
 *   an agent-inferred change or removal of an active preference ─▶ candidate (proposal) ─▶ yes: applied / no: kept
 * ```
 *
 * A candidate becomes a preference only through an answer that came from the user: the host's
 * reply when Memchor asked them directly (MCP elicitation; the transport only carries it, this
 * module decides what it means), or, when the question could not be asked that way, the answer
 * the agent relays, recorded as `agent_reported`. While the user is being asked, or after they
 * dismissed the question, the agent cannot answer in their place (`relay` refused).
 *
 * Active preferences are ordinary `preference` records, so the lifecycle (supersede, retract,
 * restore, forget), eligibility and lineage apply to them as to any record. Global ones live in
 * `$MEMCHOR_HOME/global.sqlite`, a database with the workspace schema shared by every repository.
 * An answer is applied in one transaction when the preference and the candidate are in one
 * database (a repo preference, "no"); for a global preference the preference is written first
 * and the candidate deleted second, and after a crash in between the question comes back and its
 * answer finds the preference already active.
 */

export type PreferenceAnswer = (typeof PREFERENCE_ANSWERS)[number];
export type PreferenceScope = "global" | "repo";
export type CandidateKind = "new" | "change" | "remove";
export type ConfirmedBy = "user" | "agent_reported";

/**
 * What a host did with a question put to the user directly, as the transport saw it. This
 * module decides what each means: only `accept` carries the user's answer. A decline counts as
 * no answer, not as "no": headless hosts reply on their own (`codex exec` declines, `claude -p`
 * cancels), and the user's no is the "No, just now" answer.
 */
export type HostReply =
  | { action: "asking" }
  | { action: "accept"; label: string }
  | { action: "decline" }
  | { action: "cancel" }
  | { action: "timeout" }
  /** The question could not be shown (no elicitation support, or the request failed). */
  | { action: "unavailable" };

export interface PreferenceQuestion {
  /** Null when there is nothing to answer (already active, or declined this session). */
  candidateId: string | null;
  kind: CandidateKind;
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
  scope: PreferenceScope | null;
  /** The preference record now in force, if any. */
  recordId: string | null;
  confirmedBy: ConfirmedBy | null;
  /**
   * While pending: `allowed` when the user has not been asked directly (the agent should ask in
   * chat and relay their exact answer with memory_manage answer_preference); `refused` when they
   * are being asked, or were asked and dismissed it (do not ask again now; it comes back at the
   * next session start).
   */
  relay: "allowed" | "refused" | null;
}

export interface ActivePreference {
  recordId: string;
  scope: PreferenceScope;
  text: string;
  /** How the user's confirmation arrived; null for a preference recorded before confirmation existed. */
  confirmedBy: ConfirmedBy | null;
}

export interface PreferenceBlock {
  note: string;
  items: ActivePreference[];
  /** Active preferences left out to keep the block within {@link BLOCK_BYTES}; this repository's stay reachable through recall. */
  omitted: number;
  /** Unanswered questions from earlier sessions, asked once more now; dropped if unanswered again. */
  pending: PreferenceQuestion[];
}

/** Where preferences are read and written for one session. */
export interface PreferenceStores {
  repo: Db;
  /** Opens `global.sqlite` (created by the first session start that needs it). */
  global: () => Db;
  /** The workstream bound for reads (workspace-level records are in every scope). */
  workstreamId: string;
  actor: Omit<LiveActor, "attribution" | "reason">;
}

const BLOCK_BYTES = 4_096;
const NOTE =
  "The user's standing preferences (confirmedBy: how each was confirmed; null = recorded before confirmation existed): defaults for how to work. When the user asks for something different now, do that; a preference never overrides the current request.";
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
  kind: CandidateKind;
  body: string;
  target_id: string | null;
  target_scope: PreferenceScope | null;
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
    return pending ?? insertCandidate(stores, { kind: "new", body: text, target_id: null, target_scope: null, reason: null });
  });
  return questionFor(row, "");
}

/**
 * A change to an active preference that the agent concluded rather than the user asked for:
 * stored as a yes/no proposal, never applied (the same pending proposal is reused on a retry).
 * Null when the change applies directly: the user asked (`user_direction`), or the record is not
 * an active preference. An inferred restore of a removed preference is refused outright.
 */
export function inferredChange(
  stores: PreferenceStores,
  db: Db,
  scope: PreferenceScope,
  change: { action: "correct" | "supersede" | "retract" | "restore"; recordId: string; body: string | undefined; attribution: Attribution; reason: string },
): PreferenceQuestion | null {
  if (change.attribution === "user_direction") return null;
  const row = prepared(db, "SELECT * FROM records WHERE id = ?").get(change.recordId) as RecordRow | undefined;
  if (row?.kind !== "preference") return null;
  if (change.action === "restore") {
    throw new MemchorError("lifecycle_conflict", "Only the user can bring back a preference they removed: restore it only when they ask, with attribution user_direction.", {
      details: { recordId: row.id },
    });
  }
  if (!eligibilityOf(db, row).eligible) return null;
  const kind = change.action === "retract" ? "remove" : "change";
  const body = kind === "change" ? (change.body ?? "").trim() : "";
  const candidate = writeTransaction(stores.repo, () => {
    const same = prepared(stores.repo, "SELECT * FROM preference_candidates WHERE kind = ? AND target_id = ? AND body = ?").get(kind, row.id, body) as CandidateRow | undefined;
    return same ?? insertCandidate(stores, { kind, body, target_id: row.id, target_scope: scope, reason: change.reason });
  });
  return questionFor(candidate, row.body);
}

/**
 * Applies what happened to a question: the host's reply when the user was asked directly, or an
 * answer the agent relays (`relayed`, recorded as agent-reported, and refused while the user is
 * being asked or after they dismissed it). An answer writes or changes the preference, or
 * declines it; anything else leaves it pending.
 */
export function settleCandidate(stores: PreferenceStores, candidateId: string, reply: HostReply | { relayed: PreferenceAnswer }, declined: Set<string>): PreferenceQuestion {
  const row = prepared(stores.repo, "SELECT * FROM preference_candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  if (row === undefined) {
    throw new MemchorError("not_found", `No pending preference question ${candidateId}: it was answered, or dropped after going unanswered twice.`, { details: { candidateId } });
  }
  const target = targetOf(stores, row);
  const pending = questionFor(row, target?.row.body ?? "");
  let answer: PreferenceAnswer;
  let confirmedBy: ConfirmedBy;
  if ("relayed" in reply) {
    if (row.relay === "refused") {
      throw new MemchorError(
        "lifecycle_conflict",
        "The user is being asked this directly, or was asked and dismissed it, so an answer relayed by the agent does not count. It is asked again at the next session start.",
        { details: { candidateId, relay: "refused" } },
      );
    }
    answer = reply.relayed;
    confirmedBy = "agent_reported";
  } else {
    const chosen = reply.action === "accept" ? pending.choices.find((choice) => choice.label === reply.label) : undefined;
    if (chosen === undefined) {
      const relay = reply.action === "unavailable" ? "allowed" : "refused";
      writeTransaction(stores.repo, () => prepared(stores.repo, "UPDATE preference_candidates SET relay = ? WHERE id = ?").run(relay, row.id));
      return { ...pending, relay };
    }
    answer = chosen.value;
    confirmedBy = "user";
  }
  if (!pending.choices.some((choice) => choice.value === answer)) {
    throw new MemchorError("invalid_input", `"${answer}" is not an answer to this question; expected one of ${pending.choices.map((c) => c.value).join(", ")}.`, {
      details: { candidateId, answer },
    });
  }
  const done = { ...pending, candidateId: null, relay: null };
  const dropCandidate = (): void => void prepared(stores.repo, "DELETE FROM preference_candidates WHERE id = ?").run(row.id);

  if (answer === "no") {
    if (row.kind === "new") declined.add(normalizeForEcho(row.body));
    writeTransaction(stores.repo, dropCandidate);
    return { ...done, state: row.kind === "new" ? "declined" : "kept", scope: target?.scope ?? null, recordId: target?.row.id ?? null };
  }
  if (row.kind === "new") {
    const scope: PreferenceScope = answer === "everywhere" ? "global" : "repo";
    const recordId = applyIn(stores, scope, () => storePreference(stores, scope, row.body, confirmedBy), dropCandidate);
    return { ...done, state: "active", scope, recordId, confirmedBy };
  }
  if (target === null) {
    writeTransaction(stores.repo, dropCandidate);
    return { ...done, state: "applied", scope: null, recordId: null, confirmedBy };
  }
  const recordId = applyIn(stores, target.scope, () => applyProposal(stores, row, target, confirmedBy), dropCandidate);
  return { ...done, state: "applied", scope: target.scope, recordId, confirmedBy };
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
  return rows.map((row) => questionFor(row, targetOf(stores, row)?.row.body ?? ""));
}

/** Deletes the questions a session raised ("don't remember this session"). Call inside its transaction. */
export function dropSessionCandidates(db: Db, sessionId: string): number {
  requireTransaction(db, "dropSessionCandidates");
  return prepared(db, "DELETE FROM preference_candidates WHERE session_id = ?").run(sessionId).changes;
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

/** Which store holds a record, if either does. */
export function locatePreference(stores: PreferenceStores, recordId: string, globalExists: boolean): { db: Db; scope: PreferenceScope } | null {
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

function storeOf(stores: PreferenceStores, scope: PreferenceScope): Db {
  return scope === "global" ? stores.global() : stores.repo;
}

/**
 * Applies an answer in the store it belongs to and drops its candidate: one transaction when
 * both are in this repository's database, the preference first otherwise (see the header).
 */
function applyIn<T>(stores: PreferenceStores, scope: PreferenceScope, apply: () => T, dropCandidate: () => void): T {
  if (scope === "repo") {
    return writeTransaction(stores.repo, () => {
      const result = apply();
      dropCandidate();
      return result;
    });
  }
  const global = stores.global();
  const result = writeTransaction(global, () => {
    ensureGlobalSession(global, stores.actor);
    return apply();
  });
  writeTransaction(stores.repo, dropCandidate);
  return result;
}

function activePreferences(stores: PreferenceStores): ActivePreference[] {
  const query = `SELECT r.* FROM records r WHERE r.kind = 'preference' AND ${VISIBLE_SQL} ORDER BY r.created_at DESC, r.seq DESC`;
  const from = (scope: PreferenceScope): ActivePreference[] =>
    (prepared(storeOf(stores, scope), query).all({ workstreamId: stores.workstreamId }) as RecordRow[]).map((row) => ({
      recordId: row.id,
      scope,
      text: row.body,
      confirmedBy: (JSON.parse(row.applicability) as { confirmation?: ConfirmedBy }).confirmation ?? null,
    }));
  return [...from("repo"), ...from("global")];
}

function insertCandidate(stores: PreferenceStores, row: Omit<CandidateRow, "id" | "relay">): CandidateRow {
  const id = `pc_${randomUUID().replaceAll("-", "")}`;
  prepared(
    stores.repo,
    "INSERT INTO preference_candidates (id, kind, body, target_id, target_scope, reason, session_id, host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, row.kind, row.body, row.target_id, row.target_scope, row.reason, stores.actor.sessionId, stores.actor.host, new Date().toISOString());
  return { ...row, id, relay: "allowed" };
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

function targetOf(stores: PreferenceStores, row: CandidateRow): { row: RecordRow; scope: PreferenceScope } | null {
  if (row.target_id === null || row.target_scope === null) return null;
  const target = prepared(storeOf(stores, row.target_scope), "SELECT * FROM records WHERE id = ?").get(row.target_id) as RecordRow | undefined;
  return target === undefined ? null : { row: target, scope: row.target_scope };
}

/** Inside the target store's transaction: the confirmed preference, reusing one already active with the same text. */
function storePreference(stores: PreferenceStores, scope: PreferenceScope, body: string, confirmedBy: ConfirmedBy): string {
  const db = storeOf(stores, scope);
  const key = normalizeForEcho(body);
  const already = (prepared(db, `SELECT r.* FROM records r WHERE r.kind = 'preference' AND ${VISIBLE_SQL}`).all({ workstreamId: stores.workstreamId }) as RecordRow[]).find(
    (row) => normalizeForEcho(row.body) === key,
  );
  if (already !== undefined) return already.id;
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
}

/** Inside the target store's transaction: the confirmed change or removal, unless the preference changed since it was proposed. */
function applyProposal(stores: PreferenceStores, row: CandidateRow, target: { row: RecordRow; scope: PreferenceScope }, confirmedBy: ConfirmedBy): string | null {
  const db = storeOf(stores, target.scope);
  const current = prepared(db, "SELECT * FROM records WHERE id = ?").get(target.row.id) as RecordRow;
  if (!eligibilityOf(db, current).eligible) return null;
  const actor: LiveActor = { ...stores.actor, attribution: "user_direction", reason: `The user confirmed a proposed ${row.kind}${row.reason === null ? "" : `: ${row.reason}`}` };
  return changeClaim(db, { workstreamId: stores.workstreamId }, {
    action: row.kind === "change" ? "supersede" : "retract",
    recordId: current.id,
    ...(row.kind === "change" ? { body: row.body } : {}),
    applicability: { confirmation: confirmedBy },
    actor,
  }).replacementId;
}
