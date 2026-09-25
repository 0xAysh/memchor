import { createHash } from "node:crypto";
import { ZodError, type z } from "zod";
import {
  bindScope,
  type BoundScope,
  previewScope,
  requireWorkstream,
  type ResolutionBasis,
  type ResolutionPreview,
  type ScopeAmbiguity,
  type ScopeHints,
} from "./bootstrap/workstream-resolution.js";
import { headCommit, locateWorkspace, registerWorkspace, resolveHome, type WorkspaceLocation } from "./bootstrap/workspace-resolution.js";
import { type ErrorCode, MemchorError } from "./errors.js";
import { headCheckpointRecordId, headRevision, publishCheckpoint } from "./integrity/checkpoints.js";
import {
  type Affected,
  changeClaim,
  changesSince,
  confirmForget,
  type CorrectionNotice,
  type ForgetImpact,
  type ForgetTarget,
  type HistoryEntry,
  inspectRecord,
  lifecycleWatermark,
  openWorkspaceDatabase,
  previewForget,
  type Related,
  restoreClaim,
  type RestoreResult,
} from "./integrity/lifecycle.js";
import { hostDescriptor } from "./hosts.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";
import { type ImportStatus, TranscriptImporter, unsupportedHostStatus } from "./import/reconcile.js";
import { type Citation, citationsFor, importedFrom, type ImportedSource, independentRoots, linksOf } from "./integrity/provenance.js";
import {
  type ClaimGroup,
  type ContinuationState,
  CUT_MARKER,
  EMPTY_PAGE,
  groupClaims,
  ITEM_EXCERPT_BYTES,
  LISTED_COPIES,
  normalizeClaim,
  openContinuation,
  packPage,
  type PackedPage,
  packWithinBudget,
  planPage,
  type Packable,
  sealContinuation,
  usage,
} from "./retrieval/context-pack.js";
import { isEligible, type Lifecycle, requireVisibleRecord, type RecordRow, type Taint } from "./retrieval/eligibility.js";
import { captureObservations, type CheckedRef, checkFreshness, freshnessFloor, type RecordFreshness, type StoredRef } from "./retrieval/freshness.js";
import { type Candidate, clipToBytes, loadCandidates, PAGE_CANDIDATES, rankSequence, rebuildSearchIndex, SEQUENCE_CAP, toFtsQuery } from "./retrieval/search.js";
import {
  type Applicability,
  type Attribution,
  BootstrapInput,
  CheckpointInput,
  ContinueImportInput,
  effectiveBudget,
  type Freshness,
  LIMITS,
  type LinkRelation,
  ManageInput,
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
  openReadOnly,
  probeRuntime,
  type RuntimeReport,
  SCHEMA_VERSION,
  toStorageError,
  writeTransaction,
} from "./storage/database.js";
import { appendRecord, recordFields } from "./storage/records.js";

export type { ImportedSource, Citation } from "./integrity/provenance.js";
export type { CheckedRef, FreshnessReason } from "./retrieval/freshness.js";
export type { ImportCounters, ImportGap, ImportStatus } from "./import/reconcile.js";
export type { IntegrityReport } from "./storage/database.js";
export type { CandidateSignal, ResolutionBasis, ScopeAmbiguity, WorkstreamCandidate } from "./bootstrap/workstream-resolution.js";
export type { CheckpointSummary } from "./integrity/checkpoints.js";
export type { Affected, CorrectionNotice, ForgetImpact, ForgetTarget, HistoryEntry, LifecycleChange, Related } from "./integrity/lifecycle.js";
export type { Lifecycle, Taint } from "./retrieval/eligibility.js";

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
  /** Codex's home directory (rollouts live in its `sessions/` and `archived_sessions/`). Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
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
  /**
   * A passage of the body (the best-matching one for a query). Use `read` for the rest.
   * A passage cut to fit the budget ends with an explicit "cut by Memchor" marker.
   */
  excerpt: string;
  /** True when `excerpt` is not the whole body. */
  truncated: boolean;
  attribution: Attribution;
  reviewState: ReviewState;
  /**
   * Checked now, against the live worktree: the worst of `externalRefs` (stale > unknown >
   * current); "unknown" for a record without references. Memory never replaces live code.
   */
  freshness: Freshness;
  /** What to do before relying on this record (read the current file, verify remote state); null when every reference is current or there are none. */
  warning: string | null;
  applicability: Applicability;
  citations: Citation[];
  /** Each reference with its own freshness and reason (see `FreshnessReason`). */
  externalRefs: CheckedRef[];
  workspaceLevel: boolean;
  host: string;
  /** Memchor session that wrote (or imported) the record. */
  sessionId: string | null;
  /** Where an imported record came from (host, transcript, event); null for records agents wrote. */
  source: ImportedSource | null;
  /** When the content was observed (the event time for imported records). */
  createdAt: string;
  /**
   * The observation this claim comes from: `event:<host>/<eventId>` for imported records
   * (shared by every transcript copy of that event), else `record:<recordId>` of the
   * record it was derived from or rests on, else its own.
   */
  independentRoot: string;
  /**
   * `independentRoots`: distinct roots among the loaded records stating this same claim;
   * `records`: how many records state it. Copies of one root never count twice.
   */
  corroboration: { independentRoots: number; records: number };
  /** Other records with the same claim and root, collapsed into this item (at most 5 listed). */
  copies: PackCopy[];
}

/** A record folded into an item because it repeats the item's claim from the same root. */
export interface PackCopy {
  recordId: string;
  host: string;
  sessionId: string | null;
  source: ImportedSource | null;
  createdAt: string;
}

export interface PackCheckpoint {
  recordId: string;
  revision: number;
  excerpt: string;
  truncated: boolean;
  freshness: Freshness;
  warning: string | null;
  citations: Citation[];
  externalRefs: CheckedRef[];
  host: string;
  sessionId: string | null;
  createdAt: string;
}

export interface Omission {
  /**
   * `budget`: more of the sequence follows (use `continuation`).
   * `exceeds_budget`: records too large for this budget even alone (read them directly); at most 5 per page, later ones on continuation pages.
   * `candidate_limit`: eligible matches the sequence does not carry: beyond the 500-record cap, or more than a continuation can hold within this budget (at most a quarter of it). Refine the query or raise the budget.
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
  /** `usedBytes` is the UTF-8 length of this whole pack as JSON, scope and continuation included; it exceeds `maxBytes` only when the budget cannot hold the scope itself (then the pack has no entries and says so). */
  budget: { maxTokens: number; maxBytes: number; usedTokens: number; usedBytes: number };
  /** True when nothing eligible was found: an honest miss, not a reason to invent continuity. */
  empty: boolean;
  notice: string | null;
  /**
   * Set when memory in this scope was corrected, superseded, retracted, restored or forgotten
   * since this session's previous pack: do not rely on the listed records any more, even if
   * you read them earlier. Each change is reported once per session.
   */
  corrections: CorrectionNotice | null;
}

export interface BootstrapResult {
  scope: Scope;
  /** Whether this instance's binding created the workspace database / workstream. */
  created: { workspace: boolean; workstream: boolean };
  runtime: { sqliteVersion: string; fts5: boolean; schemaVersion: number };
  /** Transcript import: the consent question on first use, else progress and capture gaps. */
  import: ImportStatus;
  /** Same as `recall({ maxTokens, maxBytes })` after this bootstrap's import: head checkpoint plus the most recent eligible records. */
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
  /** Checked now against the live worktree, as in a pack item. */
  freshness: Freshness;
  warning: string | null;
  applicability: Applicability;
  externalRefs: CheckedRef[];
  independentRoot: string;
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

/** One record as `memory_manage` inspect shows it, whatever its lifecycle. */
export interface InspectedRecord {
  recordId: string;
  kind: RecordKind;
  title: string | null;
  /** Up to 4 KB of the body; `memory_read` pages through an eligible record's whole body. */
  body: string;
  truncated: boolean;
  attribution: Attribution;
  reviewState: ReviewState;
  /** The claim's own state (see docs/architecture.md, "Memory lifecycle"). */
  lifecycle: Lifecycle;
  /** Whether it is current guidance: active and not tainted by another record. */
  eligible: boolean;
  /** Why an active record is still not current: the records it restates (invalidated) or rests on (quarantined). */
  taints: { causeId: string; taint: Taint }[];
  workspaceLevel: boolean;
  host: string;
  sessionId: string | null;
  source: ImportedSource | null;
  createdAt: string;
  applicability: Applicability;
  freshness: Freshness;
  warning: string | null;
  externalRefs: CheckedRef[];
}

export type ManageResult =
  | {
      v: 1;
      action: "inspect";
      record: InspectedRecord;
      /** Lifecycle changes of this record, oldest first (the last 20). */
      history: HistoryEntry[];
      /** The correction or new version that replaced it. */
      replacement: { recordId: string; kind: RecordKind; excerpt: string; lifecycle: Lifecycle; eligible: boolean } | null;
      /** What it rests on or restates. */
      evidence: Related[];
      /** Other versions of the same transcript event, and loosely related records. */
      conflicts: Related[];
      /** Known downstream derivations, with the taint this record put on each (null if none). */
      derivations: (Related & { taint: Taint | null })[];
      counts: { evidence: number; conflicts: number; derivations: number; history: number };
    }
  | { v: 1; action: "correct"; recordId: string; replacementId: string; affected: Affected; watermark: number; replayed: boolean }
  | { v: 1; action: "supersede"; recordId: string; replacementId: string; affected: Affected; watermark: number; replayed: boolean }
  | { v: 1; action: "retract"; recordId: string; affected: Affected; watermark: number; replayed: boolean }
  | { v: 1; action: "restore"; recordId: string; affected: RestoreResult["affected"]; watermark: number; replayed: boolean }
  | {
      v: 1;
      action: "forget_preview";
      /** The records named, as they are now. */
      targets: ForgetTarget[];
      impact: ForgetImpact;
      /** Pass to `forget` only after the user confirmed this impact; it is refused if the impact changes. */
      confirmToken: string;
      expiresAt: string;
      notice: string;
    }
  | { v: 1; action: "forget"; forgotten: string[]; affected: Affected; watermark: number; replayed: boolean };

export interface StatusScope {
  workspaceId: string;
  workspaceLabel: string;
  worktree: string;
  branch: string;
  /** Null when bootstrap would create a new workstream (`resolvedBy: "new_workstream"`) or ask (`ambiguity`). */
  workstreamId: string | null;
  workstreamLabel: string | null;
  taskKey: string | null;
  /**
   * The signal bootstrap would bind by. Null while ambiguous; after a repository move, until a
   * bootstrap re-points the moved worktree bindings (previewing against the old paths would
   * disagree with what bootstrap then binds); while a schema migration is pending (the next
   * bootstrap migrates first); and when the database cannot be read or is newer than this Memchor.
   */
  resolvedBy: ResolutionBasis | null;
  /** The candidates bootstrap would ask the user to choose from, exactly as it would list them. */
  ambiguity: ScopeAmbiguity | null;
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
  /** What bootstrap (without `task` or `workstream`) would resolve, by the same rules, without binding anything. */
  scope: StatusScope | null;
  counts: { records: number; checkpoints: number; workstreams: number; sessions: number } | null;
  /** Set when scope or storage could not be resolved; status itself never throws for these. */
  problem: { code: ErrorCode; message: string } | null;
  /** `freshnessValidation`: recall and read check local code references against the live worktree. */
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
 * - **Recall filters before ranking** and the whole pack stays within its budget (unless the budget cannot hold even its scope).
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
   * Inspects, corrects, supersedes, retracts or restores one claim in this scope. Each change
   * is one transaction that also takes every dependent out of (or back into) current guidance
   * and records an attributed audit entry; see src/integrity/lifecycle.ts.
   */
  manage(input: ManageInput): ManageResult;
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
/** A result before `idempotent` adds `replayed` (distributes over union members). */
type Unreplayed<T> = T extends unknown ? Omit<T, "replayed"> : never;
const INSPECT_BODY_BYTES = 4_096;
const FORGET_NOTICE =
  "Nothing has been removed yet. Show the user the targets and the impact, and ask them to confirm explicitly; only then call memory_manage with action forget and this confirmToken. Forgetting cannot be undone. Records listed as invalidated or quarantined keep their own content (forget them too if the user wants). Host transcripts, loaded model contexts, exports and backups are not erased.";
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
  /** The newest lifecycle change this session has been told about (the correction watermark). */
  private seenLifecycle = 0;
  /** Null for hosts without a transcript adapter. */
  private readonly importer: TranscriptImporter | null;

  constructor(options: OpenMemoryOptions) {
    this.cwd = options.cwd;
    this.host = options.host.trim().slice(0, LIMITS.hostChars) || "unknown";
    this.home = resolveHome(options.home);
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.hostSessionId = options.hostSessionId;
    const adapter = options.transcriptAdapter ?? hostDescriptor(this.host)?.transcripts?.(options) ?? null;
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
        context: this.pack(db, scope, parse(RecallInput, { ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }), ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }) })),
      };
    });
  }

  record(input: RecordInput): RecordResult {
    return this.guard(() => {
      const parsed = parse(RecordInput, input);
      const { db, scope } = this.bind();
      if (!parsed.workspaceLevel) requireWorkstream(scope, "memory_record");
      const applicability = withHeadCommit(parsed.applicability, scope.worktree);
      // Observed outside the write transaction (Git and file reads must not hold the lock),
      // and not part of the idempotency hash, which covers only what the caller sent.
      const externalRefs = captureObservations(scope.worktree, parsed.externalRefs);
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
          externalRefs,
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
      const externalRefs = captureObservations(scope.worktree, parsed.externalRefs);
      // Replay is checked before the revision compare, so retrying a checkpoint that
      // already succeeded returns its result instead of a spurious conflict.
      return this.idempotent(db, scope, "checkpoint", parsed, () =>
        publishCheckpoint(db, scope, parsed.expectedRevision, { ...parsed, externalRefs }, applicability),
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
      return this.pack(db, scope, parsed);
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
        const source = importedFrom(db, [row.id]).get(row.id) ?? null;
        const fields = recordFields(row);
        const checked = checkFreshness(scope.worktree, [{ recordId: row.id, refs: fields.externalRefs, imported: source !== null }]).get(row.id);
        return {
          recordId: row.id,
          title: row.title,
          body,
          offset,
          nextOffset,
          truncated: nextOffset !== null,
          totalLength: row.body.length,
          ...fields,
          freshness: checked?.freshness ?? "unknown",
          warning: checked?.warning ?? null,
          externalRefs: checked?.externalRefs ?? [],
          independentRoot: rootOf(independentRoots(db, scope.workstreamId, [row.id]), row.id),
          links: linksOf(db, scope.workstreamId, row.id),
          checkpointRevision: revision?.revision ?? null,
          host: row.host,
          sessionId: row.session_id,
          source,
          contentHash: row.content_hash,
          createdAt: row.created_at,
          budget: { ...budget, ...usage(Buffer.byteLength(body, "utf8")) },
        };
      })();
    });
  }

  manage(input: ManageInput): ManageResult {
    return this.guard(() => {
      const parsed = parse(ManageInput, input);
      const { db, scope } = this.bind();
      const recordId = parsed.recordId ?? "";
      const action = parsed.action;
      if (action === "inspect") return this.inspect(db, scope, recordId);
      const key = { secret: scope.continuationSecret, workspaceId: scope.workspaceId, workstreamId: scope.workstreamId };
      if (action === "forget_preview") {
        const preview = db.transaction(() => previewForget(db, scope, key, parsed.recordIds ?? []))();
        return { v: 1, action, ...preview, notice: FORGET_NOTICE };
      }
      const actor = { sessionId: scope.sessionId, host: scope.host, attribution: parsed.attribution ?? "user_direction", reason: parsed.reason ?? "" };
      const applicability = withHeadCommit({}, scope.worktree);
      const own = { onlyChange: false };
      const result = this.idempotent(db, scope, "manage", parsed, (): Unreplayed<Exclude<ManageResult, { action: "inspect" | "forget_preview" }>> => {
        own.onlyChange = lifecycleWatermark(db) === this.seenLifecycle;
        if (action === "restore") return { v: 1, action: "restore", ...restoreClaim(db, scope, { recordId, actor }) };
        if (action === "forget") return { v: 1, action: "forget", ...confirmForget(db, scope, key, { confirmToken: parsed.confirmToken ?? "", actor }) };
        const changed = changeClaim(db, scope, { action, recordId, ...(parsed.body === undefined ? {} : { body: parsed.body }), applicability, actor });
        const { replacementId, ...rest } = changed;
        return action === "retract" || replacementId === null ? { v: 1, action: "retract", ...rest } : { v: 1, action, ...rest, replacementId };
      });
      // This session made the change itself; it needs no notice of it unless others came first.
      if (!result.replayed && own.onlyChange) this.seenLifecycle = result.watermark;
      return result;
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
        capabilities: { operations: OPERATIONS, freshnessValidation: true, transcriptImport: this.importer !== null },
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
          taskKey: null,
          resolvedBy: null,
          ambiguity: null,
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
          // No database yet: the first bootstrap can only start a new workstream.
          result.scope.resolvedBy = "new_workstream";
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
        // A bound instance keeps its workstream (bootstrap re-resolves it only while ambiguous);
        // otherwise preview the resolution bootstrap would run, with this instance's session.
        const bound = this.bound?.scope;
        const resolution: ResolutionPreview | null =
          bound?.workstream != null && bound.resolvedBy !== null
            ? { status: "bound", workstream: bound.workstream, basis: bound.resolvedBy }
            : previewScope(db, location, { host: this.host, hostSessionId: this.hostSessionId, ...(bound === undefined ? {} : { sessionId: bound.sessionId }) });
        if (resolution?.status === "ambiguous") {
          result.scope.ambiguity = resolution.ambiguity;
        } else if (resolution !== null) {
          result.scope.resolvedBy = resolution.basis;
          if (resolution.workstream !== null) {
            result.scope.workstreamId = resolution.workstream.id;
            result.scope.workstreamLabel = resolution.workstream.label;
            result.scope.taskKey = resolution.workstream.taskKey;
            result.scope.headRevision = headRevision(db, resolution.workstream.id);
          }
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
    const db = openWorkspaceDatabase(location.dbPath, this.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.busyTimeoutMs });
    try {
      const scope = bindScope(db, location, { host: this.host, hostSessionId: this.hostSessionId }, hints);
      // A new session starts from current memory; only later changes are news to it.
      this.seenLifecycle = lifecycleWatermark(db);
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

  private inspect(db: Db, scope: BoundScope, recordId: string): ManageResult {
    const found = db.transaction(() => {
      const inspection = inspectRecord(db, scope.workstreamId, recordId);
      return { inspection, source: importedFrom(db, [recordId]).get(recordId) ?? null };
    })();
    const { inspection, source } = found;
    const row = inspection.row;
    const fields = recordFields(row);
    const checked = checkFreshness(scope.worktree, [{ recordId: row.id, refs: fields.externalRefs, imported: source !== null }]).get(row.id);
    const body = clipToBytes(row.body, INSPECT_BODY_BYTES);
    return {
      v: 1,
      action: "inspect",
      record: {
        recordId: row.id,
        kind: fields.kind,
        title: row.title,
        body,
        truncated: body.length < row.body.length,
        attribution: fields.attribution,
        reviewState: fields.reviewState,
        lifecycle: inspection.lifecycle,
        eligible: inspection.eligible,
        taints: inspection.taints,
        workspaceLevel: fields.workspaceLevel,
        host: row.host,
        sessionId: row.session_id,
        source,
        createdAt: row.created_at,
        applicability: fields.applicability,
        freshness: checked?.freshness ?? "unknown",
        warning: checked?.warning ?? null,
        externalRefs: checked?.externalRefs ?? [],
      },
      history: inspection.history,
      replacement: inspection.replacement,
      evidence: inspection.evidence,
      conflicts: inspection.conflicts,
      derivations: inspection.derivations,
      counts: inspection.counts,
    };
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
      const head = continued === null ? loadHeadCheckpoint(db, scope.workstreamId) : { row: null, withheld: null };
      const checkpointRow = head.row;
      const corrections = changesSince(db, scope.workstreamId, this.seenLifecycle);
      const window = sequence.slice(0, PAGE_CANDIDATES);
      const rows = loadCandidates(db, { workstreamId: scope.workstreamId, match, seqs: window });
      const citations = citationsFor(db, scope.workstreamId, [...rows.map((r) => r.id), ...(checkpointRow ? [checkpointRow.id] : [])]);
      const sources = importedFrom(db, rows.map((r) => r.id));
      const roots = independentRoots(db, scope.workstreamId, rows.map((r) => r.id));
      const groups = groupClaims(
        rows,
        (row) => normalizeClaim(row.body),
        (row) => rootOf(roots, row.id),
        (a, b) => a.created_at < b.created_at || (a.created_at === b.created_at && a.seq < b.seq),
      );

      const checkpointPackable = (freshness: RecordFreshness): Packable<PackCheckpoint> | null =>
        checkpointRow === null
          ? null
          : {
              recordId: checkpointRow.id,
              source: checkpointRow.body,
              maxExcerptBytes: LIMITS.bodyBytes,
              build: (excerpt, truncated) => ({
                recordId: checkpointRow.id,
                revision: view.headRevision,
                excerpt: truncated ? excerpt + CUT_MARKER : excerpt,
                truncated,
                freshness: freshness.freshness,
                warning: freshness.warning,
                citations: citations.get(checkpointRow.id) ?? [],
                externalRefs: freshness.externalRefs,
                host: checkpointRow.host,
                sessionId: checkpointRow.session_id,
                createdAt: checkpointRow.created_at,
              }),
            };
      const itemPackables = (count: number, freshnessOf: (row: Candidate) => RecordFreshness): Packable<PackItem>[] =>
        groups.slice(0, count).map((group) => itemPackable(group, freshnessOf(group.representative), citations, sources, roots));

      // Resume at the first unconsumed group. Copies folded into a returned item leave the
      // sequence with it; records dropped as ineligible leave it too.
      const loaded = new Set(rows.map((row) => row.seq));
      const windowed = new Set(window);
      const remainingAfter = (page: PackedPage<PackCheckpoint, PackItem>): number[] => {
        const consumed = new Set(groups.slice(0, page.consumed).flatMap((group) => [group.representative, ...group.copies].map((row) => row.seq)));
        return sequence.filter((seq) => (windowed.has(seq) ? loaded.has(seq) && !consumed.has(seq) : true));
      };
      // The whole pack for a page: the budget covers all of it (see context-pack.ts).
      const assemble = (page: PackedPage<PackCheckpoint, PackItem>, carry: number, starved: boolean): ContextPack => {
        const remaining = remainingAfter(page);
        const carried = remaining.slice(0, carry);
        const uncarried = beyondCap + remaining.length - carried.length;
        const omissions: Omission[] = [];
        if (page.oversized.length > 0) omissions.push({ reason: "exceeds_budget", count: page.oversized.length, recordIds: page.oversized });
        if (carried.length > 0) omissions.push({ reason: "budget", count: carried.length });
        if (uncarried > 0) omissions.push({ reason: "candidate_limit", count: uncarried });
        const truncated = omissions.length > 0 || page.checkpoint?.truncated === true;
        const empty = page.checkpoint === null && page.items.length === 0 && omissions.length === 0;
        let notice: string | null = null;
        const withheld =
          head.withheld === null
            ? null
            : `The head checkpoint r${view.headRevision} ${head.withheld === "quarantined" || head.withheld === "invalidated" ? `is ${head.withheld} (it rests on or repeats memory that is no longer current)` : `was ${head.withheld}`}, so it is not returned. Use what remains, then publish a new checkpoint with expectedRevision ${view.headRevision}.`;
        if (starved) {
          notice = "This budget is too small for even the pack's scope and envelope, so nothing was returned. Recall again with a larger maxBytes/maxTokens.";
        } else if (empty && withheld !== null) {
          notice = withheld;
        } else if (empty) {
          notice =
            continued === null && query === null
              ? "No memory has been recorded for this workstream yet. There is no prior context; do not assume any."
              : "No eligible memory matches this request. Nothing is known about it; do not assume prior context.";
        } else if (truncated) {
          notice =
            uncarried > 0 && carried.length === 0
              ? `${uncarried} more eligible record${uncarried === 1 ? "" : "s"} match than this sequence carries (at most ${SEQUENCE_CAP} are sequenced, fewer when a small budget limits the continuation). Refine the query, or recall with a larger budget.`
              : "Budget reached before all eligible memory was returned. Pass `continuation` for more, or read a recordId to expand it.";
        }
        return {
          scope: view,
          checkpoint: page.checkpoint,
          items: page.items,
          omissions,
          truncated,
          continuation:
            carried.length > 0
              ? sealContinuation(scope.continuationSecret, {
                  workspaceId: scope.workspaceId,
                  workstreamId: scope.workstreamId,
                  query,
                  kinds: sequenceKinds,
                  remaining: carried,
                  beyondCap: uncarried,
                })
              : null,
          budget: { ...budget, usedBytes: 0, usedTokens: 0 },
          empty,
          notice: withScopeNotice(scope, withheld !== null && notice !== withheld && !starved ? (notice === null ? withheld : `${withheld} ${notice}`) : notice, empty),
          corrections,
        };
      };
      const plan = planPage(budget.maxBytes, assemble, (page) => remainingAfter(page).length);

      // Two passes keep validation to what the budget can return. The first selects with
      // the smallest annotation freshness could produce; only that prefix is checked
      // against the live worktree; the second packs the prefix with the real annotations,
      // which can only shrink it, so no unchecked record is ever returned.
      const refsOf = (row: RecordRow): StoredRef[] => recordFields(row).externalRefs;
      const selection =
        plan === null
          ? EMPTY_PAGE
          : packPage(
              plan,
              checkpointPackable(freshnessFloor(checkpointRow === null ? [] : refsOf(checkpointRow))),
              itemPackables(groups.length, (row) => freshnessFloor(refsOf(row))),
            );
      const selected = groups.slice(0, selection.consumed).map((group) => group.representative);
      const checked = checkFreshness(scope.worktree, [
        ...(checkpointRow === null ? [] : [{ recordId: checkpointRow.id, refs: refsOf(checkpointRow), imported: false }]),
        ...selected.map((row) => ({ recordId: row.id, refs: refsOf(row), imported: sources.has(row.id) })),
      ]);
      const freshnessOf = (row: RecordRow): RecordFreshness => {
        const result = checked.get(row.id);
        if (result === undefined) throw new Error(`record ${row.id} was packed without a freshness check`);
        return result;
      };
      const packed = packWithinBudget(
        budget.maxBytes,
        plan,
        checkpointRow === null ? null : checkpointPackable(freshnessOf(checkpointRow)),
        itemPackables(selection.consumed, freshnessOf),
        assemble,
        (page) => remainingAfter(page).length,
      );
      if (corrections !== null) this.seenLifecycle = Math.max(this.seenLifecycle, corrections.watermark);
      return packed;
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

/**
 * One pack entry per claim group. Everything but the excerpt (freshness, warning,
 * citations, provenance, copies) is fixed-size metadata that `fit` measures first, so
 * a tight budget cuts the body, never the warnings or citations.
 */
function itemPackable(
  group: ClaimGroup<Candidate>,
  freshness: RecordFreshness,
  citations: ReadonlyMap<string, Citation[]>,
  sources: ReadonlyMap<string, ImportedSource>,
  roots: ReadonlyMap<string, string>,
): Packable<PackItem> {
  const row = group.representative;
  const fields = recordFields(row);
  const copies = group.copies.slice(0, LISTED_COPIES).map((copy) => ({
    recordId: copy.id,
    host: copy.host,
    sessionId: copy.session_id,
    source: sources.get(copy.id) ?? null,
    createdAt: copy.created_at,
  }));
  return {
    recordId: row.id,
    source: row.excerpt_source,
    maxExcerptBytes: ITEM_EXCERPT_BYTES,
    build: (excerpt, cut) => ({
      recordId: row.id,
      kind: fields.kind,
      title: row.title,
      excerpt: cut ? excerpt + CUT_MARKER : excerpt,
      truncated: cut || row.excerpt_source !== row.body,
      attribution: fields.attribution,
      reviewState: fields.reviewState,
      freshness: freshness.freshness,
      warning: freshness.warning,
      applicability: fields.applicability,
      citations: citations.get(row.id) ?? [],
      externalRefs: freshness.externalRefs,
      workspaceLevel: fields.workspaceLevel,
      host: row.host,
      sessionId: row.session_id,
      source: sources.get(row.id) ?? null,
      createdAt: row.created_at,
      independentRoot: rootOf(roots, row.id),
      corroboration: { independentRoots: group.independentRoots, records: group.records },
      copies,
    }),
  };
}

/**
 * A record's independent root. `independentRoots` answers for every id it is given (its own
 * `record:<id>` when nothing else applies), so a missing entry is a bug to surface, not a
 * record to quietly present as its own observation.
 */
function rootOf(roots: ReadonlyMap<string, string>, recordId: string): string {
  const root = roots.get(recordId);
  if (root === undefined) throw new Error(`no independent root was computed for ${recordId}`);
  return root;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * The head checkpoint, or why it is withheld: a head that was retracted, or that rests on or
 * repeats memory that is no longer current, is not current guidance either.
 */
function loadHeadCheckpoint(db: Db, workstreamId: string): { row: RecordRow | null; withheld: Lifecycle | Taint | null } {
  const recordId = headCheckpointRecordId(db, workstreamId);
  if (recordId === null) return { row: null, withheld: null };
  const row = db.prepare("SELECT * FROM records WHERE id = ?").get(recordId) as RecordRow;
  if (isEligible(db, row)) return { row, withheld: null };
  if (row.lifecycle !== "active") return { row: null, withheld: row.lifecycle };
  const taint = db.prepare("SELECT taint FROM taints WHERE record_id = ? ORDER BY taint LIMIT 1").get(recordId) as { taint: Taint };
  return { row: null, withheld: taint.taint };
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
function withScopeNotice(scope: BoundScope, notice: string | null, empty: boolean): string | null {
  if (scope.ambiguity === null) return notice;
  const why =
    "No workstream is bound yet (scope.ambiguity lists the candidates), so this holds only workspace-level memory. Ask the user which workstream to continue, then call memory_bootstrap with workstream set to its id or \"new\".";
  return empty || notice === null ? why : `${why} ${notice}`;
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
