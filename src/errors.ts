/**
 * The one error type Memchor's memory module throws for expected failures.
 *
 * Every adapter (MCP, CLI) maps a `MemchorError` to its envelope verbatim via
 * {@link MemchorError.toEnvelope}; adapters never invent codes of their own.
 * Anything thrown that is *not* a `MemchorError` is a programming bug.
 */
export const ERROR_CODES = [
  /** The process cwd is not inside a Git worktree, so no workspace can be derived. */
  "scope_unresolved",
  /**
   * More than one workstream could own this scope, or its signals conflict; Memchor refuses
   * to guess. Thrown by workstream-scoped writes (`record` without `workspaceLevel`,
   * `checkpoint`) while bootstrap's `scope.ambiguity` is unanswered. Transcript import also
   * reports it as a gap reason for a transcript that is held or quarantined instead of attached.
   */
  "scope_ambiguous",
  /** The target exists but belongs to another workstream. */
  "scope_denied",
  /** The target does not exist, or is ineligible (e.g. retracted) for this operation. */
  "not_found",
  /** The payload failed validation (unknown keys, bad types, oversized content, bad continuation). */
  "invalid_input",
  /** An operation key was reused with a different request. */
  "idempotency_conflict",
  /**
   * The record is not in the lifecycle state the operation needs (e.g. correcting a record that
   * was already corrected, or restoring one that was not retracted). `details.lifecycle` names
   * its state and `details.replacementId` its replacement, if any.
   */
  "lifecycle_conflict",
  /** `expectedRevision` does not match the workstream's head; reread and reconcile deliberately. */
  "checkpoint_conflict",
  /** Another writer held the database past the bounded busy timeout. Safe to retry. */
  "storage_busy",
  /** The disk or database is full; nothing was acknowledged. */
  "storage_full",
  /** The database or registry cannot be opened, read, or written. */
  "storage_unavailable",
  /** The embedded SQLite build or the on-disk schema is not supported by this Memchor. */
  "unsupported_runtime",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export class MemchorError extends Error {
  override readonly name = "MemchorError";
  readonly code: ErrorCode;
  /** True only when repeating the identical request may succeed without the caller changing anything. */
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: { code: this.code, message: this.message, retryable: this.retryable, details: this.details },
    };
  }
}
