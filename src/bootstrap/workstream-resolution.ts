import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { MemchorError } from "../errors.js";
import { summarizeCheckpoint, type CheckpointSummary } from "../integrity/checkpoints.js";
import { type Db, prepared, requireTransaction, writeTransaction } from "../storage/database.js";
import { mainWorktreeOf, type WorkspaceLocation } from "./workspace-resolution.js";

/**
 * Workstream resolution: which workstream a session (live, or an imported transcript)
 * continues. One deep operation, {@link resolveWorkstream}, used by live bootstrap and by
 * the transcript importer alike, so every host resolves by the same rules (PRD §9.2):
 *
 * | # | Signal | Weight | Why |
 * |---|---|---|---|
 * | – | Explicit choice (`workstream: <id> \| "new"`) | Decides | The user answered the question; it also rebinds the worktree |
 * | 1 | Session metadata: this host session id already bound, or Memchor output in an imported transcript naming its workstream | Authoritative | Memchor itself bound that very session; nothing is closer evidence |
 * | 2 | Existing binding of this Git worktree | Authoritative | The worktree is where the work physically happens; bindings survive branch switches |
 * | 3 | Explicit task identity (`task` hint → task key) | Strong | The user named the task; a workstream with that key is the same task. A *different* task than the bound workstream's is a conflict, never overridden silently |
 * | 4 | Strong match to one active workstream | – | V1 knows no strong signal beyond 1–3; branch similarity is not one |
 * | 5 | Branch | Suggestion only | Branches are renamed, reused, and shared by unrelated work; it labels new workstreams and lists orphaned ones as candidates, never binds |
 * | 6 | Conversational choice | – | More than one credible candidate, conflicting signals, or branch-only evidence: return the candidates and bind nothing |
 *
 * One confident candidate binds automatically; with none, a worktree gets a new workstream
 * labelled with its branch. Ambiguity is a normal result, not an error.
 */

/** How a bound session's workstream was chosen. */
export type ResolutionBasis = "choice" | "session_binding" | "worktree_binding" | "task" | "new_workstream";

/** Evidence that made a workstream a candidate. */
export type CandidateSignal = "session_binding" | "worktree_binding" | "task" | "branch";

export interface WorkstreamCandidate {
  workstreamId: string;
  label: string;
  /** The branch its worktree was last seen on (evidence, not identity). */
  branch: string | null;
  taskKey: string | null;
  headRevision: number;
  /** Goal, status and first next step of its head checkpoint, bounded; null before its first checkpoint. */
  lastCheckpoint: CheckpointSummary | null;
  lastActiveAt: string;
  reasons: { signal: CandidateSignal; detail: string }[];
}

export interface ScopeAmbiguity {
  /** What to put to the user, verbatim: the candidates, the "new" option, and how to answer. */
  question: string;
  candidates: WorkstreamCandidate[];
  /** Credible candidates left out (only the most recently active are listed). */
  omittedCandidates: number;
}

export interface ResolvedWorkstream {
  id: string;
  label: string;
  /** Normalised explicit task identity (e.g. "#20", "PROJ-7"), if the workstream has one. */
  taskKey: string | null;
}

export type Resolution =
  | { status: "bound"; workstream: ResolvedWorkstream; basis: ResolutionBasis; created: boolean }
  | { status: "ambiguous"; ambiguity: ScopeAmbiguity };

/** Everything known about the session that needs a workstream. Only trusted or validated values. */
export interface ScopeSignals {
  /** realpath of the Git worktree the session runs in (a live cwd, or a transcript's first event). */
  worktree: string;
  /** The worktree's current branch: a label and a suggestion, never scope on its own. */
  branch: string;
  /** Step 1 (live and imported): the host's own session id; `sessionId` is the session being resolved, never evidence for itself. */
  session?: { host: string; hostSessionId: string | null; sessionId?: string };
  /** Step 1 (imported): workstreams that Memchor output inside the transcript reported as bound. */
  namedWorkstreams?: readonly string[];
  /** Step 3: the task identity the user gave (raw; normalised here). */
  task?: string;
  /** The user's answer to an ambiguity: an existing workstream id, or "new". */
  choice?: string;
}

/** What eligibility filters on while no workstream is bound: no workstream has this id, so only workspace-level records match. */
export const NO_WORKSTREAM = "";

const MAX_CANDIDATES = 5;

interface WorkstreamRow {
  id: string;
  label: string;
  task_key: string | null;
  branch: string | null;
  head_revision: number;
  created_at: string;
}

/**
 * Decides and applies the workstream for one session, inside the caller's write transaction.
 * A bound result has already created the workstream and worktree binding it needs (or rebound
 * the worktree, for an explicit choice); an ambiguous result wrote nothing. An explicit
 * `choice` naming no workstream of this workspace is `not_found`: the database is the
 * workspace, so a foreign id can never widen scope.
 */
export function resolveWorkstream(db: Db, signals: ScopeSignals, now: string): Resolution {
  requireTransaction(db, "resolveWorkstream");
  const taskKey = signals.task === undefined ? null : normalizeTaskKey(signals.task);

  if (signals.choice !== undefined) {
    if (signals.choice === "new") return settle(db, signals, createWorkstream(db, signals.branch, taskKey, now), taskKey, "choice", true, now);
    const chosen = workstreamRow(db, signals.choice);
    if (chosen === null) {
      throw new MemchorError("not_found", `No workstream ${signals.choice} exists in this workspace. Choose one of scope.ambiguity.candidates, or "new".`, {
        details: { workstreamId: signals.choice },
      });
    }
    return settle(db, signals, chosen, taskKey, "choice", false, now);
  }

  const sessionBound = sessionBindings(db, signals);
  const worktreeBound = boundTo(db, signals.worktree);
  if (sessionBound.length > 1) {
    return ambiguous(db, [
      ...sessionBound.map((row) => ({ row, signal: "session_binding" as const, detail: "Memchor bound this session to it" })),
      ...(worktreeBound === null ? [] : [{ row: worktreeBound, signal: "worktree_binding" as const, detail: "this worktree is bound to it" }]),
    ]);
  }

  const tasked = taskKey === null ? [] : (prepared(db, `SELECT ${COLUMNS} FROM workstreams WHERE task_key = ? AND lifecycle = 'active'`).all(taskKey) as WorkstreamRow[]);
  const anchor = sessionBound[0] ?? worktreeBound;
  if (anchor !== null) {
    const basis: ResolutionBasis = sessionBound[0] === undefined ? "worktree_binding" : "session_binding";
    // A binding outranks everything below it, unless the user named a *different* task than
    // the bound workstream's own: that is a conflict to ask about, not something to override.
    const agrees = taskKey === null || (anchor.task_key === null ? tasked.every((row) => row.id === anchor.id) : anchor.task_key === taskKey);
    if (agrees) return settle(db, signals, anchor, taskKey, basis, false, now);
    return ambiguous(db, [
      { row: anchor, signal: basis, detail: `${basis === "session_binding" ? "Memchor bound this session" : "this worktree is bound"} to it (task ${anchor.task_key ?? "not set"}, not ${taskKey})` },
      ...tasked.map((row) => ({ row, signal: "task" as const, detail: `its task is ${taskKey}` })),
    ]);
  }

  if (tasked.length === 1 && tasked[0] !== undefined) return settle(db, signals, tasked[0], taskKey, "task", false, now);
  if (tasked.length > 1) return ambiguous(db, tasked.map((row) => ({ row, signal: "task" as const, detail: `its task is ${taskKey ?? ""}` })));

  const suggested = orphansOnBranch(db, signals.branch, taskKey);
  if (suggested.length > 0) {
    return ambiguous(
      db,
      suggested.map((row) => ({ row, signal: "branch" as const, detail: `it was last on branch ${signals.branch} and its worktree no longer exists` })),
    );
  }
  return settle(db, signals, createWorkstream(db, signals.branch, taskKey, now), taskKey, "new_workstream", true, now);
}

/**
 * Applies a decision: adopts the task key if the workstream has none, binds the worktree when
 * it is unbound (or rebinds it for an explicit choice), and records the branch it is on.
 * A session binding never rebinds another workstream's worktree.
 */
function settle(db: Db, signals: ScopeSignals, row: WorkstreamRow, taskKey: string | null, basis: ResolutionBasis, created: boolean, now: string): Resolution {
  if (taskKey !== null && row.task_key === null) {
    prepared(db, "UPDATE workstreams SET task_key = ? WHERE id = ?").run(taskKey, row.id);
    row = { ...row, task_key: taskKey };
  }
  const current = boundTo(db, signals.worktree);
  if (current === null || (basis === "choice" && current.id !== row.id)) {
    prepared(
      db,
      `INSERT INTO worktree_bindings (worktree_path, workstream_id, bound_at) VALUES (?, ?, ?)
       ON CONFLICT (worktree_path) DO UPDATE SET workstream_id = excluded.workstream_id, bound_at = excluded.bound_at`,
    ).run(signals.worktree, row.id, now);
  }
  if ((current === null || current.id === row.id || basis === "choice") && isBranch(signals.branch)) {
    prepared(db, "UPDATE workstreams SET branch = ? WHERE id = ?").run(signals.branch, row.id);
  }
  return { status: "bound", workstream: { id: row.id, label: row.label, taskKey: row.task_key }, basis, created };
}

function createWorkstream(db: Db, branch: string, taskKey: string | null, now: string): WorkstreamRow {
  const row: WorkstreamRow = { id: `wst_${randomUUID().replaceAll("-", "")}`, label: branch, task_key: taskKey, branch: isBranch(branch) ? branch : null, head_revision: 0, created_at: now };
  prepared(db, "INSERT INTO workstreams (id, label, task_key, branch, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.label, row.task_key, row.branch, now);
  return row;
}

const COLUMNS = "id, label, task_key, branch, head_revision, created_at";

function workstreamRow(db: Db, id: string): WorkstreamRow | null {
  return (prepared(db, `SELECT ${COLUMNS} FROM workstreams WHERE id = ?`).get(id) as WorkstreamRow | undefined) ?? null;
}

function boundTo(db: Db, worktree: string): WorkstreamRow | null {
  const row = prepared(db, `SELECT w.id, w.label, w.task_key, w.branch, w.head_revision, w.created_at FROM worktree_bindings b JOIN workstreams w ON w.id = b.workstream_id WHERE b.worktree_path = ?`).get(worktree);
  return (row as WorkstreamRow | undefined) ?? null;
}

/**
 * Step 1. Only workstreams in this database count, so an id copied from another workspace's
 * output is ignored rather than trusted. Workspace-level (unbound) sessions are no evidence.
 */
function sessionBindings(db: Db, signals: ScopeSignals): WorkstreamRow[] {
  const ids = new Set<string>();
  const session = signals.session;
  if (session !== undefined && session.hostSessionId !== null) {
    const rows = prepared(db, "SELECT DISTINCT workstream_id AS id FROM sessions WHERE host = ? AND host_session_id = ? AND workstream_id IS NOT NULL AND id <> ?")
      .all(session.host, session.hostSessionId, session.sessionId ?? "") as { id: string }[];
    for (const row of rows) ids.add(row.id);
  }
  for (const id of signals.namedWorkstreams ?? []) ids.add(id);
  if (ids.size === 0) return [];
  return prepared(db, `SELECT ${COLUMNS} FROM workstreams WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify([...ids])) as WorkstreamRow[];
}

/**
 * Step 5 candidates: active workstreams last seen on this branch whose every bound worktree is
 * gone (removed or moved away). A workstream still bound to a live worktree belongs to that
 * worktree and is never offered to another. With a task hint, workstreams of another task are
 * no candidates. A detached HEAD is no branch evidence at all.
 */
function orphansOnBranch(db: Db, branch: string, taskKey: string | null): WorkstreamRow[] {
  if (!isBranch(branch)) return [];
  const rows = prepared(db, `SELECT ${COLUMNS} FROM workstreams WHERE lifecycle = 'active' AND coalesce(branch, label) = ? AND (? IS NULL OR task_key IS NULL)`).all(branch, taskKey) as WorkstreamRow[];
  const worktrees = prepared(db, "SELECT worktree_path FROM worktree_bindings WHERE workstream_id = ?");
  return rows.filter((row) => !(worktrees.all(row.id) as { worktree_path: string }[]).some((binding) => existsSync(binding.worktree_path)));
}

function isBranch(branch: string): boolean {
  return branch !== "detached" && !branch.startsWith("detached@");
}

function ambiguous(db: Db, evidence: { row: WorkstreamRow; signal: CandidateSignal; detail: string }[]): Resolution {
  const byId = new Map<string, WorkstreamCandidate>();
  const head = prepared(
    db,
    `SELECT r.body FROM checkpoints c JOIN records r ON r.id = c.record_id WHERE c.workstream_id = ? AND c.revision = ? AND r.review_state <> 'retracted'`,
  );
  const lastActive = prepared(db, "SELECT max(t) AS t FROM (SELECT max(created_at) AS t FROM records WHERE workstream_id = ? UNION ALL SELECT max(started_at) FROM sessions WHERE workstream_id = ?)");
  for (const { row, signal, detail } of evidence) {
    let candidate = byId.get(row.id);
    if (candidate === undefined) {
      const body = (head.get(row.id, row.head_revision) as { body: string } | undefined)?.body;
      candidate = {
        workstreamId: row.id,
        label: row.label,
        branch: row.branch,
        taskKey: row.task_key,
        headRevision: row.head_revision,
        lastCheckpoint: body === undefined ? null : summarizeCheckpoint(body),
        lastActiveAt: (lastActive.get(row.id, row.id) as { t: string | null }).t ?? row.created_at,
        reasons: [],
      };
      byId.set(row.id, candidate);
    }
    candidate.reasons.push({ signal, detail });
  }
  const all = [...byId.values()].sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  const candidates = all.slice(0, MAX_CANDIDATES);
  return { status: "ambiguous", ambiguity: { question: question(candidates, all.length - candidates.length), candidates, omittedCandidates: all.length - candidates.length } };
}

function question(candidates: readonly WorkstreamCandidate[], omitted: number): string {
  const lines = candidates.map((c, i) => {
    const task = c.taskKey === null ? "" : ` [task ${c.taskKey}]`;
    const state = c.lastCheckpoint === null ? "no checkpoint yet" : `r${c.headRevision}: ${c.lastCheckpoint.goal} (${c.lastCheckpoint.status})`;
    return `${i + 1}. ${c.label}${task} (${c.workstreamId}): ${state}; last active ${c.lastActiveAt}. Why: ${c.reasons.map((r) => r.detail).join("; ")}.`;
  });
  return [
    "Memchor could not tell which workstream this session continues, and does not guess:",
    ...lines,
    ...(omitted > 0 ? [`(${omitted} less recently active candidate${omitted === 1 ? "" : "s"} not listed.)`] : []),
    `${candidates.length + 1}. Start a new workstream for this worktree.`,
    "",
    'Ask the user which one, then call memory_bootstrap with workstream set to the chosen workstreamId, or "new". Until then only workspace-level memory is shown and workstream writes are refused.',
  ].join("\n");
}

/**
 * Normalises an explicit task identity so the same task given in different forms matches:
 * "#20", "20", "issue 20", "PR #20" → "#20"; a GitHub/GitLab issue or PR URL →
 * "host/owner/repo#20" (it names its repository, so it never collides with another
 * repository's #20); a tracker key "proj-7" → "PROJ-7"; any other URL → host + path; anything
 * else → lowercased, whitespace collapsed.
 */
export function normalizeTaskKey(raw: string): string {
  const text = raw.trim();
  const url = URL.canParse(text) && /^https?:\/\//i.test(text) ? new URL(text) : null;
  if (url !== null) {
    const host = url.host.toLowerCase();
    const numbered = /^\/(.+?)\/(?:-\/)?(?:issues|pull|pulls|merge_requests)\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (numbered !== null) return `${host}/${(numbered[1] ?? "").toLowerCase()}#${Number(numbered[2])}`;
    return `${host}${url.pathname.replace(/\/+$/, "")}`.slice(0, 200);
  }
  const numbered = /^(?:(?:issue|pull request|pull|pr)\s*)?#?\s*(\d+)$/i.exec(text);
  if (numbered !== null) return `#${Number(numbered[1])}`;
  const tracker = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(text);
  if (tracker !== null) return `${(tracker[1] ?? "").toUpperCase()}-${Number(tracker[2])}`;
  return text.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

// ───────────────────────────── Live sessions ─────────────────────────────

export interface BoundScope {
  workspaceId: string;
  workspaceLabel: string;
  /** The session's workstream; null while the scope is ambiguous (the session is workspace-level). */
  workstream: ResolvedWorkstream | null;
  /** The eligibility key: the workstream's id, or {@link NO_WORKSTREAM} while ambiguous. */
  workstreamId: string;
  resolvedBy: ResolutionBasis | null;
  ambiguity: ScopeAmbiguity | null;
  branch: string;
  worktree: string;
  sessionId: string;
  host: string;
  /** Per-workspace key that authenticates recall continuation tokens. */
  continuationSecret: Buffer;
  createdWorkstream: boolean;
}

export interface SessionIdentity {
  host: string;
  hostSessionId: string | undefined;
  /** An existing session of this process to re-resolve (after a choice or task hint) instead of opening a new one. */
  sessionId?: string;
}

export interface ScopeHints {
  task?: string | undefined;
  /** An explicit choice: a workstream id of this workspace, or "new". */
  workstream?: string | undefined;
}

/**
 * Resolves the live session's workstream ({@link resolveWorkstream}) and opens (or re-binds)
 * its session, in one IMMEDIATE transaction, so two processes bootstrapping the same new
 * worktree concurrently produce one workstream and one binding, not two. An ambiguous
 * session is recorded with no workstream.
 *
 * Fails closed with `storage_unavailable` when the database belongs to a different
 * workspace or repository identity; nothing is written in that case.
 */
export function bindScope(db: Db, location: WorkspaceLocation, session: SessionIdentity, hints: ScopeHints = {}): BoundScope {
  return writeTransaction(db, () => {
    const now = new Date().toISOString();
    const workspace = ensureWorkspace(db, location, now);
    const resolution = resolveWorkstream(
      db,
      {
        worktree: location.worktree,
        branch: location.branch,
        session: { host: session.host, hostSessionId: session.hostSessionId ?? null, ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }) },
        ...(hints.task === undefined ? {} : { task: hints.task }),
        ...(hints.workstream === undefined ? {} : { choice: hints.workstream }),
      },
      now,
    );
    const workstream = resolution.status === "bound" ? resolution.workstream : null;
    const sessionId = session.sessionId ?? `ses_${randomUUID().replaceAll("-", "")}`;
    if (session.sessionId === undefined) {
      db.prepare("INSERT INTO sessions (id, host, host_session_id, workstream_id, started_at) VALUES (?, ?, ?, ?, ?)").run(
        sessionId,
        session.host,
        session.hostSessionId ?? null,
        workstream?.id ?? null,
        now,
      );
    } else {
      db.prepare("UPDATE sessions SET workstream_id = ? WHERE id = ?").run(workstream?.id ?? null, sessionId);
    }
    return {
      workspaceId: location.workspaceId,
      workspaceLabel: workspace.label,
      workstream,
      workstreamId: workstream?.id ?? NO_WORKSTREAM,
      resolvedBy: resolution.status === "bound" ? resolution.basis : null,
      ambiguity: resolution.status === "ambiguous" ? resolution.ambiguity : null,
      branch: location.branch,
      worktree: location.worktree,
      sessionId,
      host: session.host,
      continuationSecret: workspace.continuationSecret,
      createdWorkstream: resolution.status === "bound" && resolution.created,
    };
  });
}

/** The bound workstream id for a workstream-scoped write; `scope_ambiguous` while the session has none. */
export function requireWorkstream(scope: BoundScope, operation: string): string {
  if (scope.workstream !== null) return scope.workstream.id;
  throw new MemchorError(
    "scope_ambiguous",
    `${operation} needs a workstream, and this session has none yet: more than one could continue here (scope.ambiguity). Ask the user which one, then call memory_bootstrap with workstream set to its id or "new". Records meant for the whole repository can still be written with workspaceLevel: true.`,
    { details: { operation, candidates: scope.ambiguity?.candidates.map((c) => c.workstreamId) ?? [] } },
  );
}

// ───────────────────────────── Workspace row ─────────────────────────────

/**
 * The database's one `workspaces` row, created on first use. When the repository moved
 * (its old key is one of `location.formerRepositoryKeys`), the row and the worktree bindings
 * that lived under the old main worktree are re-pointed to the new location in this
 * transaction, so each moved worktree keeps its workstream. Linked worktrees outside the
 * repository directory did not move and keep their paths. Otherwise fails closed with
 * `storage_unavailable` when the file belongs to a different workspace or repository.
 * Call inside a write transaction.
 */
export function ensureWorkspace(db: Db, location: WorkspaceLocation, now: string): { label: string; continuationSecret: Buffer } {
  requireTransaction(db, "ensureWorkspace");
  const workspaces = db.prepare("SELECT id, label, repository_key, continuation_secret FROM workspaces").all() as {
    id: string;
    label: string;
    repository_key: string;
    continuation_secret: Buffer;
  }[];
  if (workspaces.length === 0) {
    const secret = randomBytes(32);
    db.prepare(
      "INSERT INTO workspaces (id, label, repository_key, root_commit, continuation_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(location.workspaceId, location.label, location.repositoryKey, location.rootCommit, secret, now);
    workspaces.push({ id: location.workspaceId, label: location.label, repository_key: location.repositoryKey, continuation_secret: secret });
  }
  const workspace = workspaces[0];
  if (
    workspaces.length === 1 &&
    workspace !== undefined &&
    workspace.id === location.workspaceId &&
    workspace.repository_key !== location.repositoryKey &&
    location.formerRepositoryKeys.includes(workspace.repository_key)
  ) {
    repointMovedRepository(db, workspace.repository_key, location.repositoryKey);
    workspace.repository_key = location.repositoryKey;
  }
  if (workspaces.length !== 1 || workspace === undefined || workspace.id !== location.workspaceId || workspace.repository_key !== location.repositoryKey) {
    throw new MemchorError(
      "storage_unavailable",
      `The database at ${location.dbPath} belongs to a different repository or workspace; refusing to use it for ${location.worktree}.`,
      {
        details: {
          dbPath: location.dbPath,
          expected: { workspaceId: location.workspaceId, repositoryKey: location.repositoryKey },
          found: workspaces.map((w) => ({ workspaceId: w.id, repositoryKey: w.repository_key })),
        },
      },
    );
  }
  return { label: workspace.label, continuationSecret: workspace.continuation_secret };
}

/** Worktree bindings follow the repository by their position relative to its main worktree. */
function repointMovedRepository(db: Db, fromKey: string, toKey: string): void {
  requireTransaction(db, "repointMovedRepository");
  prepared(db, "UPDATE workspaces SET repository_key = ? WHERE repository_key = ?").run(toKey, fromKey);
  const from = mainWorktreeOf(fromKey);
  const to = mainWorktreeOf(toKey);
  if (from === null || to === null) return;
  const bindings = prepared(db, "SELECT worktree_path FROM worktree_bindings").all() as { worktree_path: string }[];
  const move = prepared(db, "UPDATE worktree_bindings SET worktree_path = ? WHERE worktree_path = ?");
  for (const { worktree_path: path } of bindings) {
    if (path === from || path.startsWith(from + sep)) move.run(to + path.slice(from.length), path);
  }
}

/** The workstream bound to a worktree, or null. Read-only. */
export function findBinding(db: Db, worktree: string): { id: string; label: string } | null {
  const row = boundTo(db, worktree);
  return row === null ? null : { id: row.id, label: row.label };
}
