import type { Taint } from "../retrieval/eligibility.js";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import type { Citation } from "./provenance.js";
import { restatable, restates } from "./restatement.js";

/**
 * Taints: why a record whose own lifecycle is `active` is still not current guidance.
 *
 * A taint row (record, cause, kind) says the record depends on `cause`, a claim that was
 * corrected, retracted, superseded or forgotten. There is one row per cause, so a record is
 * eligible again only once every cause is gone (a restore deletes its own rows only).
 *
 * | Dependency on the cause                                        | wrong / removed | outdated (superseded) |
 * |----------------------------------------------------------------|-----------------|-----------------------|
 * | `derived_from` (restates it)                                   | invalidated     | invalidated           |
 * | `supported_by` (rests on it)                                   | quarantined     | —                     |
 * | checkpoint repeating it verbatim, host summary written after it | quarantined     | —                     |
 *
 * A superseded claim was true when made, so conclusions that rested on it stay; only copies of
 * it go. The last row covers summaries without fine-grained lineage: they are quarantined as a
 * whole rather than partly trusted (PRD §13.6). Taints propagate transitively: a restatement of
 * an invalidated record is invalidated, and anything resting on a tainted record is quarantined.
 */

export type Propagation = "wrong" | "outdated" | "removed";

/**
 * Host summaries are the only imported notes (see `messageRecord` in import/reconcile.ts). They
 * summarise a transcript range without saying which events they drew on.
 */
const HOST_SUMMARY_SQL = `(s.kind = 'note' AND s.source_id IS NOT NULL)`;

/** Taint propagation is bounded: chains are short in practice; the caps only guard pathological graphs. */
const MAX_DEPTH = 16;
const MAX_TAINTED = 10_000;
/** Most recent checkpoints scanned for a verbatim repeat of the cause. */
const CHECKPOINT_SCAN = 1_000;

/**
 * Taints everything that depends on `roots` (the cause and its copies) with `causeId`, and
 * returns each tainted record with its kind. Call inside the lifecycle change's transaction.
 */
export function taintDependents(db: Db, causeId: string, roots: readonly string[], mode: Propagation, now: string): Map<string, Taint> {
  requireTransaction(db, "taintDependents");
  const relations = mode === "outdated" ? ["derived_from"] : ["derived_from", "supported_by"];
  const incoming = prepared(
    db,
    `SELECT from_id, to_id, relation FROM links WHERE to_id IN (SELECT value FROM json_each($ids)) AND relation IN (SELECT value FROM json_each($relations))
     ORDER BY CASE relation WHEN 'derived_from' THEN 0 ELSE 1 END, from_id`,
  );
  const rootSet = new Set(roots);
  const tainted = new Map<string, Taint>();
  let frontier = [...rootSet];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && tainted.size < MAX_TAINTED; depth++) {
    const rows = incoming.all({ ids: JSON.stringify(frontier), relations: JSON.stringify(relations) }) as { from_id: string; to_id: string; relation: string }[];
    frontier = [];
    for (const row of rows) {
      if (rootSet.has(row.from_id)) continue;
      // Restating a quarantined conclusion is quarantined, not invalidated: the conclusion itself was never shown wrong.
      const kind: Taint = row.relation === "derived_from" ? (tainted.get(row.to_id) ?? "invalidated") : "quarantined";
      const previous = tainted.get(row.from_id);
      if (previous === undefined) {
        tainted.set(row.from_id, kind);
        frontier.push(row.from_id);
      } else if (previous === "quarantined" && kind === "invalidated") {
        tainted.set(row.from_id, kind);
      }
    }
  }
  if (mode !== "outdated") for (const id of withoutLineage(db, roots)) if (!rootSet.has(id) && !tainted.has(id)) tainted.set(id, "quarantined");

  const insert = prepared(
    db,
    `INSERT INTO taints (record_id, cause_id, taint, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (record_id, cause_id) DO UPDATE SET taint = 'invalidated' WHERE excluded.taint = 'invalidated'`,
  );
  for (const [id, kind] of tainted) insert.run(id, causeId, kind, now);
  return tainted;
}

/**
 * Summaries that may repeat the roots but cite nothing: checkpoints in the roots' scope whose
 * body contains a root's claim verbatim ({@link restatable}), and host summaries imported from
 * a root's transcript at or after the root's event.
 */
function withoutLineage(db: Db, roots: readonly string[]): string[] {
  const rows = prepared(db, "SELECT id, body, workstream_id, source_id, created_at FROM records WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(roots)) as {
    id: string;
    body: string;
    workstream_id: string | null;
    source_id: string | null;
    created_at: string;
  }[];
  const found = new Set<string>();
  const checkpoints = prepared(
    db,
    `SELECT id, body FROM records WHERE kind = 'checkpoint' AND ($workstreamId IS NULL OR workstream_id = $workstreamId) ORDER BY seq DESC LIMIT ${CHECKPOINT_SCAN}`,
  );
  const summaries = prepared(db, `SELECT s.id FROM records s WHERE ${HOST_SUMMARY_SQL} AND s.source_id = ? AND s.created_at >= ?`);
  for (const root of rows) {
    const pieces = restatable(root.body);
    for (const checkpoint of checkpoints.all({ workstreamId: root.workstream_id }) as { id: string; body: string }[]) {
      if (restates(checkpoint.body, pieces)) found.add(checkpoint.id);
    }
    if (root.source_id !== null) for (const summary of summaries.all(root.source_id, root.created_at) as { id: string }[]) found.add(summary.id);
  }
  return [...found];
}

/**
 * Gives a newly imported record the state of what it copies or rests on (the importer's
 * `lineage: "inherit"`): a link to a claim that is no longer active, or to a tainted record,
 * taints the new record by the same rules as {@link taintDependents}.
 */
export function inheritTaints(db: Db, recordId: string, links: readonly Citation[], now: string): void {
  requireTransaction(db, "inheritTaints");
  const target = prepared(db, "SELECT lifecycle FROM records WHERE id = ?");
  const targetTaints = prepared(db, "SELECT cause_id, taint FROM taints WHERE record_id = ?");
  const insert = prepared(
    db,
    `INSERT INTO taints (record_id, cause_id, taint, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (record_id, cause_id) DO UPDATE SET taint = 'invalidated' WHERE excluded.taint = 'invalidated'`,
  );
  for (const link of links) {
    if (link.relation !== "derived_from" && link.relation !== "supported_by") continue;
    const restates = link.relation === "derived_from";
    const { lifecycle } = target.get(link.recordId) as { lifecycle: string };
    if (lifecycle !== "active" && (restates || lifecycle !== "superseded")) insert.run(recordId, link.recordId, restates ? "invalidated" : "quarantined", now);
    for (const row of targetTaints.all(link.recordId) as { cause_id: string; taint: Taint }[]) insert.run(recordId, row.cause_id, restates ? row.taint : "quarantined", now);
  }
}

/**
 * Quarantines a host summary imported after its transcript's corrected, retracted or
 * forgotten events: it may repeat them and has no finer lineage.
 */
export function quarantineLateSummary(db: Db, recordId: string): void {
  requireTransaction(db, "quarantineLateSummary");
  prepared(
    db,
    `INSERT OR IGNORE INTO taints (record_id, cause_id, taint, created_at)
     SELECT s.id, r.id, 'quarantined', s.created_at FROM records s JOIN records r ON r.source_id = s.source_id
     WHERE s.id = ? AND r.id <> s.id AND r.created_at <= s.created_at AND r.lifecycle IN ('corrected', 'retracted', 'forgotten')`,
  ).run(recordId);
}

/** Whether a new copy or version of this host event must be skipped at import (its claim is no longer active). */
export function suppressedEvent(db: Db, host: string, eventId: string): boolean {
  return prepared(db, "SELECT 1 FROM suppressions WHERE host = ? AND event_id = ? LIMIT 1").get(host, eventId) !== undefined;
}
