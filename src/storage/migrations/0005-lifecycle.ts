/**
 * Schema version 5: correctable memory (issue #21).
 *
 * - `records.lifecycle`: what happened to the claim itself. `active` is current guidance;
 *   `corrected` (wrong, replaced by a correction), `superseded` (right when made, replaced by a
 *   newer version), `retracted` (wrong, withdrawn; restorable) and `forgotten` (payload removed)
 *   are distinct states that are never folded into `review_state`, which stays the review axis
 *   (unreviewed / accepted / disputed). Records the v3 migration retracted become `retracted`.
 * - `taints`: records that are ineligible because of *another* record. One row per cause, so a
 *   record resting on two retracted claims stays ineligible until both are restored.
 *   `invalidated` = it restates the cause (`derived_from`); `quarantined` = it rests on the cause
 *   or summarises it without fine-grained lineage.
 * - `lifecycle_events`: the append-only audit history of every lifecycle change. Its `seq` is
 *   the correction watermark a running session compares against; `ledger_id` ties it to the
 *   workspace's lifecycle ledger (`lifecycle.jsonl`), which re-applies changes a restored older
 *   copy of the database lacks.
 * - `suppressions`: host events whose claim is no longer active. The importer skips any new
 *   copy or version of such an event, so a transcript replay cannot resurrect it.
 *
 * `lifecycle_events` and `suppressions` hold ids without foreign keys on purpose: they are
 * markers that must outlive the rows they name (a ledger replay into a database that never had
 * the record; retention deleting a record's row later).
 */
export const sql = /* sql */ `
ALTER TABLE records ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle IN ('active', 'corrected', 'superseded', 'retracted', 'forgotten'));
UPDATE records SET lifecycle = 'retracted' WHERE review_state = 'retracted';

CREATE TABLE taints (
  record_id  TEXT NOT NULL REFERENCES records (id),
  cause_id   TEXT NOT NULL REFERENCES records (id),
  taint      TEXT NOT NULL CHECK (taint IN ('invalidated', 'quarantined')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (record_id, cause_id)
) STRICT;
CREATE INDEX taints_cause ON taints (cause_id);

CREATE TABLE lifecycle_events (
  seq            INTEGER PRIMARY KEY,
  ledger_id      TEXT NOT NULL UNIQUE,
  record_id      TEXT NOT NULL,
  workstream_id  TEXT,                                      -- NULL = a workspace-level record
  action         TEXT NOT NULL CHECK (action IN ('correct', 'supersede', 'retract', 'restore', 'forget')),
  replacement_id TEXT,
  reason         TEXT NOT NULL,
  attribution    TEXT NOT NULL CHECK (attribution IN ('user_direction', 'direct_observation', 'agent_inference')),
  session_id     TEXT,
  host           TEXT NOT NULL,
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX lifecycle_events_record ON lifecycle_events (record_id);

CREATE TABLE suppressions (
  host       TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  cause_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host, event_id, cause_id)
) STRICT;
CREATE INDEX suppressions_cause ON suppressions (cause_id);
`;
