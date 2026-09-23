import { createHash, randomUUID } from "node:crypto";
import { type Citation, insertLinks } from "../integrity/provenance.js";
import { indexRecord } from "../retrieval/search.js";
import type { Applicability, Attribution, ExternalRef, RecordKind, ReviewState } from "../schemas.js";
import type { Db } from "./database.js";

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
  applicability: Applicability;
  externalRefs: readonly ExternalRef[];
  links: readonly Citation[];
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
  const recordId = `rec_${randomUUID().replaceAll("-", "")}`;
  const createdAt = new Date().toISOString();
  const applicability = JSON.stringify(record.applicability);
  const externalRefs = JSON.stringify(record.externalRefs);
  const contentHash =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify([record.kind, record.title, record.body, externalRefs, applicability]))
      .digest("hex");
  db.prepare(
    `INSERT INTO records (id, kind, title, body, workstream_id, session_id, host, attribution, review_state,
       applicability, external_refs, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    recordId,
    record.kind,
    record.title,
    record.body,
    record.workstreamId,
    record.sessionId,
    record.host,
    record.attribution,
    record.reviewState,
    applicability,
    externalRefs,
    contentHash,
    createdAt,
  );
  const links = insertLinks(db, scopeWorkstreamId, recordId, record.links, createdAt);
  indexRecord(db, { id: recordId, title: record.title, body: record.body, externalRefs: record.externalRefs });
  return { recordId, createdAt, links };
}
