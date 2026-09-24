import { z } from "zod";

/**
 * Input schemas for every memory operation. The memory module parses its own input
 * with these, so adapters (MCP, CLI) may reuse them for tool metadata but never need
 * to validate anything themselves.
 *
 * Every object is strict: unknown keys are rejected. In particular a payload cannot
 * carry `workspaceId`, `workstreamId`, `cwd` or `path` — scope comes only from the
 * process's trusted context (see `openMemory`).
 */

export const LIMITS = {
  /** Record bodies are knowledge *about* artifacts, not the artifacts themselves. */
  bodyBytes: 16 * 1024,
  titleChars: 200,
  operationKeyChars: 200,
  queryChars: 1_000,
  hostSessionIdChars: 200,
  /** Host names longer than this are cut (they are labels, not identities). */
  hostChars: 100,
  linksPerRecord: 20,
  externalRefsPerRecord: 10,
  checkpointListItems: 50,
  checkpointEntryChars: 2_000,
  /** A continuation carries the frozen remainder of its sequence (≤ 500 base-36 seqs). */
  continuationChars: 8_192,
  /** Budgets: tokens are estimated as ceil(utf8Bytes / 4); the tighter of the two limits applies. */
  defaultMaxTokens: 2_000,
  maxTokens: 8_000,
  minTokens: 16,
  maxBytes: 32_000,
  minBytes: 64,
} as const;

export const RECORD_KINDS = [
  "evidence",
  "note",
  "preference",
  "constraint",
  "decision",
  "attempt",
  "question",
  "next_step",
  "reference",
  "checkpoint",
  "correction",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Kinds `record` accepts: checkpoints go through `checkpoint`; corrections arrive with #18's successors. */
export const RecordableKind = z.enum([
  "evidence",
  "note",
  "preference",
  "constraint",
  "decision",
  "attempt",
  "question",
  "next_step",
  "reference",
]);

export const Attribution = z.enum(["user_direction", "direct_observation", "agent_inference"]);
export type Attribution = z.infer<typeof Attribution>;

export const ReviewState = z.enum(["unreviewed", "accepted", "disputed", "retracted"]);
export type ReviewState = z.infer<typeof ReviewState>;

/** `supersedes` is reserved until supersession semantics ship; accepting it now would promise behaviour that does not exist. */
export const LinkRelation = z.enum(["supported_by", "derived_from", "references", "related_to"]);
export type LinkRelation = z.infer<typeof LinkRelation> | "supersedes";

/** Only "unknown" is produced until freshness validation ships (#21). */
export const Freshness = z.enum(["current", "stale", "unknown"]);
export type Freshness = z.infer<typeof Freshness>;

export const RecordId = z.string().regex(/^rec_[0-9a-f]{32}$/, "expected a record id like rec_<32 hex>");

export const ExternalRef = z.strictObject({
  kind: z.enum(["code", "document", "issue", "pr", "url", "other"]),
  /** Repository-relative path, issue number, URL, … — a pointer, never the content. */
  locator: z.string().min(1).max(500),
  path: z.string().min(1).max(500).optional(),
  lines: z.tuple([z.int().min(1), z.int().min(1)]).optional(),
  commit: z.string().min(4).max(64).optional(),
  observedHash: z.string().min(1).max(200).optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const Applicability = z.strictObject({
  /** Defaults to the worktree's HEAD at record time. */
  commit: z.string().min(4).max(64).optional(),
  dirtyFingerprint: z.string().min(1).max(200).optional(),
  sourceVersion: z.string().min(1).max(200).optional(),
});
export type Applicability = z.infer<typeof Applicability>;

const OperationKey = z
  .string()
  .min(1)
  .max(LIMITS.operationKeyChars)
  .describe("Idempotency key: retrying with the same key and payload returns the first result instead of writing twice");
const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

const MaxTokens = z.int().min(LIMITS.minTokens).max(LIMITS.maxTokens);
const MaxBytes = z.int().min(LIMITS.minBytes).max(LIMITS.maxBytes);

export const BootstrapInput = z.strictObject({
  hostSessionId: z.string().min(1).max(LIMITS.hostSessionIdChars).optional(),
});
export type BootstrapInput = z.input<typeof BootstrapInput>;

export const RecordInput = z.strictObject({
  kind: RecordableKind,
  body: z
    .string()
    .min(1)
    .refine((s) => utf8Bytes(s) <= LIMITS.bodyBytes, {
      message: `body exceeds ${LIMITS.bodyBytes} UTF-8 bytes (content_too_large); store knowledge about the artifact and reference it with externalRefs instead`,
    }),
  title: z.string().min(1).max(LIMITS.titleChars).optional(),
  attribution: Attribution.describe(
    "user_direction = the user said so; direct_observation = you saw it (tool output, file, test run); agent_inference = your conclusion",
  ),
  reviewState: ReviewState.default("unreviewed"),
  /** True stores the record for every workstream of the workspace (e.g. a project-wide preference). */
  workspaceLevel: z.boolean().default(false).describe("true = applies to every workstream of this repository (e.g. a project-wide preference)"),
  supportedBy: z.array(RecordId).max(LIMITS.linksPerRecord).default([]).describe("Record ids of the evidence this record rests on"),
  links: z
    .array(z.strictObject({ to: RecordId, relation: LinkRelation }))
    .max(LIMITS.linksPerRecord)
    .default([]),
  externalRefs: z
    .array(ExternalRef)
    .max(LIMITS.externalRefsPerRecord)
    .default([])
    .describe("Pointers to code, documents, issues or URLs; never their content"),
  applicability: Applicability.default({}),
  operationKey: OperationKey.optional(),
});
export type RecordInput = z.input<typeof RecordInput>;

const CheckpointList = z.array(z.string().min(1).max(LIMITS.checkpointEntryChars)).max(LIMITS.checkpointListItems).default([]);

export const CheckpointInput = z.strictObject({
  /** The head revision the caller last read (0 before the first checkpoint). */
  expectedRevision: z.int().min(0).describe("The head revision you last read (scope.headRevision); 0 before the first checkpoint"),
  goal: z.string().min(1).max(LIMITS.checkpointEntryChars),
  status: z.string().min(1).max(2 * LIMITS.checkpointEntryChars),
  decisions: CheckpointList,
  failedAttempts: CheckpointList,
  openQuestions: CheckpointList,
  nextSteps: CheckpointList,
  preferences: CheckpointList,
  externalRefs: z.array(ExternalRef).max(LIMITS.externalRefsPerRecord).default([]),
  supportedBy: z.array(RecordId).max(LIMITS.linksPerRecord).default([]),
  operationKey: OperationKey.optional(),
});
export type CheckpointInput = z.input<typeof CheckpointInput>;

export const RecallInput = z.strictObject({
  query: z.string().min(1).max(LIMITS.queryChars).optional().describe("Words to search for; omit for the head checkpoint plus the most recent records"),
  kinds: z.array(RecordableKind).min(1).max(RecordableKind.options.length).optional(),
  maxTokens: MaxTokens.optional(),
  maxBytes: MaxBytes.optional(),
  /** Opaque token from a previous pack; it fixes the query and kinds of the sequence. */
  continuation: z.string().min(1).max(LIMITS.continuationChars).optional().describe("Token from a previous pack's `continuation` to get the next page"),
});
export type RecallInput = z.input<typeof RecallInput>;

export const ReadInput = z.strictObject({
  recordId: RecordId,
  maxTokens: MaxTokens.optional(),
  maxBytes: MaxBytes.optional(),
  /**
   * Resume point returned as `nextOffset` by a previous read, in UTF-16 code units. An
   * offset that falls inside a surrogate pair snaps back to the start of that code point.
   */
  offset: z.int().min(0).default(0),
});
export type ReadInput = z.input<typeof ReadInput>;

export const StatusInput = z.strictObject({});
export type StatusInput = z.input<typeof StatusInput>;

/**
 * Every operation the memory module offers to agents, with its input schema. Adapters
 * build their tool lists from this map (the single source of operation names).
 */
export const OPERATION_SCHEMAS = {
  memory_bootstrap: BootstrapInput,
  memory_recall: RecallInput,
  memory_read: ReadInput,
  memory_record: RecordInput,
  memory_checkpoint: CheckpointInput,
  memory_status: StatusInput,
} as const;
export type OperationName = keyof typeof OPERATION_SCHEMAS;

/** Effective byte budget: the tighter of maxBytes and maxTokens × 4, defaulting to the default token budget. */
export function effectiveBudget(input: { maxTokens?: number | undefined; maxBytes?: number | undefined }): {
  maxTokens: number;
  maxBytes: number;
} {
  const maxTokens = input.maxTokens ?? (input.maxBytes === undefined ? LIMITS.defaultMaxTokens : LIMITS.maxTokens);
  const maxBytes = Math.min(input.maxBytes ?? LIMITS.maxBytes, maxTokens * 4);
  return { maxTokens: Math.min(maxTokens, Math.ceil(maxBytes / 4)), maxBytes };
}

/** The documented token estimate: one token per four UTF-8 bytes, rounded up. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}
