import { MemchorError } from "../errors.js";
import { LIMITS, type Applicability, type ExternalRef } from "../schemas.js";
import type { Db } from "../storage/database.js";
import { appendRecord } from "../storage/records.js";

export interface CheckpointContent {
  goal: string;
  status: string;
  decisions: readonly string[];
  failedAttempts: readonly string[];
  openQuestions: readonly string[];
  nextSteps: readonly string[];
  preferences: readonly string[];
  externalRefs: readonly ExternalRef[];
  supportedBy: readonly string[];
}

export interface PublishedCheckpoint {
  recordId: string;
  revision: number;
  previousRevision: number;
  createdAt: string;
}

/**
 * Compare-and-swap publication of the workstream's continuation state.
 *
 * Must run inside an IMMEDIATE write transaction: the head read and the head update
 * then happen under one write lock, so of N writers holding the same
 * `expectedRevision` exactly one advances the head and every other one sees the new
 * head and gets `checkpoint_conflict` (details.currentRevision). Nothing is merged:
 * each revision is one agent's complete statement, and history is append-only.
 * The conditional UPDATE and UNIQUE(workstream_id, revision) re-assert the invariant
 * at the storage layer.
 */
export function publishCheckpoint(
  db: Db,
  scope: { workstreamId: string; sessionId: string; host: string },
  expectedRevision: number,
  content: CheckpointContent,
  applicability: Applicability,
): PublishedCheckpoint {
  const currentRevision = headRevision(db, scope.workstreamId);
  if (currentRevision !== expectedRevision) {
    throw new MemchorError(
      "checkpoint_conflict",
      `The workstream head is at revision ${currentRevision}, not ${expectedRevision}. Recall the current checkpoint, reconcile deliberately, then publish with expectedRevision ${currentRevision}.`,
      { details: { currentRevision, expectedRevision } },
    );
  }
  const body = renderCheckpoint(content);
  if (Buffer.byteLength(body, "utf8") > LIMITS.bodyBytes) {
    throw new MemchorError("invalid_input", `The rendered checkpoint exceeds ${LIMITS.bodyBytes} UTF-8 bytes (content_too_large); keep it to status and pointers.`, {
      details: { reason: "content_too_large", maxBytes: LIMITS.bodyBytes },
    });
  }
  const revision = expectedRevision + 1;
  const { recordId, createdAt } = appendRecord(db, scope.workstreamId, {
    kind: "checkpoint",
    title: `Checkpoint r${revision}: ${content.goal}`.slice(0, LIMITS.titleChars),
    body,
    workstreamId: scope.workstreamId,
    sessionId: scope.sessionId,
    host: scope.host,
    // A checkpoint is the publishing agent's synthesis; its evidence is cited via supportedBy.
    attribution: "agent_inference",
    reviewState: "unreviewed",
    applicability,
    externalRefs: content.externalRefs,
    links: content.supportedBy.map((id) => ({ recordId: id, relation: "supported_by" as const })),
  });
  db.prepare("INSERT INTO checkpoints (workstream_id, revision, record_id, created_at) VALUES (?, ?, ?, ?)").run(
    scope.workstreamId,
    revision,
    recordId,
    createdAt,
  );
  const moved = db
    .prepare("UPDATE workstreams SET head_revision = ? WHERE id = ? AND head_revision = ?")
    .run(revision, scope.workstreamId, expectedRevision);
  if (moved.changes !== 1) throw new Error("checkpoint head moved inside a write transaction");
  return { recordId, revision, previousRevision: expectedRevision, createdAt };
}

export function headRevision(db: Db, workstreamId: string): number {
  const row = db.prepare("SELECT head_revision FROM workstreams WHERE id = ?").get(workstreamId) as { head_revision: number } | undefined;
  return row?.head_revision ?? 0;
}

/** The record id of the head checkpoint, or null before the first checkpoint. */
export function headCheckpointRecordId(db: Db, workstreamId: string): string | null {
  const row = db
    .prepare(
      `SELECT c.record_id FROM workstreams w JOIN checkpoints c ON c.workstream_id = w.id AND c.revision = w.head_revision
       WHERE w.id = ?`,
    )
    .get(workstreamId) as { record_id: string } | undefined;
  return row?.record_id ?? null;
}

/** Canonical checkpoint body: stable section order, one bullet per entry, empty sections omitted. */
function renderCheckpoint(content: CheckpointContent): string {
  const section = (heading: string, entries: readonly string[]): string =>
    entries.length === 0 ? "" : `\n\n${heading}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
  return (
    `Goal: ${content.goal}\n\nStatus: ${content.status}` +
    section("Decisions", content.decisions) +
    section("Failed attempts", content.failedAttempts) +
    section("Open questions", content.openQuestions) +
    section("Next steps", content.nextSteps) +
    section("Preferences", content.preferences)
  );
}
