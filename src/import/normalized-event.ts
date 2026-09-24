/**
 * The host-neutral event model that transcript adapters produce and the importer
 * consumes. Nothing downstream of an adapter knows a host's file format: an adapter
 * decides *what* an entry is (a message, a tool call and its output policy, a host
 * summary, or something to exclude), and the importer decides *how* it is stored.
 */

/** Where an event sits in its transcript; together with the host and transcript id it is the event's identity. */
export interface EventOrigin {
  /** Conversation branch: "main", or the host's id for a side conversation (e.g. a subagent). */
  branch: string;
  /** The host's stable id for the entry (plus "#<block>" when one entry yields several events). */
  eventId: string;
  /** ISO timestamp the host recorded for the entry. */
  observedAt: string;
  /** Absolute working directory the host recorded; decides the event's workspace. */
  cwd: string;
  /** Git branch the host recorded, if any (a label, never scope). */
  gitBranch: string | null;
  /** The host build that wrote the entry, e.g. "2.1.281". */
  hostVersion: string;
  /** Byte range of the entry's line in the transcript file. */
  lineStart: number;
  lineEnd: number;
}

/**
 * What the importer may keep from a tool call's result:
 * - `passage`: a bounded excerpt of the output;
 * - `reference_only`: only the call's summary and references (file reads and edits are
 *   full-file dumps; Memchor stores knowledge about artifacts, not the artifacts);
 * - `memchor_echo`: Memchor's own output, never new evidence (only the record ids it
 *   mentions are kept, as references).
 */
export type OutputPolicy = "passage" | "reference_only" | "memchor_echo";

export type NormalizedEvent = EventOrigin &
  (
    | {
        type: "message";
        role: "user" | "assistant";
        /** Visible text only; the adapter has already removed injected host context. */
        text: string;
      }
    | {
        /** A summary the host itself wrote (e.g. context compaction); kept, bounded, as a note. */
        type: "host_summary";
        text: string;
      }
    | {
        type: "tool_call";
        callId: string;
        tool: string;
        /** One line describing the call (command, path, query), never file content. */
        summary: string;
        /** Absolute paths the call reads or writes, for code references and sensitive-path checks. */
        paths: string[];
        urls: string[];
        output: OutputPolicy;
      }
    | {
        type: "tool_result";
        callId: string;
        /** The textual output; binary parts were excluded by the adapter. */
        text: string;
        isError: boolean;
      }
  );

/** Why an adapter left an entry (or part of one) out. Counted per transcript and reported as gaps. */
export const EXCLUSION_REASONS = [
  "hidden_reasoning",
  "binary",
  "injected_context",
  "host_metadata",
  "malformed",
  "unsupported_entry",
  "oversized_entry",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface TranscriptFile {
  /** The host's stable transcript id (Claude Code: the session id); survives the file moving. */
  transcriptId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface TranscriptHead {
  /** The first recorded working directory, or null for a transcript with no events yet. */
  cwd: string | null;
  hostVersion: string | null;
  /** False when that first entry's version is outside the compatibility table (import would stop at once). */
  supported: boolean;
}

export interface TranscriptChunk {
  events: NormalizedEvent[];
  /** Offset just past the last complete line consumed; a partial trailing line is left for later. */
  end: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  /**
   * Set when the adapter met an entry it must not guess about. `offset` is that line's
   * start: everything before it is in `events`, nothing from it onwards is.
   */
  stop: { reason: "unsupported_version"; hostVersion: string; offset: number } | null;
}

/** One row of an adapter's explicit compatibility table. */
export interface CompatibilityRow {
  /** Inclusive lower bound. */
  from: string;
  /** Exclusive upper bound. */
  below: string;
  format: string;
  basis: string;
}

/**
 * A host's transcript format, behind one interface. Implementations read only the
 * host's documented transcript location and never write to it.
 */
export interface TranscriptAdapter {
  readonly host: string;
  /** The host's name for people, e.g. "Claude Code", used in questions and gap messages. */
  readonly displayName: string;
  readonly compatibility: readonly CompatibilityRow[];
  /** The directory the adapter reads, whether or not it exists. */
  readonly root: string;
  discover(): TranscriptFile[];
  inspect(file: TranscriptFile): TranscriptHead;
  /** Parses complete lines from `from` until about `maxBytes` are consumed. */
  read(file: TranscriptFile, from: number, maxBytes: number): TranscriptChunk;
}
