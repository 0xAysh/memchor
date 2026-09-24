import { createHash } from "node:crypto";
import { ZodError, type z } from "zod";
import {
  bindScope,
  type BoundScope,
  findBinding,
  requireWorkstream,
  type ResolutionBasis,
  type ScopeAmbiguity,
  type ScopeHints,
} from "./bootstrap/workstream-resolution.js";
import { headCommit, locateWorkspace, registerWorkspace, resolveHome, type WorkspaceLocation } from "./bootstrap/workspace-resolution.js";
import { type ErrorCode, MemchorError } from "./errors.js";
import { headCheckpointRecordId, headRevision, publishCheckpoint } from "./integrity/checkpoints.js";
import { claudeCodeAdapter } from "./import/adapters/claude.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";
import { type ImportStatus, TranscriptImporter, unsupportedHostStatus } from "./import/reconcile.js";
import { type Citation, citationsFor, importedFrom, type ImportedSource, linksOf } from "./integrity/provenance.js";
import { type ContinuationState, ITEM_EXCERPT_BYTES, openContinuation, packPage, type Packable, sealContinuation, usage } from "./retrieval/context-pack.js";
import { requireVisibleRecord, type RecordRow } from "./retrieval/eligibility.js";
import { type Candidate, clipToBytes, loadCandidates, PAGE_CANDIDATES, rankSequence, rebuildSearchIndex, SEQUENCE_CAP, toFtsQuery } from "./retrieval/search.js";
import {
  type Applicability,
  type Attribution,
  BootstrapInput,
  CheckpointInput,
  ContinueImportInput,
  effectiveBudget,
  estimateTokens,
  type ExternalRef,
  type Freshness,
  LIMITS,
  type LinkRelation,
  OPERATION_SCHEMAS,
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
  openReadOnly,
  probeRuntime,
  type RuntimeReport,
  SCHEMA_VERSION,
  toStorageError,
  writeTransaction,
} from "./storage/database.js";
import { appendRecord, recordFields } from "./storage/records.js";

export type { ImportedSource, Citation } from "./integrity/provenance.js";
export type { ImportCounters, ImportGap, ImportStatus } from "./import/reconcile.js";
export type { IntegrityReport } from "./storage/database.js";
export type { CandidateSignal, ResolutionBasis, ScopeAmbiguity, WorkstreamCandidate } from "./bootstrap/workstream-resolution.js";
export type { CheckpointSummary } from "./integrity/checkpoints.js";

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
  /** Claude Code's config directory (transcripts live in its `projects/`). Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  claudeConfigDir?: string;
  /** Alternate host-format adapter, primarily for compatibility and privacy integration tests. */
  transcriptAdapter?: TranscriptAdapter;
  /** How long `bootstrap` may spend importing the current project's transcripts before returning. Default 3000 ms. */
  importBudgetMs?: number;
}

/**
 * The scope this Memory instance is bound to. The workspace is fixed for the instance's
 * lifetime; the workstream changes only through `bootstrap({ workstream | task })`.
 */
export interface Scope {
  workspaceId: string;
  workspaceLabel: string;
  /** Null while `ambiguity` is set: the session is workspace-level until the user chooses. */
  workstreamId: string | null;
  workstreamLabel: string | null;
  /** The workstream's normalised explicit task identity (e.g. "#20"), if it has one. */
  taskKey: string | null;
  /** Which signal chose the workstream (see docs/architecture.md, "Scope"); null while ambiguous. */
  resolvedBy: ResolutionBasis | null;
  /** Set when more than one workstream could continue here, or signals conflict: ask the user (`question`). */
  ambiguity: ScopeAmbiguity | null;
  branch: string;
  worktree: string;
  /** Current head checkpoint revision (0 = none yet, or no workstream); pass it as `expectedRevision`. */
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
  freshness: Freshness;
  applicability: Applicability;
  citations: Citation[];
  externalRefs: ExternalRef[];
  workspaceLevel: boolean;
  host: string;
  /** Where an imported record came from (host, transcript, event); null for records agents wrote. */
  source: ImportedSource | null;
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
  /**
   * `budget`: more of the sequence follows (use `continuation`).
   * `exceeds_budget`: records too large for this budget even alone (read them directly).
   * `candidate_limit`: eligible matches beyond the 500-record sequence cap; refine the query.
   */
  reason: "budget" | "exceeds_budget" | "candidate_limit";
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
  /**
   * Opaque token for the next page. The ranked order is frozen at page 1, so following
   * it never skips or repeats a record, whatever is written meanwhile; records written
   * after page 1 are not part of the sequence.
   */
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
  /** Transcript import: the consent question on first use, else progress and capture gaps. */
  import: ImportStatus;
  /** Same as `recall({})` after this bootstrap's import: head checkpoint plus the most recent eligible records. */
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
  /** Effective start (UTF-16 code units), snapped back if the request split a surrogate pair. */
  offset: number;
  /** Pass as `offset` to continue; null when the slice reaches the end. */
  nextOffset: number | null;
  truncated: boolean;
  totalLength: number;
  attribution: Attribution;
  reviewState: ReviewState;
  freshness: Freshness;
  applicability: Applicability;
  externalRefs: ExternalRef[];
  /** Links in both directions whose other end is visible in this scope. */
  links: { recordId: string; relation: LinkRelation; direction: "outgoing" | "incoming" }[];
  workspaceLevel: boolean;
  checkpointRevision: number | null;
  host: string;
  sessionId: string | null;
  source: ImportedSource | null;
  contentHash: string;
  createdAt: string;
  /** The budget applies to `body` only. */
  budget: { maxTokens: number; maxBytes: number; usedTokens: number; usedBytes: number };
}

export interface StatusScope {
  workspaceId: string;
  workspaceLabel: string;
  worktree: string;
  branch: string;
  workstreamId: string | null;
  workstreamLabel: string | null;
  headRevision: number | null;
  /** This instance's session, once an operation other than status has bound scope. */
  sessionId: string | null;
  host: string;
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
  /** What bootstrap would bind; `workstreamId` is null while this worktree has no workstream yet. */
  scope: StatusScope | null;
  counts: { records: number; checkpoints: number; workstreams: number; sessions: number } | null;
  /** Set when scope or storage could not be resolved; status itself never throws for these. */
  problem: { code: ErrorCode; message: string } | null;
  capabilities: { operations: string[]; freshnessValidation: boolean; transcriptImport: boolean };
  /** Consent, discovered transcripts, this project's import progress and capture gaps; null when scope is unresolved. */
  import: ImportStatus | null;
}

/**
 * Local working memory for one agent session, bound to exactly one workspace/workstream.
 *
 * Invariants callers can rely on:
 * - **Scope is not an input.** It is resolved once from the trusted `cwd` (lazily on the
 *   first operation, or by `bootstrap`) and enforced inside every operation. Payloads are
 *   strict: unknown keys such as `workspaceId` or `path` are `invalid_input`. The only scope
 *   input is bootstrap's `workstream`, the user's answer to `scope.ambiguity`, which can only
 *   name a workstream of the already-resolved workspace.
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
  /**
   * Binds scope (if not yet bound), records the host session id, reconciles the current
   * project's approved transcripts within a time budget, and returns scope plus initial
   * context. On a host's first use it returns the import consent question instead of
   * importing; `importChoice` records (or changes) the answer.
   *
   * When more than one workstream could continue here, `scope.ambiguity` lists them and no
   * workstream is bound: recall shows only workspace-level memory and workstream-scoped
   * writes fail with `scope_ambiguous`. `workstream` (an id from the candidates, or "new")
   * answers it and becomes this worktree's binding; `task` names the task explicitly.
   */
  bootstrap(input?: BootstrapInput): BootstrapResult;
  /**
   * Continues importing approved transcripts (the current project first, then other approved
   * projects) for up to `maxMs`. Adapters call it between requests while the process is
   * alive; `done` is true once nothing approved remains. Each batch is one transaction.
   */
  continueImport(input?: ContinueImportInput): ImportStatus & { done: boolean };
  /** Appends one attributed record with provenance links and external references. */
  record(input: RecordInput): RecordResult;
  /** Publishes the next checkpoint revision iff the head is still `expectedRevision`. */
  checkpoint(input: CheckpointInput): CheckpointResult;
  /** Returns a bounded, cited context pack: head checkpoint first, then ranked eligible records. */
  recall(input?: RecallInput): ContextPack;
  /** Returns one visible record's body slice within a budget, plus its in-scope links. */
  read(input: ReadInput): ReadResult;
  /**
   * Reports runtime, storage and scope health. Strictly read-only: it never creates the
   * workspace, workstream, session or registry entry, never migrates, and does not
   * throw for unresolved scope or unusable storage (see `problem`).
   */
  status(input?: StatusInput): StatusResult;
  /** Regenerates the search projection from canonical records; canonical rows are untouched. */
  rebuildSearchIndex(): { records: number; chunks: number };
  /**
   * Diagnostics: SQLite integrity_check, foreign-key check, and FTS index-vs-content check
   * on this worktree's workspace database. Read-only; reports (never repairs or migrates)
   * a damaged, foreign or unmigrated file.
   */
  checkIntegrity(): IntegrityReport;
  /** Closes the database connection. Further calls fail with `storage_unavailable`. */
  close(): void;
}

/**
 * Creates a Memory for a process. Cheap and side-effect free: Git, the registry and the
 * database are touched on the first operation, so an agent launched outside a Git
 * repository still gets a working `status` and a clear `scope_unresolved` elsewhere.
 * `status` and `checkIntegrity` only read; every other operation binds scope first.
 */
export function openMemory(options: OpenMemoryOptions): Memory {
  return new LocalMemory(options);
}

// ───────────────────────────── Implementation ─────────────────────────────

const OPERATIONS = Object.keys(OPERATION_SCHEMAS);
const DEFAULT_IMPORT_BUDGET_MS = 3_000;

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
  /** Null for hosts without a transcript adapter. */
  private readonly importer: TranscriptImporter | null;

  constructor(options: OpenMemoryOptions) {
    this.cwd = options.cwd;
    this.host = options.host.trim().slice(0, LIMITS.hostChars) || "unknown";
    this.home = resolveHome(options.home);
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.hostSessionId = options.hostSessionId;
    const adapter = options.transcriptAdapter ?? (this.host === "claude-code" ? claudeCodeAdapter(options.claudeConfigDir === undefined ? {} : { configDir: options.claudeConfigDir }) : null);
    this.importer =
      adapter === null
        ? null
        : new TranscriptImporter({
            home: this.home,
            adapter,
            bootstrapBudgetMs: options.importBudgetMs ?? DEFAULT_IMPORT_BUDGET_MS,
            ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
          });
  }

  bootstrap(input: BootstrapInput = {}): BootstrapResult {
    return this.guard(() => {
      const parsed = parse(BootstrapInput, input);
      if (parsed.hostSessionId !== undefined) this.adoptHostSessionId(parsed.hostSessionId);
      const { db, scope, location } = this.bind({ task: parsed.task, workstream: parsed.workstream });
      const runtime = probeRuntime();
      const imported = this.importer === null ? unsupportedHostStatus(this.host) : this.importer.bootstrap({ location, db }, parsed.importChoice);
      return {
        scope: scopeView(db, scope),
        created: { workspace: location.isNew, workstream: scope.createdWorkstream },
        runtime: { sqliteVersion: runtime.sqliteVersion, fts5: runtime.fts5, schemaVersion: SCHEMA_VERSION },
        import: imported,
        context: withScopeNotice(scope, this.pack(db, scope, parse(RecallInput, {}))),
      };
    });
  }

  record(input: RecordInput): RecordResult {
    return this.guard(() => {
      const parsed = parse(RecordInput, input);
      const { db, scope } = this.bind();
      if (!parsed.workspaceLevel) requireWorkstream(scope, "memory_record");
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
      requireWorkstream(scope, "memory_checkpoint");
      const applicability = withHeadCommit({}, scope.worktree);
      // Replay is checked before the revision compare, so retrying a checkpoint that
      // already succeeded returns its result instead of a spurious conflict.
      return this.idempotent(db, scope, "checkpoint", parsed, () =>
        publishCheckpoint(db, scope, parsed.expectedRevision, parsed, applicability),
      );
    });
  }

  continueImport(input: ContinueImportInput = {}): ImportStatus & { done: boolean } {
    return this.guard(() => {
      const parsed = parse(ContinueImportInput, input);
      const { db, location } = this.bind();
      return this.importer === null ? { ...unsupportedHostStatus(this.host), done: true } : this.importer.continue({ location, db }, parsed.maxMs);
    });
  }

  recall(input: RecallInput = {}): ContextPack {
    return this.guard(() => {
      const parsed = parse(RecallInput, input);
      const { db, scope } = this.bind();
      return withScopeNotice(scope, this.pack(db, scope, parsed));
    });
  }

  read(input: ReadInput): ReadResult {
    return this.guard(() => {
      const parsed = parse(ReadInput, input);
      const { db, scope } = this.bind();
      return db.transaction((): ReadResult => {
        const row = requireVisibleRecord(db, scope.workstreamId, parsed.recordId);
        if (parsed.offset > row.body.length) {
          throw new MemchorError("invalid_input", `offset ${parsed.offset} is past the end of the record (${row.body.length}).`, {
            details: { offset: parsed.offset, totalLength: row.body.length },
          });
        }
        const offset = isLowSurrogate(row.body.charCodeAt(parsed.offset)) && isHighSurrogate(row.body.charCodeAt(parsed.offset - 1)) ? parsed.offset - 1 : parsed.offset;
        const budget = effectiveBudget(parsed);
        const body = clipToBytes(row.body.slice(offset), budget.maxBytes);
        const end = offset + body.length;
        const nextOffset = end < row.body.length ? end : null;
        const revision = db.prepare("SELECT revision FROM checkpoints WHERE record_id = ?").get(row.id) as { revision: number } | undefined;
        return {
          recordId: row.id,
          title: row.title,
          body,
          offset,
          nextOffset,
          truncated: nextOffset !== null,
          totalLength: row.body.length,
          ...recordFields(row),
          links: linksOf(db, scope.workstreamId, row.id),
          checkpointRevision: revision?.revision ?? null,
          host: row.host,
          sessionId: row.session_id,
          source: importedFrom(db, [row.id]).get(row.id) ?? null,
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
        capabilities: { operations: OPERATIONS, freshnessValidation: false, transcriptImport: this.importer !== null },
        import: null,
      };
      let db: Db | null = null;
      try {
        if (this.closed) throw new MemchorError("storage_unavailable", "This Memory has been closed.");
        const location = locateWorkspace(this.cwd, this.home);
        result.storage.dbPath = location.dbPath;
        result.scope = {
          workspaceId: location.workspaceId,
          workspaceLabel: location.label,
          worktree: location.worktree,
          branch: location.branch,
          workstreamId: null,
          workstreamLabel: null,
          headRevision: null,
          sessionId: this.bound?.scope.sessionId ?? null,
          host: this.host,
        };
        const importer = this.importer;
        const reportImport = (current: Db | null): void => {
          result.import = importer === null ? unsupportedHostStatus(this.host) : importer.status({ location, db: current });
        };
        db = openReadOnly(location.dbPath);
        if (db === null) {
          reportImport(null);
          return result;
        }
        const schemaVersion = db.pragma("user_version", { simple: true }) as number;
        result.storage.schemaVersion = schemaVersion;
        result.storage.journalMode = db.pragma("journal_mode", { simple: true }) as string;
        if (schemaVersion > SCHEMA_VERSION) {
          result.problem = {
            code: "unsupported_runtime",
            message: `The database uses schema version ${schemaVersion}; this Memchor supports up to ${SCHEMA_VERSION}. Upgrade Memchor.`,
          };
          return result;
        }
        if (schemaVersion < SCHEMA_VERSION) {
          reportImport(null);
          return result; // migrated by the next bootstrap
        }
        reportImport(db);
        const workstream = findBinding(db, location.worktree);
        if (workstream !== null) {
          result.scope.workstreamId = workstream.id;
          result.scope.workstreamLabel = workstream.label;
          result.scope.headRevision = headRevision(db, workstream.id);
        }
        const count = (table: string): number => (db?.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
        result.counts = { records: count("records"), checkpoints: count("checkpoints"), workstreams: count("workstreams"), sessions: count("sessions") };
      } catch (error) {
        const mapped = toStorageError(error);
        if (!(mapped instanceof MemchorError)) throw mapped;
        result.problem = { code: mapped.code, message: mapped.message };
      } finally {
        db?.close();
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
    return this.guard(() => checkIntegrity(locateWorkspace(this.cwd, this.home).dbPath));
  }

  close(): void {
    this.closed = true;
    this.importer?.close();
    this.bound?.db.close();
    this.bound = undefined;
  }

  // ── internals ──

  /**
   * Resolves and binds scope once per instance; later calls reuse it. Only bootstrap passes
   * `hints`: it re-resolves this session when it is still ambiguous, or when the agent gives an
   * explicit choice or task.
   */
  private bind(hints?: ScopeHints): Bound {
    if (this.closed) throw new MemchorError("storage_unavailable", "This Memory has been closed.");
    if (this.bound !== undefined) {
      const { db, location, scope } = this.bound;
      if (hints !== undefined && (hints.task !== undefined || hints.workstream !== undefined || scope.workstream === null)) {
        this.bound.scope = bindScope(db, location, { host: this.host, hostSessionId: this.hostSessionId, sessionId: scope.sessionId }, hints);
      }
      return this.bound;
    }
    const location = locateWorkspace(this.cwd, this.home);
    registerWorkspace(location);
    const db = openDatabase(location.dbPath, this.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.busyTimeoutMs });
    try {
      const scope = bindScope(db, location, { host: this.host, hostSessionId: this.hostSessionId }, hints);
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
  /**
   * Builds one page of a context pack inside a single read transaction, so the head
   * checkpoint, the candidates, and their citations come from one consistent snapshot.
   *
   * Page 1 ranks and freezes the whole sequence (≤ SEQUENCE_CAP seqs); the continuation
   * carries the unreturned remainder. Later pages only load records by seq, re-checking
   * scope and eligibility, so concurrent writes (which shift bm25 statistics) can neither
   * reorder nor inject records into an in-flight sequence.
   */
  private pack(db: Db, scope: BoundScope, parsed: z.output<typeof RecallInput>): ContextPack {
    const kinds = parsed.kinds === undefined ? null : [...new Set(parsed.kinds)].sort();
    let continued: ContinuationState | null = null;
    if (parsed.continuation !== undefined) {
      continued = openContinuation(scope.continuationSecret, parsed.continuation, scope);
      if ((parsed.query !== undefined && parsed.query !== continued.query) || (kinds !== null && canonicalJson(kinds) !== canonicalJson(continued.kinds))) {
        throw new MemchorError("invalid_input", "A continuation cannot change the query or kinds of its sequence.", {
          details: { reason: "continuation_mismatch" },
        });
      }
    }
    const query = continued === null ? (parsed.query ?? null) : continued.query;
    const sequenceKinds = continued === null ? kinds : continued.kinds;
    const match = query === null ? null : toFtsQuery(query);
    const budget = effectiveBudget(parsed);

    return db.transaction((): ContextPack => {
      let sequence: number[];
      let beyondCap: number;
      if (continued === null) {
        const ranked = rankSequence(db, { workstreamId: scope.workstreamId, match, kinds: sequenceKinds });
        sequence = ranked.seqs;
        beyondCap = ranked.total - ranked.seqs.length;
      } else {
        sequence = continued.remaining;
        beyondCap = continued.beyondCap;
      }
      const view = scopeView(db, scope);
      const checkpointRow = continued === null ? loadHeadCheckpoint(db, scope.workstreamId) : null;
      const window = sequence.slice(0, PAGE_CANDIDATES);
      const rows = loadCandidates(db, { workstreamId: scope.workstreamId, match, seqs: window });
      const citations = citationsFor(db, scope.workstreamId, [...rows.map((r) => r.id), ...(checkpointRow ? [checkpointRow.id] : [])]);
      const sources = importedFrom(db, rows.map((r) => r.id));

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
                externalRefs: recordFields(checkpointRow).externalRefs,
                host: checkpointRow.host,
                createdAt: checkpointRow.created_at,
              }),
            };
      const page = packPage(budget, checkpointPackable, rows.map((row) => itemPackable(row, citations.get(row.id) ?? [], sources.get(row.id) ?? null)));

      // Resume at the first unconsumed row; records dropped as ineligible leave the sequence.
      const next = rows[page.consumed];
      const remaining = next === undefined ? sequence.slice(window.length) : sequence.slice(sequence.indexOf(next.seq));
      const omissions: Omission[] = [];
      if (page.oversized.length > 0) omissions.push({ reason: "exceeds_budget", count: page.oversized.length, recordIds: page.oversized });
      if (remaining.length > 0) omissions.push({ reason: "budget", count: remaining.length });
      if (beyondCap > 0) omissions.push({ reason: "candidate_limit", count: beyondCap });
      const truncated = omissions.length > 0 || page.checkpoint?.truncated === true;
      const empty = page.checkpoint === null && page.items.length === 0 && omissions.length === 0;

      let notice: string | null = null;
      if (empty) {
        notice =
          continued === null && query === null
            ? "No memory has been recorded for this workstream yet. There is no prior context; do not assume any."
            : "No eligible memory matches this request. Nothing is known about it; do not assume prior context.";
      } else if (truncated) {
        notice =
          beyondCap > 0 && remaining.length === 0
            ? `More than ${SEQUENCE_CAP} records match; only the top ${SEQUENCE_CAP} are sequenced. Refine the query to see the rest.`
            : "Budget reached before all eligible memory was returned. Pass `continuation` for more, or read a recordId to expand it.";
      }

      return {
        scope: view,
        checkpoint: page.checkpoint,
        items: page.items,
        omissions,
        truncated,
        continuation:
          remaining.length > 0
            ? sealContinuation(scope.continuationSecret, {
                workspaceId: scope.workspaceId,
                workstreamId: scope.workstreamId,
                query,
                kinds: sequenceKinds,
                remaining,
                beyondCap,
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

function itemPackable(row: Candidate, citations: Citation[], source: ImportedSource | null): Packable<PackItem> {
  const fields = recordFields(row);
  return {
    recordId: row.id,
    source: row.excerpt_source,
    maxExcerptBytes: ITEM_EXCERPT_BYTES,
    build: (excerpt, truncated) => ({
      recordId: row.id,
      kind: fields.kind,
      title: row.title,
      excerpt,
      truncated: truncated || row.excerpt_source !== row.body,
      attribution: fields.attribution,
      reviewState: fields.reviewState,
      freshness: fields.freshness,
      applicability: fields.applicability,
      citations,
      externalRefs: fields.externalRefs,
      workspaceLevel: fields.workspaceLevel,
      host: row.host,
      source,
      createdAt: row.created_at,
    }),
  };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function loadHeadCheckpoint(db: Db, workstreamId: string): RecordRow | null {
  const recordId = headCheckpointRecordId(db, workstreamId);
  return recordId === null ? null : requireVisibleRecord(db, workstreamId, recordId);
}

function scopeView(db: Db, scope: BoundScope): Scope {
  return {
    workspaceId: scope.workspaceId,
    workspaceLabel: scope.workspaceLabel,
    workstreamId: scope.workstream?.id ?? null,
    workstreamLabel: scope.workstream?.label ?? null,
    taskKey: scope.workstream?.taskKey ?? null,
    resolvedBy: scope.resolvedBy,
    ambiguity: scope.ambiguity,
    branch: scope.branch,
    worktree: scope.worktree,
    headRevision: scope.workstream === null ? 0 : headRevision(db, scope.workstream.id),
    sessionId: scope.sessionId,
    host: scope.host,
  };
}

/** While no workstream is bound, a pack says why it holds only workspace-level memory. */
function withScopeNotice(scope: BoundScope, pack: ContextPack): ContextPack {
  if (scope.ambiguity === null) return pack;
  const why =
    "No workstream is bound yet (scope.ambiguity lists the candidates), so this holds only workspace-level memory. Ask the user which workstream to continue, then call memory_bootstrap with workstream set to its id or \"new\".";
  return { ...pack, notice: pack.empty || pack.notice === null ? why : `${why} ${pack.notice}` };
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
