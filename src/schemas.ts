import { z } from "zod";

/**
 * Input schemas for every memory operation. The memory module parses its own input
 * with these, so adapters (MCP, CLI) may reuse them for tool metadata but never need
 * to validate anything themselves.
 *
 * Every object is strict: unknown keys are rejected. In particular a payload cannot
 * carry `workspaceId`, `workstreamId`, `cwd` or `path` — scope comes only from the
 * process's trusted context (see `openMemory`). The one exception is bootstrap's
 * `workstream`, the user's answer to an ambiguity: it can only name a workstream of the
 * workspace already resolved from that context, so it never widens scope.
 */

export const LIMITS = {
  /** Record bodies are knowledge *about* artifacts, not the artifacts themselves. */
  bodyBytes: 16 * 1024,
  titleChars: 200,
  operationKeyChars: 200,
  queryChars: 1_000,
  hostSessionIdChars: 200,
  /** An explicit task identity: an issue/PR number or URL, or a tracker key. */
  taskChars: 500,
  /** Host names longer than this are cut (they are labels, not identities). */
  hostChars: 100,
  /** Why a claim was corrected, superseded, retracted, restored or forgotten. */
  reasonChars: 1_000,
  /** Records one forget preview may name (their copies come along). */
  forgetTargets: 50,
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

/** Kinds `record` accepts: checkpoints go through `checkpoint`, corrections through `memory_manage`. */
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

/** Kinds recall can filter on: everything recordable, plus the corrections `memory_manage` writes. */
export const RecallableKind = z.enum([...RecordableKind.options, "correction"]);

export const Attribution = z.enum(["user_direction", "direct_observation", "agent_inference"]);
export type Attribution = z.infer<typeof Attribution>;

/**
 * The review axis. "retracted" appears only on records the v3 migration retracted; retraction is
 * a lifecycle change now (`memory_manage`), so `record` accepts only {@link WritableReviewState}.
 */
export const ReviewState = z.enum(["unreviewed", "accepted", "disputed", "retracted"]);
export type ReviewState = z.infer<typeof ReviewState>;
export const WritableReviewState = ReviewState.exclude(["retracted"]);

/** `supersedes` is written only by `memory_manage` (a correction or new version supersedes the old claim). */
export const LinkRelation = z.enum(["supported_by", "derived_from", "references", "related_to"]);
export type LinkRelation = z.infer<typeof LinkRelation> | "supersedes";

/**
 * Whether what a record observed still holds. Computed at recall/read time against the live
 * worktree (src/retrieval/freshness.ts), never trusted from storage: the stored column stays
 * "unknown". Local code references compare commit, dirty state and a bounded file hash;
 * issue/PR/URL/document references are always "unknown" (historical).
 */
export const Freshness = z.enum(["current", "stale", "unknown"]);
export type Freshness = z.infer<typeof Freshness>;

export const RecordId = z.string().regex(/^rec_[0-9a-f]{32}$/, "expected a record id like rec_<32 hex>");

export const WorkstreamId = z.string().regex(/^wst_[0-9a-f]{32}$/, 'expected a workstream id like wst_<32 hex>, or "new"');

export const ExternalRef = z.strictObject({
  kind: z.enum(["code", "document", "issue", "pr", "url", "other"]),
  /** Repository-relative path, issue number, URL, … — a pointer, never the content. */
  locator: z.string().min(1).max(500),
  path: z.string().min(1).max(500).optional(),
  lines: z.tuple([z.int().min(1), z.int().min(1)]).optional(),
  /**
   * Pins the reference to a version. Leave `commit` and `observedHash` out for code as it is
   * on disk now: Memchor then records the commit, dirty state and a `sha256:` hash itself.
   */
  commit: z.string().min(4).max(64).optional(),
  /** `sha256:<hex>` of the whole file; any other format cannot be compared (freshness stays unknown). */
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

/** A test, lint or build run a record reports. Memchor adds the repository state it ran against. */
export const TestRunInput = z.strictObject({
  command: z.string().trim().min(1).max(500).describe("The exact command that ran, e.g. npm test -- gateway"),
  outcome: z.enum(["passed", "failed"]),
  exitCode: z.int().min(0).max(255).optional(),
});
export type TestRunInput = z.infer<typeof TestRunInput>;

const OperationKey = z
  .string()
  .min(1)
  .max(LIMITS.operationKeyChars)
  .describe("Idempotency key: retrying with the same key and payload returns the first result instead of writing twice");
const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

const MaxTokens = z.int().min(LIMITS.minTokens).max(LIMITS.maxTokens);
const MaxBytes = z.int().min(LIMITS.minBytes).max(LIMITS.maxBytes);

/** Transcript-import decisions a host's user can make (stored per host; see src/import/consent.ts). */
export const IMPORT_CHOICES = ["all", "current_project", "none"] as const;
export type ImportChoice = (typeof IMPORT_CHOICES)[number];

export const BootstrapInput = z.strictObject({
  hostSessionId: z.string().min(1).max(LIMITS.hostSessionIdChars).optional(),
  importChoice: z
    .enum(IMPORT_CHOICES)
    .optional()
    .describe(
      "Only after asking the user the question in import.question (or when they ask to change it): all = import every project's local transcripts, current_project = only this repository's, none = import nothing. Stored per host; pass it again to change it.",
    ),
  task: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.taskChars)
    .optional()
    .describe(
      'The task the user explicitly named, if any: "#20", an issue or PR URL, or a tracker key like PROJ-7. It selects the workstream of that task over branch similarity; never invent one.',
    ),
  workstream: z
    .union([z.literal("new"), WorkstreamId])
    .optional()
    .describe(
      'Only after asking the user to choose from scope.ambiguity.candidates: the chosen workstreamId, or "new" for a fresh workstream. The choice becomes this worktree\'s workstream.',
    ),
  /** Budget for the returned `context` pack, exactly as for recall. */
  maxTokens: MaxTokens.optional().describe("Budget for the returned context pack (default 2000 tokens), as for memory_recall"),
  maxBytes: MaxBytes.optional(),
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
  reviewState: WritableReviewState.default("unreviewed"),
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
  testRun: TestRunInput.optional().describe(
    "Only when this record reports a test/lint/build run you just did (record it right after running). Memchor stamps the commit and working-tree state it applies to. Cite the run's captured tool output with supportedBy if memory has it; otherwise the result is stored as your assertion, never as observed",
  ),
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
  kinds: z.array(RecallableKind).min(1).max(RecallableKind.options.length).optional(),
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

export const MANAGE_ACTIONS = ["inspect", "correct", "supersede", "retract", "restore", "forget_preview", "forget"] as const;
export type ManageAction = (typeof MANAGE_ACTIONS)[number];

/** Which fields each action takes: required ones, and optional ones beyond `v`/`action`. Anything else is rejected. */
const MANAGE_FIELDS: Record<ManageAction, { required: readonly string[]; optional: readonly string[] }> = {
  inspect: { required: ["recordId"], optional: [] },
  correct: { required: ["recordId", "body", "reason", "attribution"], optional: ["operationKey"] },
  supersede: { required: ["recordId", "body", "reason", "attribution"], optional: ["operationKey"] },
  retract: { required: ["recordId", "reason", "attribution"], optional: ["operationKey"] },
  restore: { required: ["recordId", "reason", "attribution"], optional: ["operationKey"] },
  forget_preview: { required: ["recordIds"], optional: [] },
  forget: { required: ["confirmToken", "reason", "attribution"], optional: ["operationKey"] },
};

/**
 * One flat, versioned envelope for every lifecycle operation (a top-level union would not be a
 * valid tool input schema for every host). Fields are checked per action below.
 */
export const ManageInput = z
  .strictObject({
    v: z.literal(1).default(1).describe("Envelope version; 1"),
    action: z
      .enum(MANAGE_ACTIONS)
      .describe(
        "inspect = state, history, evidence and derivations of a record (any state). correct = the claim was wrong: body is the corrected claim. supersede = it was right but is outdated: body is the new version. retract = it was wrong, with no replacement. restore = undo a retraction. forget_preview = what forgetting recordIds would remove (changes nothing). forget = remove it, with the preview's confirmToken, only after the user confirmed that preview.",
      ),
    recordId: RecordId.optional(),
    recordIds: z.array(RecordId).min(1).max(LIMITS.forgetTargets).optional().describe("forget_preview: the records to forget (find them with recall or inspect)"),
    confirmToken: z.string().min(1).max(4_096).optional().describe("forget: the confirmToken of the forget_preview the user confirmed"),
    body: z
      .string()
      .min(1)
      .refine((s) => utf8Bytes(s) <= LIMITS.bodyBytes, { message: `body exceeds ${LIMITS.bodyBytes} UTF-8 bytes (content_too_large)` })
      .optional()
      .describe("correct: the corrected claim; supersede: the new version. Never the old claim"),
    reason: z.string().trim().min(1).max(LIMITS.reasonChars).optional().describe("Why, in the user's words where they gave them"),
    attribution: Attribution.optional().describe("user_direction when the user asked for the change; agent_inference when you concluded it yourself"),
    operationKey: OperationKey.optional(),
  })
  .superRefine((input, ctx) => {
    const fields = MANAGE_FIELDS[input.action];
    for (const key of fields.required) {
      if (input[key as keyof typeof input] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for ${input.action}` });
    }
    for (const key of Object.keys(input)) {
      if (key === "v" || key === "action" || fields.required.includes(key) || fields.optional.includes(key)) continue;
      ctx.addIssue({ code: "custom", path: [key], message: `${key} is not used by ${input.action}` });
    }
  });
export type ManageInput = z.input<typeof ManageInput>;

/** Background import step (adapters call it between requests; not an agent tool). */
export const ContinueImportInput = z.strictObject({
  maxMs: z.int().min(0).max(60_000).default(250),
});
export type ContinueImportInput = z.input<typeof ContinueImportInput>;

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
  memory_manage: ManageInput,
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
