/**
 * Schema version 2: durable transcript import (issue #19).
 *
 * `import_cursors` was reserved by version 1 with a placeholder shape, and no version-1
 * build ever wrote it, so it is recreated with the columns reconciliation needs rather
 * than altered column by column.
 *
 * Invariants:
 * - A cursor row and the records it covers commit in the same transaction: `byte_offset`
 *   never points past evidence that is not durable.
 * - `anchor_hash` is the SHA-256 of the (up to) 4 KiB immediately before `byte_offset`.
 *   A file whose bytes there no longer match was rewritten or truncated, and is
 *   reconciled by event identity from the start instead of being appended to blindly.
 * - `import_events` is keyed by the full event identity *and* its content hash, so a
 *   replay of the same event is a no-op and a changed event is a distinct, explicit
 *   version. `seen_epoch` lets a reconciliation pass count events that disappeared.
 */
export const sql = /* sql */ `
DROP TABLE import_cursors;

CREATE TABLE import_cursors (
  host           TEXT NOT NULL,
  transcript_id  TEXT NOT NULL,
  path           TEXT NOT NULL,
  source_id      TEXT NOT NULL REFERENCES sources (id),
  session_id     TEXT NOT NULL REFERENCES sessions (id),
  workstream_id  TEXT NOT NULL REFERENCES workstreams (id),
  byte_offset    INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
  anchor_hash    TEXT,
  file_size      INTEGER NOT NULL DEFAULT 0,
  file_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  -- Bumped when a rewrite forces a pass from the start; see import_events.seen_epoch.
  epoch          INTEGER NOT NULL DEFAULT 0,
  -- active: import continues; stopped: unsupported format, retried from the same offset;
  -- quarantined: scope could not be decided, nothing past byte_offset is imported.
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped', 'quarantined')),
  gap            TEXT,
  stats          TEXT NOT NULL DEFAULT '{}',
  host_version   TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (host, transcript_id)
) STRICT;

CREATE TABLE import_events (
  host          TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  branch        TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  record_id     TEXT REFERENCES records (id),
  -- record: stored as a record; tool_call: held to describe its result; echo: Memchor's
  -- own output seen in the transcript (references kept in meta, never a record).
  disposition   TEXT NOT NULL CHECK (disposition IN ('record', 'tool_call', 'echo')),
  meta          TEXT NOT NULL DEFAULT '{}',
  seen_epoch    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (host, transcript_id, branch, event_id, content_hash)
) STRICT;
CREATE INDEX import_events_record ON import_events (record_id);
`;
