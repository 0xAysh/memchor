import { createHash } from "node:crypto";
import { ZodError, type z } from "zod";
import { bindScope, type BoundScope } from "./bootstrap/workstream-resolution.js";
import { headCommit, resolveHome, resolveWorkspace, type WorkspaceLocation } from "./bootstrap/workspace-resolution.js";
import { type ErrorCode, MemchorError } from "./errors.js";
import { headCheckpointRecordId, headRevision, publishCheckpoint } from "./integrity/checkpoints.js";
import { type Citation, citationsFor, linksOf } from "./integrity/provenance.js";
import { ITEM_EXCERPT_BYTES, openContinuation, packPage, type Packable, sealContinuation, usage } from "./retrieval/context-pack.js";
import { requireVisibleRecord, type RecordRow } from "./retrieval/eligibility.js";
import { type Candidate, clipToBytes, currentSeqMax, rankCandidates, rebuildSearchIndex, toFtsQuery } from "./retrieval/search.js";
import {
  type Applicability,
  type Attribution,
  BootstrapInput,
  CheckpointInput,
  effectiveBudget,
  estimateTokens,
  type ExternalRef,
  LIMITS,
  type LinkRelation,
  ReadInput,
  RecallInput,
  type RecordKind,
  RecordInput,
  type ReviewState,
  StatusInput,
} from "./schemas.js";
import {
  checkIntegrity,
  type Db,
  type IntegrityReport,
  openDatabase,
  probeRuntime,
  type RuntimeReport,
  SCHEMA_VERSION,
  toStorageError,
  writeTransaction,
} from "./storage/database.js";
import { appendRecord } from "./storage/records.js";

export type { Citation } from "./integrity/provenance.js";
export type { IntegrityReport } from "./storage/database.js";

// ───────────────────────────── Public interface ─────────────────────────────

export interface OpenMemoryOptions {
  /** Trusted: the directory the host launched Memchor in. Scope is derived from it and nothing else. */
  cwd: string;
  /** Trusted: which agent host this process serves (e.g. "claude-code", "codex", "pi", "unknown"). */
  host: string;
  /** Storage root. Defaults to `$MEMCHOR_HOME`, then `~/.memchor`. Never inside the repository. */
  home?: string;
  /** The host's own session identifier, if known at launch (can also be supplied to `bootstrap`). */
  hostSessionId?: string;
  /** Bounded wait for another process's write lock before `storage_busy`. Default 5000 ms. */
  busyTimeoutMs?: number;
}

/** The scope this Memory instance is bound to. Fixed for the instance's lifetime. */
export interface Scope {
  workspaceId: string;
  workspaceLabel: string;
  workstreamId: string;
  workstreamLabel: string;
  branch: string;
  worktree: string;
  /** Current head checkpoint revision (0 = none yet); pass it as `expectedRevision`. */
  headRevision: number;
  sessionId: string;
  host: string;
}

export interface PackItem {
  recordId: string;
  kind: RecordKind;
  title: string | null;
  /** A passage of the body (the best-matching one for a query). Use `read` for the rest. */
  excerpt: string;
  /** True when `excerpt` is not the whole body. */
  truncated: boolean;
  attribution: Attribution;
  reviewState: ReviewState;
  /** Always "unknown" until freshness validation ships; verify live artifacts before acting. */
  freshness: "current" | "stale" | "unknown";
  applicability: Applicability;
  citations: Citation[];
  externalRefs: ExternalRef[];
  workspaceLevel: boolean;
  host: string;
  createdAt: string;
}

export interface PackCheckpoint {
  recordId: string;
  revision: number;
  excerpt: string;
  truncated: boolean;
  citations: Citation[];
  externalRefs: ExternalRef[];
  host: string;
  createdAt: string;
}

export interface Omission {
  /** `budget`: more eligible records follow (use `continuation`). `exceeds_budget`: records too large for this budget even alone. */
  reason: "budget" | "exceeds_budget";
  count: number;
  recordIds?: string[];
}

export interface ContextPack {
  scope: Scope;
  /** The head checkpoint, first page only; null when none exists or on continuation pages. */
  checkpoint: PackCheckpoint | null;
  items: PackItem[];
  omissions: Omission[];
  /** True when eligible content was left out of this pack. */
  truncated: boolean;
  /** Opaque token for the next page; bound to this workspace/workstream, query and kinds. */
  continuation: string | null;
  budget: { maxTokens: number; maxBytes: number; usedTokens: number; usedBytes: number };
  /** True when nothing eligible was found: an honest miss, not a reason to invent continuity. */
  empty: boolean;
  notice: string | null;
}

export interface BootstrapResult {
  scope: Scope;
  /** Whether this instance's binding created the workspace database / workstream. */
  created: { workspace: boolean; workstream: boolean };
  runtime: { sqliteVersion: string; fts5: boolean; schemaVersion: number };
  /** Same as `recall({})`: head checkpoint plus the most recent eligible records. */
  context: ContextPack;
}

export interface RecordResult {
  recordId: string;
  kind: RecordKind;
  createdAt: string;
  workspaceLevel: boolean;
  links: Citation[];
  /** True when this call replayed a stored result for its operationKey (nothing new was written). */
  replayed: boolean;
}

export interface CheckpointResult {
  recordId: string;
  revision: number;
  previousRevision: number;
  createdAt: string;
  replayed: boolean;
}

export interface ReadResult {
  recordId: string;
  kind: RecordKind;
  title: string | null;
  /** The slice of the body starting at `offset`, within the byte budget. */
  body: string;
  offset: number;
  /** Pass as `offset` to continue; null when the slice reaches the end. */
  nextOffset: number | null;
  truncated: boolean;
  totalLength: number;
  attribution: Attribution;
  reviewState: ReviewState;
  freshness: "current" | "stale" | "unknown";
  applicability: Applicability;
  externalRefs: ExternalRef[];
  /** Links in both directions whose other end is visible in this scope. */
  links: { recordId: string; relation: LinkRelation; direction: "outgoing" | "incoming" }[];
  workspaceLevel: boolean;
  checkpointRevision: number | null;
  host: string;
  sessionId: string | null;
  contentHash: string;
  createdAt: string;
  /** The budget applies to `body` only. */
  budget: { maxTokens: number; maxBytes: number; usedTokens: number; usedBytes: number };
}

export interface StatusResult {
  runtime: RuntimeReport;
  storage: {
    home: string;
    dbPath: string | null;
    schemaVersion: number | null;
    supportedSchemaVersion: number;
    journalMode: string | null;
  };
  scope: Scope | null;
  counts: { records: number; checkpoints: number; workstreams: number; sessions: number } | null;
  /** Set when scope or storage could not be resolved; status itself never throws for these. */
  problem: { code: ErrorCode; message: string } | null;
  capabilities: { operations: string[]; freshnessValidation: boolean; transcriptImport: boolean };
}

/**
 * Local working memory for one agent session, bound to exactly one workspace/workstream.
 *
 * Invariants callers can rely on:
 * - **Scope is not an input.** It is resolved once from the trusted `cwd` (lazily on the
 *   first operation, or by `bootstrap`) and enforced inside every operation. Payloads are
 *   strict: unknown keys such as `workspaceId` or `path` are `invalid_input`.
 * - **Every write is one IMMEDIATE transaction**: record + provenance links + search
 *   chunks + idempotency row commit together or not at all. An acknowledged write is
 *   durable (WAL, synchronous=FULL).
 * - **Idempotency**: an `operationKey` replays its stored result for the same request and
 *   is `idempotency_conflict` for a different one.
 * - **Checkpoints are compare-and-swap** on `expectedRevision`; never merged.
 * - **Recall filters before ranking** and never exceeds its budget.
 * - Methods are synchronous and throw only `MemchorError` for expected failures.
 */
export interface Memory {
  /** Binds scope (if not yet bound), records the host session id, and returns scope plus initial context. */
  bootstrap(input?: BootstrapInput): BootstrapResult;
  /** Appends one attributed record with provenance links and external references. */
  record(input: RecordInput): RecordResult;
  /** Publishes the next checkpoint revision iff the head is still `expectedRevision`. */
  checkpoint(input: CheckpointInput): CheckpointResult;
  /** Returns a bounded, cited context pack: head checkpoint first, then ranked eligible records. */
  recall(input?: RecallInput): ContextPack;
  /** Returns one visible record's body slice within a budget, plus its in-scope links. */
  read(input: ReadInput): ReadResult;
  /** Reports runtime, storage and scope health. Does not throw for unresolved scope. */
  status(input?: StatusInput): StatusResult;
  /** Regenerates the search projection from canonical records; canonical rows are untouched. */
  rebuildSearchIndex(): { records: number; chunks: number };
  /** Diagnostics: SQLite integrity_check, foreign-key check, and FTS index-vs-content check. Read-only. */
  checkIntegrity(): IntegrityReport;
  /** Closes the database connection. Further calls fail with `storage_unavailable`. */
  close(): void;
}

/**
 * Creates a Memory for a process. Cheap and side-effect free: Git, the registry and the
 * database are touched on the first operation, so an agent launched outside a Git
 * repository still gets a working `status` and a clear `scope_unresolved` elsewhere.
 */
export function openMemory(options: OpenMemoryOptions): Memory {
  return new LocalMemory(options);
}

// ───────────────────────────── Implementation ─────────────────────────────

const OPERATIONS = ["memory_bootstrap", "memory_recall", "memory_read", "memory_record", "memory_checkpoint", "memory_status"];

interface Bound {
  db: Db;
  scope: BoundScope;
  location: WorkspaceLocation;
}

class LocalMemory implements Memory {
  private readonly cwd: string;
  private readonly host: string;
  private readonly home: string;
  private readonly busyTimeoutMs: number | undefined;
  private hostSessionId: string | undefined;
  private bound: Bound | undefined;
  private closed = false;

  constructor(options: OpenMemoryOptions) {
    this.cwd = options.cwd;
    this.host = options.host.trim().slice(0, 100) || "unknown";
    this.home = resolveHome(options.home);
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.hostSessionId = options.hostSessionId;
  }

  bootstrap(input: BootstrapInput = {}): BootstrapResult {
    return this.guard(() => {
      const parsed = parse(BootstrapInput, input);
      if (parsed.hostSessionId !== undefined) this.adoptHostSessionId(parsed.hostSessionId);
      const { db, scope, location } = this.bind();
      const runtime = probeRuntime();
      return {
        scope: scopeView(db, scope),
        created: { workspace: location.isNew, workstream: scope.createdWorkstream },
        runtime: { sqliteVersion: runtime.sqliteVersion, fts5: runtime.fts5, schemaVersion: SCHEMA_VERSION },
        context: this.pack(db, scope, parse(RecallInput, {})),
      };
    });
  }

  record(input: RecordInput): RecordResult {
    return this.guard(() => {
      const parsed = parse(RecordInput, input);
      const { db, scope } = this.bind();
      const applicability = withHeadCommit(parsed.applicability, scope.worktree);
      const links: Citation[] = [
        ...parsed.supportedBy.map((recordId) => ({ recordId, relation: "supported_by" as const })),
        ...parsed.links.map((link) => ({ recordId: link.to, relation: link.relation })),
      ];
      return this.idempotent(db, scope, "record", parsed, (): Omit<RecordResult, "replayed"> => {
        const written = appendRecord(db, scope.workstreamId, {
          kind: parsed.kind,
          title: parsed.title ?? null,
          body: parsed.body,
          workstreamId: parsed.workspaceLevel ? null : scope.workstreamId,
          sessionId: scope.sessionId,
          host: scope.host,
          attribution: parsed.attribution,
          reviewState: parsed.reviewState,
          applicability,
          externalRefs: parsed.externalRefs,
          links,
        });
        return {
          recordId: written.recordId,
          kind: parsed.kind,
          createdAt: written.createdAt,
          workspaceLevel: parsed.workspaceLevel,
          links: written.links,
        };
      });
    });
  }

  checkpoint(input: CheckpointInput): CheckpointResult {
    return this.guard(() => {
      const parsed = parse(CheckpointInput, input);
      const { db, scope } = this.bind();
      const applicability = withHeadCommit({}, scope.worktree);
      // Replay is checked before the revision compare, so retrying a checkpoint that
      // already succeeded returns its result instead of a spurious conflict.
      return this.idempotent(db, scope, "checkpoint", parsed, () =>
        publishCheckpoint(db, scope, parsed.expectedRevision, parsed, applicability),
      );
    });
  }

  recall(input: RecallInput = {}): ContextPack {
    return this.guard(() => {
      const parsed = parse(RecallInput, input);
      const { db, scope } = this.bind();
      return this.pack(db, scope, parsed);
    });
  }

  read(input: ReadInput): ReadResult {
    return this.guard(() => {
      const parsed = parse(ReadInput, input);
      const { db, scope } = this.bind();
      return db.transaction(() => {
        const row = requireVisibleRecord(db, scope.workstreamId, parsed.recordId);
        if (parsed.offset > row.body.length) {
          throw new MemchorError("invalid_input", `offset ${parsed.offset} is past the end of the record (${row.body.length}).`, {
            details: { offset: parsed.offset, totalLength: row.body.length },
          });
        }
        const budget = effectiveBudget(parsed);
        const body = clipToBytes(row.body.slice(parsed.offset), budget.maxBytes);
        const end = parsed.offset + body.length;
        const nextOffset = end < row.body.length ? end : null;
        const revision = db.prepare("SELECT revision FROM checkpoints WHERE record_id = ?").get(row.id) as
          | { revision: number }
          | undefined;
        return {
          recordId: row.id,
          kind: row.kind as RecordKind,
          title: row.title,
          body,
          offset: parsed.offset,
          nextOffset,
          truncated: nextOffset !== null,
          totalLength: row.body.length,
          attribution: row.attribution as Attribution,
          reviewState: row.review_state as ReviewState,
          freshness: row.freshness as ReadResult["freshness"],
          applicability: JSON.parse(row.applicability) as Applicability,
          externalRefs: JSON.parse(row.external_refs) as ExternalRef[],
          links: linksOf(db, scope.workstreamId, row.id),
          workspaceLevel: row.workstream_id === null,
          checkpointRevision: revision?.revision ?? null,
          host: row.host,
          sessionId: row.session_id,
          contentHash: row.content_hash,
          createdAt: row.created_at,
          budget: { ...budget, ...usage(Buffer.byteLength(body, "utf8")) },
        };
      })();
    });
  }

  status(input: StatusInput = {}): StatusResult {
    return this.guard(() => {
      parse(StatusInput, input);
      const result: StatusResult = {
        runtime: probeRuntime(),
        storage: { home: this.home, dbPath: null, schemaVersion: null, supportedSchemaVersion: SCHEMA_VERSION, journalMode: null },
        scope: null,
        counts: null,
        problem: null,
        capabilities: { operations: OPERATIONS, freshnessValidation: false, transcriptImport: false },
      };
      try {
        const { db, scope, location } = this.bind();
        const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
        result.storage.dbPath = location.dbPath;
        result.storage.schemaVersion = db.pragma("user_version", { simple: true }) as number;
        result.storage.journalMode = db.pragma("journal_mode", { simple: true }) as string;
        result.scope = scopeView(db, scope);
        result.counts = {
          records: count("records"),
          checkpoints: count("checkpoints"),
          workstreams: count("workstreams"),
          sessions: count("sessions"),
        };
      } catch (error) {
        const mapped = toStorageError(error);
        if (!(mapped instanceof MemchorError)) throw mapped;
        result.problem = { code: mapped.code, message: mapped.message };
      }
      return result;
    });
  }

  rebuildSearchIndex(): { records: number; chunks: number } {
    return this.guard(() => {
      const { db } = this.bind();
      return writeTransaction(db, () => rebuildSearchIndex(db));
    });
  }

  checkIntegrity(): IntegrityReport {
    return this.guard(() => checkIntegrity(this.bind().db));
  }

  close(): void {
    this.closed = true;
    this.bound?.db.close();
    this.bound = undefined;
  }

  // ── internals ──

  /** Resolves and binds scope exactly once per instance; later calls reuse it. */
  private bind(): Bound {
    if (this.closed) throw new MemchorError("storage_unavailable", "This Memory has been closed.");
    if (this.bound !== undefined) return this.bound;
    const location = resolveWorkspace(this.cwd, this.home);
    const db = openDatabase(location.dbPath, this.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.busyTimeoutMs });
    try {
      const scope = bindScope(db, location, this.host, this.hostSessionId);
      this.bound = { db, scope, location };
      return this.bound;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private adoptHostSessionId(hostSessionId: string): void {
    if (this.bound === undefined) {
      this.hostSessionId ??= hostSessionId;
      if (this.hostSessionId === hostSessionId) return;
    } else {
      const { db, scope } = this.bound;
      const set = writeTransaction(db, () =>
        db.prepare("UPDATE sessions SET host_session_id = ? WHERE id = ? AND host_session_id IS NULL").run(hostSessionId, scope.sessionId),
      );
      this.hostSessionId ??= hostSessionId;
      if (set.changes === 1 || this.hostSessionId === hostSessionId) return;
    }
    throw new MemchorError("invalid_input", "This Memchor process is already bound to a different host session.", {
      details: { hostSessionId },
    });
  }

  /**
   * Runs a write under an optional operation key, in one IMMEDIATE transaction: the key
   * lookup, the write, and the operation row commit together, so a retry after a crash
   * either finds the stored result or redoes the whole write — never half of it.
   * The request hash covers the operation, the workstream, and the normalised input
   * (defaults applied, key removed), so the same key from another workstream conflicts.
   */
  private idempotent<R extends object>(
    db: Db,
    scope: BoundScope,
    operation: string,
    parsed: { operationKey?: string | undefined },
    write: () => R,
  ): R & { replayed: boolean } {
    const { operationKey, ...request } = parsed;
    return writeTransaction(db, () => {
      if (operationKey === undefined) return { ...write(), replayed: false };
      const requestHash = createHash("sha256")
        .update(canonicalJson({ operation, workstreamId: scope.workstreamId, request }))
        .digest("hex");
      const stored = db.prepare("SELECT request_hash, result_json FROM operations WHERE key = ?").get(operationKey) as
        | { request_hash: string; result_json: string }
        | undefined;
      if (stored !== undefined) {
        if (stored.request_hash !== requestHash) {
          throw new MemchorError("idempotency_conflict", `Operation key "${operationKey}" was already used for a different request.`, {
            details: { operationKey },
          });
        }
        return { ...(JSON.parse(stored.result_json) as R), replayed: true };
      }
      const result = write();
      db.prepare(
        "INSERT INTO operations (key, operation, request_hash, result_json, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(operationKey, operation, requestHash, JSON.stringify(result), scope.sessionId, new Date().toISOString());
      return { ...result, replayed: false };
    });
  }

  /**
   * Builds one page of a context pack inside a single read transaction, so the head
   * checkpoint, the candidates, and their citations come from one consistent snapshot.
   */
  private pack(db: Db, scope: BoundScope, parsed: z.output<typeof RecallInput>): ContextPack {
    const kinds = parsed.kinds === undefined ? null : [...new Set(parsed.kinds)].sort();
    let state: { query: string | null; kinds: string[] | null; seqMax: number; offset: number };
    if (parsed.continuation !== undefined) {
      state = openContinuation(scope.continuationSecret, parsed.continuation, scope);
      if ((parsed.query !== undefined && parsed.query !== state.query) || (kinds !== null && canonicalJson(kinds) !== canonicalJson(state.kinds))) {
        throw new MemchorError("invalid_input", "A continuation cannot change the query or kinds of its sequence.", {
          details: { reason: "continuation_mismatch" },
        });
      }
    } else {
      state = { query: parsed.query ?? null, kinds, seqMax: 0, offset: 0 };
    }
    const match = state.query === null ? null : toFtsQuery(state.query);
    const budget = effectiveBudget(parsed);
    const firstPage = parsed.continuation === undefined;

    return db.transaction((): ContextPack => {
      if (firstPage) state.seqMax = currentSeqMax(db);
      const view = scopeView(db, scope);
      const checkpointRow = firstPage ? loadHeadCheckpoint(db, scope.workstreamId) : null;
      const { rows, total } = rankCandidates(db, { workstreamId: scope.workstreamId, match, kinds: state.kinds, seqMax: state.seqMax, offset: state.offset });
      const citations = citationsFor(db, scope.workstreamId, [...rows.map((r) => r.id), ...(checkpointRow ? [checkpointRow.id] : [])]);

      const checkpointPackable: Packable<PackCheckpoint> | null =
        checkpointRow === null
          ? null
          : {
              recordId: checkpointRow.id,
              source: checkpointRow.body,
              maxExcerptBytes: LIMITS.bodyBytes,
              build: (excerpt, truncated) => ({
                recordId: checkpointRow.id,
                revision: view.headRevision,
                excerpt,
                truncated,
                citations: citations.get(checkpointRow.id) ?? [],
                externalRefs: JSON.parse(checkpointRow.external_refs) as ExternalRef[],
                host: checkpointRow.host,
                createdAt: checkpointRow.created_at,
              }),
            };
      const page = packPage(budget, checkpointPackable, rows.map((row) => itemPackable(row, citations.get(row.id) ?? [])));

      const nextOffset = state.offset + page.consumed;
      const remaining = Math.max(0, total - nextOffset);
      const omissions: Omission[] = [];
      if (page.oversized.length > 0) omissions.push({ reason: "exceeds_budget", count: page.oversized.length, recordIds: page.oversized });
      if (remaining > 0) omissions.push({ reason: "budget", count: remaining });
      const truncated = remaining > 0 || page.oversized.length > 0 || page.checkpoint?.truncated === true;
      const empty = page.checkpoint === null && page.items.length === 0 && omissions.length === 0;

      let notice: string | null = null;
      if (empty) {
        notice =
          firstPage && state.query === null
            ? "No memory has been recorded for this workstream yet. There is no prior context; do not assume any."
            : "No eligible memory matches this request. Nothing is known about it; do not assume prior context.";
      } else if (truncated) {
        notice = "Budget reached before all eligible memory was returned. Pass `continuation` for more, or read a recordId to expand it.";
      }

      return {
        scope: view,
        checkpoint: page.checkpoint,
        items: page.items,
        omissions,
        truncated,
        continuation:
          remaining > 0
            ? sealContinuation(scope.continuationSecret, {
                workspaceId: scope.workspaceId,
                workstreamId: scope.workstreamId,
                query: state.query,
                kinds: state.kinds,
                seqMax: state.seqMax,
                offset: nextOffset,
              })
            : null,
        budget: { ...budget, usedBytes: page.usedBytes, usedTokens: estimateTokens(page.usedBytes) },
        empty,
        notice,
      };
    })();
  }

  /** Maps any thrown value to the error contract: zod → invalid_input, SQLite → storage_*. */
  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ZodError) throw invalidInput(error);
      throw toStorageError(error);
    }
  }
}

function itemPackable(row: Candidate, citations: Citation[]): Packable<PackItem> {
  return {
    recordId: row.id,
    source: row.excerpt_source,
    maxExcerptBytes: ITEM_EXCERPT_BYTES,
    build: (excerpt, truncated) => ({
      recordId: row.id,
      kind: row.kind as RecordKind,
      title: row.title,
      excerpt,
      truncated: truncated || row.excerpt_source !== row.body,
      attribution: row.attribution as Attribution,
      reviewState: row.review_state as ReviewState,
      freshness: row.freshness as PackItem["freshness"],
      applicability: JSON.parse(row.applicability) as Applicability,
      citations,
      externalRefs: JSON.parse(row.external_refs) as ExternalRef[],
      workspaceLevel: row.workstream_id === null,
      host: row.host,
      createdAt: row.created_at,
    }),
  };
}

function loadHeadCheckpoint(db: Db, workstreamId: string): RecordRow | null {
  const recordId = headCheckpointRecordId(db, workstreamId);
  return recordId === null ? null : requireVisibleRecord(db, workstreamId, recordId);
}

function scopeView(db: Db, scope: BoundScope): Scope {
  return {
    workspaceId: scope.workspaceId,
    workspaceLabel: scope.workspaceLabel,
    workstreamId: scope.workstreamId,
    workstreamLabel: scope.workstreamLabel,
    branch: scope.branch,
    worktree: scope.worktree,
    headRevision: headRevision(db, scope.workstreamId),
    sessionId: scope.sessionId,
    host: scope.host,
  };
}

function withHeadCommit(applicability: Applicability, worktree: string): Applicability {
  if (applicability.commit !== undefined) return applicability;
  const commit = headCommit(worktree);
  return commit === null ? applicability : { ...applicability, commit };
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  return schema.parse(input);
}

function invalidInput(error: ZodError): MemchorError {
  const issues = error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }));
  const scopeHint = issues.some((issue) => issue.code === "unrecognized_keys")
    ? " Payloads cannot carry scope or unknown fields; scope comes from where the host started Memchor."
    : "";
  return new MemchorError(
    "invalid_input",
    `Invalid input: ${issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ")}.${scopeHint}`,
    { details: { issues } },
  );
}

/** JSON with object keys sorted recursively, so equal requests hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
