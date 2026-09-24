/**
 * Schema version 4: explicit workstream resolution (issue #20).
 *
 * - `workstreams.task_key`: the normalised explicit task identity (issue/PR number, URL,
 *   tracker key) a workstream was bound to. It outranks branch evidence during resolution.
 * - `workstreams.branch`: the branch its worktree was last seen on. Branch evidence only
 *   ever *suggests* a workstream; it never binds one on its own.
 * - `sessions.workstream_id` becomes nullable: a session whose workstream is ambiguous is
 *   workspace-level until the user chooses. SQLite cannot drop NOT NULL in place, so the
 *   table is rebuilt with SQLite's documented procedure (the runner disables foreign keys
 *   for the step and runs `foreign_key_check` before committing). Session ids are kept, so
 *   every reference from records, operations and import cursors stays valid.
 */
export const sql = /* sql */ `
ALTER TABLE workstreams ADD COLUMN task_key TEXT;
ALTER TABLE workstreams ADD COLUMN branch TEXT;
UPDATE workstreams SET branch = label;
CREATE INDEX workstreams_task ON workstreams (task_key) WHERE task_key IS NOT NULL;

CREATE TABLE sessions_v4 (
  id              TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  host_session_id TEXT,
  workstream_id   TEXT REFERENCES workstreams (id),          -- NULL = workspace-level (scope ambiguous)
  capabilities    TEXT NOT NULL DEFAULT '{}',
  started_at      TEXT NOT NULL
) STRICT;
INSERT INTO sessions_v4 (id, host, host_session_id, workstream_id, capabilities, started_at)
  SELECT id, host, host_session_id, workstream_id, capabilities, started_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v4 RENAME TO sessions;
CREATE INDEX sessions_host_session ON sessions (host, host_session_id) WHERE host_session_id IS NOT NULL;
`;
