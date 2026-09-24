import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { relative, sep } from "node:path";
import { ensureWorkspace, ensureWorkstream } from "../bootstrap/workstream-resolution.js";
import { locateWorkspace, registerWorkspace, type WorkspaceLocation } from "../bootstrap/workspace-resolution.js";
import { type ErrorCode, MemchorError } from "../errors.js";
import { type ExternalRef, IMPORT_CHOICES, type ImportChoice } from "../schemas.js";
import { type Db, openDatabase, prepared, toStorageError, writeTransaction } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";
import { approves, type Consent, readConsent, writeConsent } from "./consent.js";
import type { CompatibilityRow, ExclusionReason, NormalizedEvent, OutputPolicy, TranscriptAdapter, TranscriptFile } from "./normalized-event.js";
import { boundPassage, PASSAGE_LIMITS, redactSecrets, touchesSensitivePath } from "./privacy.js";

/**
 * Transcript import: approved host history → attributed evidence in the right workspace.
 *
 * Callers see three operations — {@link TranscriptImporter.bootstrap} (record a choice, import
 * the current project within a time budget), {@link TranscriptImporter.continue} (keep going
 * with every approved project) and {@link TranscriptImporter.status} — and nothing about
 * cursors, batches, identities or transactions, which are this module's business:
 *
 * - **One transaction per batch.** Records, their links and search chunks, the event-identity
 *   rows and the cursor advance commit together (`BEGIN IMMEDIATE`). A crash mid-batch leaves
 *   the cursor where the last committed batch put it, so the retry re-reads the same lines.
 * - **Compare-and-swap cursor.** A batch re-reads the cursor inside its transaction and gives
 *   up if another process moved it, so concurrent importers never double-import.
 * - **Stable identities.** Every event is keyed by host + transcript + branch + event id, plus
 *   its content hash. A replay is a no-op; a changed event becomes an explicit new version
 *   (linked `related_to` the old record and counted as a conflict), never a silent overwrite.
 * - **Reconciliation.** Unchanged file → skip. Grown file whose bytes before the cursor still
 *   match (`anchor_hash`) → append. Anything else (rewritten, truncated) → a new pass from the
 *   start under a new epoch; events not seen again are counted as `missing`, never deleted.
 * - **Scope.** A transcript belongs to the workstream bound to the worktree of its first event
 *   (creating the binding exactly as a live bootstrap would). An event from another worktree
 *   or repository, or a Memchor echo naming a different existing workstream, is a conflicting
 *   signal: the transcript is quarantined from that event on (`scope_ambiguous`), its cursor
 *   held there, and nothing past it is imported.
 * - **No network, no model.** Only the transcript files, `git` and SQLite are touched.
 */

export interface ImportGap {
  transcriptId: string;
  /** Set for gaps in another approved project (reported by this process after backfilling it). */
  workspace?: string;
  reason: "unsupported_version" | "scope_ambiguous";
  message: string;
  hostVersion?: string;
  cwd?: string;
}

export interface ImportCounters {
  /** Normalized events read (messages, tool calls and results, host summaries). */
  events: number;
  records: number;
  /** Events already imported with identical content (replays), skipped. */
  replayed: number;
  /** Events whose content changed since they were imported; kept as a new, linked version. */
  conflicts: number;
  /** Previously imported events absent after a rewrite; their records are kept. */
  missing: number;
  /** Memchor's own tool output seen in transcripts: never evidence; only its record references are kept. */
  echoes: number;
  echoReferences: number;
  redactions: number;
  /** Passages kept as head + tail with an omission marker. */
  clipped: number;
  /** Tool outputs withheld because the call touched a sensitive path. */
  withheld: number;
  /** File reads/edits stored as references only (the file content was dropped). */
  fileContents: number;
  rewrites: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

export interface ImportStatus {
  host: string;
  /**
   * unsupported_host: no transcript adapter for this host · consent_required: ask the user
   * `question` and call bootstrap with `importChoice` · declined: the choice is `none` ·
   * not_approved: this repository is not among the approved projects · in_progress: approved
   * history remains · complete: every approved transcript this process knows of is reconciled ·
   * unavailable: the decision or inventory could not be read (see `problem`); nothing was imported.
   */
  state: "unsupported_host" | "unavailable" | "consent_required" | "declined" | "not_approved" | "in_progress" | "complete";
  consent: Consent | null;
  /** Set only while consent is required: the exact question to put to the user. */
  question: string | null;
  choices: ImportChoice[] | null;
  transcriptsRoot: string | null;
  compatibility: readonly CompatibilityRow[];
  /** Everything discovered (metadata only; no content is read before consent). Null when not inventoried (declined). */
  transcripts: { found: number; currentProject: number; otherProjects: number; unassigned: number; unsupportedVersion: number } | null;
  /** This repository's transcripts (all worktrees). */
  currentProject: { transcripts: number; complete: number; pending: number; stopped: number; quarantined: number; counters: ImportCounters } | null;
  /** Other approved projects: how many, and whether this process has reconciled them yet. */
  backfill: { projects: number; transcripts: number; reconciled: boolean } | null;
  gaps: ImportGap[];
  /**
   * Why this import step failed, if it did (e.g. `storage_busy`, or an unreadable consent
   * file). A failed batch was rolled back; memory stays usable and the next step retries
   * from the same cursor.
   */
  problem: { code: ErrorCode; message: string } | null;
}

export interface CurrentWorkspace {
  location: WorkspaceLocation;
  /** The bound, migrated database; null only for read-only status on a missing or unmigrated file. */
  db: Db | null;
}

export interface ImporterOptions {
  home: string;
  adapter: TranscriptAdapter;
  busyTimeoutMs?: number;
  /** How long bootstrap may spend importing the current project before returning. */
  bootstrapBudgetMs: number;
}

/** Bytes of transcript read per batch (one transaction). */
const BATCH_BYTES = 1 << 20;
/** Bytes hashed before the cursor to detect a rewrite. */
const ANCHOR_BYTES = 4096;

/** A resolved workspace a transcript can be imported into. */
type Target = WorkspaceLocation & { registered: boolean };

interface Discovered {
  file: TranscriptFile;
  cwd: string | null;
  supported: boolean;
  target: Target | null;
}

interface CursorRow {
  path: string;
  source_id: string;
  session_id: string;
  workstream_id: string;
  byte_offset: number;
  anchor_hash: string | null;
  file_size: number;
  file_mtime_ms: number;
  epoch: number;
  state: "active" | "stopped" | "quarantined";
  gap: string | null;
  stats: string;
}

interface CallMeta {
  callId: string;
  tool: string;
  summary: string;
  output: OutputPolicy;
  paths: string[];
  urls: string[];
}

class Contended extends Error {}

export class TranscriptImporter {
  private readonly locations = new Map<string, Target | null>();
  private readonly heads = new Map<string, { size: number; mtimeMs: number; cwd: string | null; supported: boolean }>();
  private readonly others = new Map<string, Db>();
  /** Gaps met while backfilling other projects in this process (their cursors live in other databases). */
  private readonly otherGaps = new Map<string, ImportGap>();
  /** Fingerprint of the other projects' approved transcripts when this process last finished reconciling them. */
  private reconciledOthers: string | null = null;
  private batches = 0;

  constructor(private readonly options: ImporterOptions) {}

  private get host(): string {
    return this.options.adapter.host;
  }

  /** Records `choice` (if given), then imports the current project within the bootstrap budget. */
  bootstrap(current: CurrentWorkspace & { db: Db }, choice: ImportChoice | undefined): ImportStatus {
    let consent: Consent | null = null;
    let entries: Discovered[] | null = null;
    try {
      if (choice !== undefined) writeConsent(this.options.home, this.host, choice, current.location.repositoryKey);
      consent = readConsent(this.options.home, this.host);
      // A declined host's transcripts are not even inventoried.
      if (consent?.choice === "none") return this.report(current, consent, null);
      entries = this.inventory();
      if (approves(consent, current.location.repositoryKey)) {
        this.run(current, this.plan(entries, consent, current, true), Date.now() + this.options.bootstrapBudgetMs);
      }
      return this.report(current, consent, entries);
    } catch (error) {
      return this.failed(current, consent, entries, error);
    }
  }

  /** Continues with every approved transcript until `maxMs` elapse; `done` once nothing approved remains. */
  continue(current: CurrentWorkspace & { db: Db }, maxMs: number): ImportStatus & { done: boolean } {
    let consent: Consent | null = null;
    let entries: Discovered[] | null = null;
    try {
      consent = readConsent(this.options.home, this.host);
      if (consent === null || consent.choice === "none") return { ...this.report(current, consent, null), done: true };
      entries = this.inventory();
      const done = this.run(current, this.plan(entries, consent, current, false), Date.now() + maxMs);
      if (done) this.reconciledOthers = fingerprint(this.approvedOthers(entries, consent, current));
      return { ...this.report(current, consent, entries), done };
    } catch (error) {
      return { ...this.failed(current, consent, entries, error), done: false };
    }
  }

  /** Read-only: consent, inventory and the current project's progress and gaps. */
  status(current: CurrentWorkspace): ImportStatus {
    let consent: Consent | null = null;
    try {
      consent = readConsent(this.options.home, this.host);
      return this.report(current, consent, this.inventory());
    } catch (error) {
      return this.failed(current, consent, null, error);
    }
  }

  /**
   * An expected failure (storage busy/full/unavailable, unreadable consent) becomes
   * `problem` so memory stays usable; anything else is a bug and propagates.
   */
  private failed(current: CurrentWorkspace, consent: Consent | null, entries: Discovered[] | null, error: unknown): ImportStatus {
    const mapped = toStorageError(error);
    if (!(mapped instanceof MemchorError)) throw mapped;
    const problem = { code: mapped.code, message: mapped.message };
    if (consent === null) return { ...unsupportedHostStatus(this.host), state: "unavailable", transcriptsRoot: this.options.adapter.root, compatibility: this.options.adapter.compatibility, problem };
    return { ...this.report(current, consent, entries), problem };
  }

  close(): void {
    for (const db of this.others.values()) db.close();
    this.others.clear();
  }

  // ── discovery ──

  /** Discovered transcripts with the workspace of their first recorded cwd (metadata only). */
  private inventory(): Discovered[] {
    return this.options.adapter.discover().map((file) => {
      let head = this.heads.get(file.path);
      if (head === undefined || head.size !== file.size || head.mtimeMs !== file.mtimeMs) {
        const inspected = this.options.adapter.inspect(file);
        head = { size: file.size, mtimeMs: file.mtimeMs, cwd: inspected.cwd, supported: inspected.supported };
        this.heads.set(file.path, head);
      }
      return { file, cwd: head.cwd, supported: head.supported, target: head.cwd === null ? null : this.locate(head.cwd) };
    });
  }

  /** cwd → workspace, cached per process; null when the directory is gone or not in a Git worktree. */
  private locate(cwd: string): Target | null {
    if (this.locations.has(cwd)) return this.locations.get(cwd) ?? null;
    let location: Target | null = null;
    if (existsSync(cwd)) {
      try {
        location = locateWorkspace(cwd, this.options.home);
      } catch (error) {
        if (!(error instanceof MemchorError && error.code === "scope_unresolved")) throw error;
      }
    }
    this.locations.set(cwd, location);
    return location;
  }

  private approvedOthers(entries: Discovered[], consent: Consent, current: CurrentWorkspace): Discovered[] {
    return entries.filter((e) => e.target !== null && e.target.workspaceId !== current.location.workspaceId && approves(consent, e.target.repositoryKey));
  }

  /** Approved transcripts in import order: the current workspace first, then newest first. */
  private plan(entries: Discovered[], consent: Consent | null, current: CurrentWorkspace, currentOnly: boolean): (Discovered & { target: Target })[] {
    const own = current.location.workspaceId;
    return entries
      .filter((e): e is Discovered & { target: Target } => e.target !== null && approves(consent, e.target.repositoryKey))
      .filter((e) => !currentOnly || e.target.workspaceId === own)
      .sort((a, b) => Number(b.target.workspaceId === own) - Number(a.target.workspaceId === own) || b.file.mtimeMs - a.file.mtimeMs);
  }

  // ── import ──

  /** Imports planned transcripts until the deadline (at least one batch runs). True when all were reconciled. */
  private run(current: CurrentWorkspace & { db: Db }, plan: (Discovered & { target: Target })[], deadline: number): boolean {
    this.batches = 0;
    let complete = true;
    for (const entry of plan) {
      const own = entry.target.workspaceId === current.location.workspaceId;
      const db = own ? current.db : this.openOther(entry.target);
      const outcome = this.importTranscript(db, entry, deadline);
      if (!own) {
        const gap = readCursor(db, this.host, entry.file.transcriptId)?.gap ?? null;
        if (gap === null) this.otherGaps.delete(entry.file.transcriptId);
        else this.otherGaps.set(entry.file.transcriptId, { ...(JSON.parse(gap) as ImportGap), workspace: entry.target.label });
      }
      if (outcome === "deadline") return false;
      if (outcome === "contended") complete = false;
    }
    return complete;
  }

  private openOther(location: Target): Db {
    let db = this.others.get(location.workspaceId);
    if (db === undefined) {
      registerWorkspace(location);
      db = openDatabase(location.dbPath, this.options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.options.busyTimeoutMs });
      this.others.set(location.workspaceId, db);
    }
    return db;
  }

  private importTranscript(db: Db, entry: Discovered & { target: Target }, deadline: number): "done" | "deadline" | "contended" {
    const { file } = entry;
    const cursor = readCursor(db, this.host, file.transcriptId);
    if (cursor?.state === "quarantined") return "done";
    if (cursor?.state === "active" && cursor.path === file.path && cursor.file_size === file.size && cursor.file_mtime_ms === file.mtimeMs) return "done";

    let offset = 0;
    let epoch = 0;
    let rewritten = false;
    if (cursor !== undefined) {
      epoch = cursor.epoch;
      if (file.size >= cursor.byte_offset && anchorOf(file.path, cursor.byte_offset) === cursor.anchor_hash) {
        offset = cursor.byte_offset;
      } else {
        epoch += 1;
        rewritten = true;
      }
    }
    let expected: { offset: number; epoch: number } | null = cursor === undefined ? null : { offset: cursor.byte_offset, epoch: cursor.epoch };
    // What the cursor row says now, as far as this loop knows (it wrote the later versions).
    let known: { state: CursorRow["state"]; finished: boolean } | null = cursor === undefined ? null : { state: cursor.state, finished: cursor.file_size === file.size && cursor.file_mtime_ms === file.mtimeMs };

    for (;;) {
      if (Date.now() >= deadline && this.batches > 0) return "deadline";
      const chunk = this.options.adapter.read(file, offset, BATCH_BYTES);
      const progressed = chunk.end > offset;
      // Nothing complete past the cursor right now (EOF, or a line still being written).
      const caughtUp = chunk.stop === null && (!progressed || chunk.end >= file.size);
      if (!progressed && !rewritten) {
        if (known === null) return "done"; // a new transcript with no complete line yet: nothing to record
        if (chunk.stop === null && known.state === "active" && known.finished) return "done";
        if (chunk.stop !== null && known.state === "stopped") return "done"; // still the same unsupported entry
      }

      // Resolve every cwd the batch mentions before taking the write lock (this may spawn git).
      // No path-prefix shortcut: a directory under the worktree can be a nested worktree,
      // submodule or separate clone, so only Git can say which worktree a cwd belongs to.
      for (const cwd of new Set(chunk.events.map((e) => e.cwd))) this.locate(cwd);

      let next: { offset: number; state: CursorRow["state"]; finished: boolean };
      try {
        next = writeTransaction(db, () => {
          const now = new Date().toISOString();
          const live = readCursor(db, this.host, file.transcriptId);
          const liveKey = live === undefined ? null : { offset: live.byte_offset, epoch: live.epoch };
          if (JSON.stringify(liveKey) !== JSON.stringify(expected)) throw new Contended();
          const scope = live ?? this.openTranscript(db, entry, now);
          const counters = emptyCounters();
          if (rewritten) counters.rewrites = 1;
          addExcluded(counters, chunk.excluded);

          const batch: Batch = {
            db,
            host: this.host,
            hostName: this.options.adapter.displayName,
            transcriptId: file.transcriptId,
            epoch,
            workstreamId: scope.workstream_id,
            sessionId: scope.session_id,
            sourceId: scope.source_id,
            worktree: entry.target.worktree,
            workspaceId: entry.target.workspaceId,
            counters,
            calls: new Map(),
            locate: (cwd) => this.locations.get(cwd) ?? null,
          };
          const quarantine = applyEvents(batch, chunk.events);

          let state: CursorRow["state"] = "active";
          let gap: ImportGap | null = null;
          let newOffset = chunk.end;
          if (quarantine !== null) {
            state = "quarantined";
            newOffset = quarantine.offset;
            gap = { transcriptId: file.transcriptId, reason: "scope_ambiguous", message: quarantine.message, ...(quarantine.cwd === undefined ? {} : { cwd: quarantine.cwd }) };
          } else if (chunk.stop !== null) {
            state = "stopped";
            newOffset = chunk.stop.offset;
            gap = {
              transcriptId: file.transcriptId,
              reason: "unsupported_version",
              hostVersion: chunk.stop.hostVersion,
              message: `${this.options.adapter.displayName} ${chunk.stop.hostVersion} is not in Memchor's compatibility table; this transcript is imported up to that entry and will resume once a Memchor that supports it is installed.`,
            };
          }
          if (state === "active" && caughtUp && epoch > 0) {
            counters.missing = (
              db
                // An identity is missing when no version of it was seen in this pass; an edited
                // event's older version was superseded, not lost.
                .prepare(
                  `SELECT count(*) AS n FROM (SELECT 1 FROM import_events WHERE host = ? AND transcript_id = ? AND disposition = 'record'
                   GROUP BY branch, event_id HAVING max(seen_epoch) < ?)`,
                )
                .get(this.host, file.transcriptId, epoch) as { n: number }
            ).n;
          }
          const stats = mergeCounters(live === undefined ? emptyCounters() : parseCounters(live.stats), counters, epoch > (live?.epoch ?? 0));
          // file_size/mtime are recorded only once caught up, so an unchanged-file skip never
          // skips the unread remainder of a transcript left half-imported by a deadline.
          const finished = state === "active" && caughtUp;
          prepared(db,
            `UPDATE import_cursors SET path = ?, byte_offset = ?, anchor_hash = ?, file_size = ?, file_mtime_ms = ?, epoch = ?, state = ?, gap = ?,
               stats = ?, host_version = coalesce(?, host_version), updated_at = ? WHERE host = ? AND transcript_id = ?`,
          ).run(
            file.path,
            newOffset,
            anchorOf(file.path, newOffset),
            finished ? file.size : -1,
            finished ? file.mtimeMs : -1,
            epoch,
            state,
            gap === null ? null : JSON.stringify(gap),
            JSON.stringify(stats),
            chunk.events.at(-1)?.hostVersion ?? null,
            now,
            this.host,
            file.transcriptId,
          );
          return { offset: newOffset, state, finished };
        });
      } catch (error) {
        if (error instanceof Contended) return "contended";
        throw error;
      }
      this.batches++;
      expected = { offset: next.offset, epoch };
      known = { state: next.state, finished: next.finished };
      offset = next.offset;
      rewritten = false;
      if (next.state !== "active" || caughtUp) return "done";
    }
  }

  /** First batch of a transcript: bind it to its worktree's workstream and create its session, source and cursor rows. */
  private openTranscript(db: Db, entry: Discovered & { target: Target }, now: string): CursorRow {
    ensureWorkspace(db, entry.target, now);
    const { workstream } = ensureWorkstream(db, entry.target, now);
    const key = `${this.host}\u0000${entry.file.transcriptId}`;
    const sessionId = `ses_${digest(`session\u0000${key}`).slice(0, 32)}`;
    const sourceId = `src_${digest(`source\u0000${key}`).slice(0, 32)}`;
    prepared(db,
      "INSERT OR IGNORE INTO sessions (id, host, host_session_id, workstream_id, capabilities, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, this.host, entry.file.transcriptId, workstream.id, JSON.stringify({ imported: true }), now);
    prepared(db, "INSERT OR IGNORE INTO sources (id, kind, host, locator, created_at) VALUES (?, 'transcript', ?, ?, ?)").run(
      sourceId,
      this.host,
      entry.file.transcriptId,
      now,
    );
    prepared(db,
      `INSERT INTO import_cursors (host, transcript_id, path, source_id, session_id, workstream_id, file_size, file_mtime_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, -1, -1, ?)`,
    ).run(this.host, entry.file.transcriptId, entry.file.path, sourceId, sessionId, workstream.id, now);
    return readCursor(db, this.host, entry.file.transcriptId) as CursorRow;
  }

  // ── reporting ──

  private report(current: CurrentWorkspace, consent: Consent | null, inventory: Discovered[] | null): ImportStatus {
    const own = current.location;
    const entries = inventory ?? [];
    const mine = entries.filter((e) => e.target?.workspaceId === own.workspaceId);
    const others = entries.filter((e) => e.target !== null && e.target.workspaceId !== own.workspaceId);
    const status: ImportStatus = {
      host: this.host,
      state: "complete",
      consent,
      question: null,
      choices: null,
      transcriptsRoot: this.options.adapter.root,
      compatibility: this.options.adapter.compatibility,
      transcripts:
        inventory === null
          ? null
          : {
              found: entries.length,
              currentProject: mine.length,
              otherProjects: others.length,
              unassigned: entries.length - mine.length - others.length,
              unsupportedVersion: entries.filter((e) => !e.supported).length,
            },
      currentProject: null,
      backfill: null,
      gaps: [],
      problem: null,
    };
    if (consent === null) {
      status.state = "consent_required";
      status.choices = [...IMPORT_CHOICES];
      status.question = consentQuestion(this.options.adapter.displayName, status.transcripts ?? { found: 0, currentProject: 0, otherProjects: 0, unassigned: 0, unsupportedVersion: 0 });
      return status;
    }
    if (consent.choice === "none") return { ...status, state: "declined" };
    if (!approves(consent, own.repositoryKey)) return { ...status, state: "not_approved" };

    const cursors = current.db === null ? new Map<string, CursorRow & { transcript_id: string }>() : readCursors(current.db, this.host);
    const progress = { transcripts: mine.length, complete: 0, pending: 0, stopped: 0, quarantined: 0, counters: emptyCounters() };
    for (const cursor of cursors.values()) {
      progress.counters = mergeCounters(progress.counters, parseCounters(cursor.stats), false);
      if (cursor.gap !== null) status.gaps.push(JSON.parse(cursor.gap) as ImportGap);
    }
    for (const entry of mine) {
      const cursor = cursors.get(entry.file.transcriptId);
      if (cursor?.state === "quarantined") progress.quarantined++;
      else if (cursor?.state === "stopped") progress.stopped++;
      else if (cursor !== undefined && cursor.file_size === entry.file.size && cursor.file_mtime_ms === entry.file.mtimeMs) progress.complete++;
      else progress.pending++;
    }
    status.currentProject = progress;
    status.gaps.push(...this.otherGaps.values());
    const approvedOthers = this.approvedOthers(entries, consent, current);
    status.backfill = {
      projects: new Set(approvedOthers.map((e) => e.target?.workspaceId)).size,
      transcripts: approvedOthers.length,
      // Stale as soon as another project's approved transcripts change after reconciling.
      reconciled: approvedOthers.length === 0 || this.reconciledOthers === fingerprint(approvedOthers),
    };
    status.state = progress.pending > 0 || !status.backfill.reconciled ? "in_progress" : "complete";
    return status;
  }
}

function consentQuestion(host: string, counts: NonNullable<ImportStatus["transcripts"]>): string {
  const unplaced = counts.unassigned > 0 ? `, ${counts.unassigned} not in any Git repository Memchor can find` : "";
  const unreadable = counts.unsupportedVersion > 0 ? ` ${counts.unsupportedVersion} written by a ${host} version Memchor cannot read yet will be skipped until it can.` : "";
  return [
    `Memchor found ${counts.found} local ${host} sessions (${counts.currentProject} in this project, ${counts.otherProjects} in other projects${unplaced}).${unreadable}`,
    "",
    "Import observable transcript content into local Memchor storage?",
    "1. All projects",
    "2. Current project only",
    "3. Do not import",
    "",
    "Memchor does not send this data externally. Hidden reasoning, binaries, secrets it recognises, full file contents and oversized output are left out.",
    'Ask the user, then call memory_bootstrap with importChoice "all", "current_project" or "none".',
  ].join("\n");
}

// ── event application (inside the batch transaction) ──

interface Batch {
  db: Db;
  host: string;
  hostName: string;
  transcriptId: string;
  epoch: number;
  workstreamId: string;
  sessionId: string;
  sourceId: string;
  worktree: string;
  workspaceId: string;
  counters: ImportCounters;
  /** Tool calls seen in this batch, by call id (earlier batches are looked up in import_events). */
  calls: Map<string, CallMeta>;
  locate: (cwd: string) => Target | null;
}

const RECORD_ID = /\brec_[0-9a-f]{32}\b/g;
const WORKSTREAM_ID = /\bwst_[0-9a-f]{32}\b/g;

/** Applies events in order; returns where to quarantine the transcript, or null. */
function applyEvents(batch: Batch, events: readonly NormalizedEvent[]): { offset: number; message: string; cwd?: string } | null {
  const { db } = batch;
  const findVersions = prepared(db,
    "SELECT content_hash, record_id, disposition, meta FROM import_events WHERE host = ? AND transcript_id = ? AND branch = ? AND event_id = ?",
  );
  const touch = prepared(db,
    "UPDATE import_events SET seen_epoch = ? WHERE host = ? AND transcript_id = ? AND branch = ? AND event_id = ? AND content_hash = ?",
  );
  const insertEvent = prepared(db,
    `INSERT INTO import_events (host, transcript_id, branch, event_id, content_hash, record_id, disposition, meta, seen_epoch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const event of events) {
    const elsewhere = conflictingScope(batch, event.cwd);
    if (elsewhere !== null) return { offset: event.lineStart, message: elsewhere, cwd: event.cwd };
    batch.counters.events++;

    const hash = eventHash(event);
    const versions = findVersions.all(batch.host, batch.transcriptId, event.branch, event.eventId) as {
      content_hash: string;
      record_id: string | null;
      disposition: string;
      meta: string;
    }[];
    const same = versions.find((v) => v.content_hash === hash);
    if (same !== undefined) {
      touch.run(batch.epoch, batch.host, batch.transcriptId, event.branch, event.eventId, hash);
      batch.counters.replayed++;
      if (event.type === "tool_call") batch.calls.set(event.callId, JSON.parse(same.meta) as CallMeta);
      continue;
    }
    const previous = versions.find((v) => v.record_id !== null)?.record_id ?? null;
    if (versions.length > 0) batch.counters.conflicts++;
    const store = (disposition: "record" | "tool_call" | "echo", recordId: string | null, meta: object): void => {
      insertEvent.run(batch.host, batch.transcriptId, event.branch, event.eventId, hash, recordId, disposition, JSON.stringify(meta), batch.epoch, new Date().toISOString());
    };

    if (event.type === "tool_call") {
      const meta: CallMeta = { callId: event.callId, tool: event.tool, summary: event.summary, output: event.output, paths: event.paths, urls: event.urls };
      batch.calls.set(event.callId, meta);
      store("tool_call", null, meta);
      continue;
    }

    if (event.type === "tool_result") {
      const call = batch.calls.get(event.callId) ?? lookupCall(batch, event.callId);
      if (call?.output === "memchor_echo") {
        // Memchor's own output: keep which existing records it mentioned, never the text.
        const mentioned = [...new Set(event.text.match(RECORD_ID) ?? [])];
        const existing = mentioned.length === 0 ? [] : (prepared(db, "SELECT id FROM records WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(mentioned)) as { id: string }[]).map((r) => r.id);
        const workstreams = [...new Set(event.text.match(WORKSTREAM_ID) ?? [])];
        const foreign = workstreams.length === 0 ? [] : (prepared(db, "SELECT id FROM workstreams WHERE id IN (SELECT value FROM json_each(?)) AND id <> ?").all(JSON.stringify(workstreams), batch.workstreamId) as { id: string }[]);
        if (foreign.length > 0) {
          return { offset: event.lineStart, message: `Memchor output in this transcript names workstream ${foreign[0]?.id ?? ""}, but its worktree is bound to ${batch.workstreamId}; the transcript is quarantined from here instead of guessing.` };
        }
        batch.counters.echoes++;
        batch.counters.echoReferences += existing.length;
        store("echo", null, { callId: event.callId, tool: call.tool, references: existing });
        continue;
      }
      const written = appendImported(batch, event, previous, toolResultRecord(batch, call, event));
      store("record", written, previous === null ? {} : { versionOf: previous });
      continue;
    }

    const written = appendImported(batch, event, previous, messageRecord(batch, event));
    store("record", written, previous === null ? {} : { versionOf: previous });
  }
  return null;
}

/** Null when the event's cwd is in the transcript's worktree; otherwise why the scope conflicts. */
function conflictingScope(batch: Batch, cwd: string): string | null {
  const location = batch.locate(cwd);
  if (location !== null && location.workspaceId === batch.workspaceId && location.worktree === batch.worktree) return null;
  return location === null
    ? `The transcript moved to ${cwd}, which is not a Git worktree Memchor can resolve; it is quarantined from here instead of guessing.`
    : `The transcript moved from ${batch.worktree} to ${location.worktree}; one transcript cannot belong to two worktrees, so it is quarantined from here.`;
}

interface Draft {
  kind: "evidence" | "note";
  title: string | null;
  body: string;
  attribution: "user_direction" | "direct_observation" | "agent_inference";
  externalRefs: ExternalRef[];
}

function messageRecord(batch: Batch, event: Extract<NormalizedEvent, { type: "message" | "host_summary" }>): Draft {
  const summary = event.type === "host_summary";
  return {
    kind: summary ? "note" : "evidence",
    title: summary ? `${batch.hostName} summary` : null,
    body: passage(batch, event.text, summary ? PASSAGE_LIMITS.summaryBytes : PASSAGE_LIMITS.messageBytes),
    attribution: summary || event.role === "assistant" ? "agent_inference" : "user_direction",
    externalRefs: [],
  };
}

function toolResultRecord(batch: Batch, call: CallMeta | null, event: Extract<NormalizedEvent, { type: "tool_result" }>): Draft {
  const summary = call === null ? "Tool result" : passage(batch, call.summary, PASSAGE_LIMITS.callSummaryBytes, false);
  const title = clip(`${call?.tool ?? "Tool"}${event.isError ? " (error)" : ""}: ${summary.split("\n")[0] ?? ""}`, 200);
  let output: string;
  if (call?.output === "reference_only") {
    if (event.text !== "") batch.counters.fileContents++;
    output = event.isError ? passage(batch, event.text, 300) : "(file content not stored; read the file for its current state)";
  } else if (call === null) {
    // Without the call, Memchor cannot tell whether the output came from a sensitive path.
    batch.counters.withheld++;
    output = "[output withheld by Memchor: the tool call that produced it could not be read]";
  } else if (touchesSensitivePath([call.summary, ...call.paths])) {
    batch.counters.withheld++;
    output = "[output withheld by Memchor: the call touched a sensitive path]";
  } else {
    output = event.text.trim() === "" ? "(no text output)" : passage(batch, event.text, PASSAGE_LIMITS.toolOutputBytes);
  }
  const refs: ExternalRef[] = [];
  for (const path of call?.paths ?? []) {
    if (!isWithin(path, batch.worktree)) continue;
    const rel = relative(batch.worktree, path) || ".";
    refs.push({ kind: "code", locator: clip(rel, 500), path: clip(rel, 500) });
  }
  for (const url of call?.urls ?? []) refs.push({ kind: "url", locator: clip(url, 500) });
  return { kind: "evidence", title, body: `${summary}\n\n${output}`, attribution: "direct_observation", externalRefs: refs.slice(0, 10) };
}

/** Redacts, then bounds; counts both. */
function passage(batch: Batch, text: string, maxBytes: number, count = true): string {
  const redacted = redactSecrets(text);
  batch.counters.redactions += redacted.redactions;
  const bounded = boundPassage(redacted.text.trim(), maxBytes);
  if (count && bounded.omittedBytes > 0) batch.counters.clipped++;
  return bounded.text;
}

function appendImported(batch: Batch, event: NormalizedEvent, previous: string | null, draft: Draft): string {
  const written = appendRecord(batch.db, batch.workstreamId, {
    kind: draft.kind,
    title: draft.title,
    body: draft.body,
    workstreamId: batch.workstreamId,
    sessionId: batch.sessionId,
    host: batch.host,
    attribution: draft.attribution,
    reviewState: "unreviewed",
    applicability: { sourceVersion: `${batch.host} ${event.hostVersion}` },
    externalRefs: draft.externalRefs,
    links: previous === null ? [] : [{ recordId: previous, relation: "related_to" }],
    sourceId: batch.sourceId,
    createdAt: event.observedAt,
  });
  batch.counters.records++;
  return written.recordId;
}

function lookupCall(batch: Batch, callId: string): CallMeta | null {
  const row = prepared(batch.db, "SELECT meta FROM import_events WHERE host = ? AND transcript_id = ? AND disposition = 'tool_call' AND json_extract(meta, '$.callId') = ? LIMIT 1")
    .get(batch.host, batch.transcriptId, callId) as { meta: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.meta) as CallMeta);
}

/** Hash of what an event says (not where it sits), so a moved line is a replay and an edited one a version. */
function eventHash(event: NormalizedEvent): string {
  let content: unknown[];
  switch (event.type) {
    case "message":
      content = [event.type, event.role, event.text];
      break;
    case "host_summary":
      content = [event.type, event.text];
      break;
    case "tool_call":
      content = [event.type, event.callId, event.tool, event.summary, event.output, event.paths, event.urls];
      break;
    case "tool_result":
      content = [event.type, event.callId, event.text, event.isError];
      break;
  }
  return "sha256:" + digest(JSON.stringify(content));
}

// ── cursors and counters ──

function readCursor(db: Db, host: string, transcriptId: string): CursorRow | undefined {
  return prepared(db, "SELECT * FROM import_cursors WHERE host = ? AND transcript_id = ?").get(host, transcriptId) as CursorRow | undefined;
}

function readCursors(db: Db, host: string): Map<string, CursorRow & { transcript_id: string }> {
  const rows = prepared(db, "SELECT * FROM import_cursors WHERE host = ? ORDER BY transcript_id").all(host) as (CursorRow & { transcript_id: string })[];
  return new Map(rows.map((row) => [row.transcript_id, row]));
}

function emptyCounters(): ImportCounters {
  return { events: 0, records: 0, replayed: 0, conflicts: 0, missing: 0, echoes: 0, echoReferences: 0, redactions: 0, clipped: 0, withheld: 0, fileContents: 0, rewrites: 0, excluded: {} };
}

function parseCounters(json: string): ImportCounters {
  return { ...emptyCounters(), ...(JSON.parse(json) as Partial<ImportCounters>) };
}

function addExcluded(counters: ImportCounters, excluded: Partial<Record<ExclusionReason, number>>): void {
  for (const [reason, n] of Object.entries(excluded) as [ExclusionReason, number][]) counters.excluded[reason] = (counters.excluded[reason] ?? 0) + n;
}

/**
 * Sums counters. `missing` is a snapshot, not a sum: it is recomputed at the end of each
 * reconciliation pass (and reset when a new pass starts).
 */
function mergeCounters(a: ImportCounters, b: ImportCounters, newPass: boolean): ImportCounters {
  const out = emptyCounters();
  for (const key of Object.keys(out) as (keyof ImportCounters)[]) {
    if (key === "excluded") continue;
    out[key] = (a[key]) + (b[key]);
  }
  out.missing = b.missing > 0 || newPass ? b.missing : a.missing;
  addExcluded(out, a.excluded);
  addExcluded(out, b.excluded);
  return out;
}

function anchorOf(path: string, offset: number): string | null {
  if (offset === 0) return null;
  const start = Math.max(0, offset - ANCHOR_BYTES);
  const buffer = Buffer.alloc(offset - start);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "unreadable";
  }
  try {
    const n = readSync(fd, buffer, 0, buffer.length, start);
    return digest(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

/** The status reported for a host that has no transcript adapter (nothing is discovered or imported). */
export function unsupportedHostStatus(host: string): ImportStatus {
  return {
    host,
    state: "unsupported_host",
    consent: null,
    question: null,
    choices: null,
    transcriptsRoot: null,
    compatibility: [],
    transcripts: null,
    currentProject: null,
    backfill: null,
    gaps: [],
    problem: null,
  };
}

/** Identifies a set of transcripts by path, size and mtime: any change means not yet reconciled. */
function fingerprint(entries: readonly Discovered[]): string {
  return digest(JSON.stringify(entries.map((e) => [e.file.path, e.file.size, e.file.mtimeMs]).sort()));
}
