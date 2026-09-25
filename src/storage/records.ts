import { createHash, randomUUID } from "node:crypto";
import { inheritTaints } from "../integrity/taints.js";
import { type Citation, insertLinks } from "../integrity/provenance.js";
import { indexRecord } from "../retrieval/search.js";
import type { RecordRow } from "../retrieval/eligibility.js";
import type { StoredTestRun } from "../retrieval/freshness.js";
import type { Applicability, Attribution, ExternalRef, Freshness, RecordKind, ReviewState } from "../schemas.js";
import { type Db, prepared, requireTransaction } from "./database.js";

export interface NewRecord {
  kind: RecordKind;
  title: string | null;
  body: string;
  /** null = workspace-level (visible to every workstream). */
  workstreamId: string | null;
  sessionId: string;
  host: string;
  attribution: Attribution;
  reviewState: ReviewState;
  /** A reported test run is stored with the applicability it has: the state it ran against. */
  applicability: Applicability & { testRun?: StoredTestRun };
  externalRefs: readonly ExternalRef[];
  links: readonly Citation[];
  /** The transcript or external source the record was imported from. */
  sourceId?: string;
  /** When the content was observed, if earlier than now (imported history); defaults to now. */
  createdAt?: string;
  /**
   * `strict` (default, agent writes): every link target must be current guidance.
   * `inherit` (the importer): a target only needs to be in scope, and the new record takes on
   * the state of what it restates or rests on (see `inheritTaints`), so a copy of a corrected
   * claim is stored as ineligible instead of resurrecting it.
   */
  lineage?: "strict" | "inherit";
}

/**
 * Appends one canonical record together with its provenance links and search chunks.
 *
 * Must run inside a write transaction owned by the caller, which is what makes
 * "record + links + chunks (+ operation row / checkpoint row)" commit or roll back as
 * one unit. Link targets are scope-checked against the *writer's* workstream, even
 * when the new record itself is workspace-level.
 *
 * `content_hash` covers the canonical content (kind, title, body, refs, applicability)
 * so later slices can detect duplicate bodies without merging distinct observations.
 */
export function appendRecord(db: Db, scopeWorkstreamId: string, record: NewRecord): { recordId: string; createdAt: string; links: Citation[] } {
  requireTransaction(db, "appendRecord");
  const recordId = `rec_${randomUUID().replaceAll("-", "")}`;
  const createdAt = record.createdAt ?? new Date().toISOString();
  const applicability = JSON.stringify(record.applicability);
  const externalRefs = JSON.stringify(record.externalRefs);
  const contentHash =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify([record.kind, record.title, record.body, externalRefs, applicability]))
      .digest("hex");
  prepared(
    db,
    `INSERT INTO records (id, kind, title, body, workstream_id, session_id, source_id, host, attribution, review_state,
       applicability, external_refs, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    recordId,
    record.kind,
    record.title,
    record.body,
    record.workstreamId,
    record.sessionId,
    record.sourceId ?? null,
    record.host,
    record.attribution,
    record.reviewState,
    applicability,
    externalRefs,
    contentHash,
    createdAt,
  );
  const lineage = record.lineage ?? "strict";
  const links = insertLinks(db, scopeWorkstreamId, recordId, record.links, createdAt, lineage);
  if (lineage === "inherit") inheritTaints(db, recordId, links, createdAt);
  indexRecord(db, { id: recordId, title: record.title, body: record.body, externalRefs: record.externalRefs });
  return { recordId, createdAt, links };
}

/** The typed, parsed fields every view of a stored record shares (the one row→view mapping). */
export interface RecordFields {
  kind: RecordKind;
  attribution: Attribution;
  reviewState: ReviewState;
  freshness: Freshness;
  applicability: Applicability;
  externalRefs: ExternalRef[];
  testRun: StoredTestRun | null;
  workspaceLevel: boolean;
}

export function recordFields(row: RecordRow): RecordFields {
  const { testRun, ...applicability } = JSON.parse(row.applicability) as Applicability & { testRun?: StoredTestRun };
  return {
    kind: row.kind as RecordKind,
    attribution: row.attribution as Attribution,
    reviewState: row.review_state as ReviewState,
    freshness: row.freshness as Freshness,
    applicability,
    externalRefs: JSON.parse(row.external_refs) as ExternalRef[],
    testRun: testRun ?? null,
    workspaceLevel: row.workstream_id === null,
  };
}
