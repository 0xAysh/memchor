/**
 * Schema version 1: the canonical store for issue #18.
 *
 * Canonical tables (recovery source): workspaces, workstreams, worktree_bindings,
 * sessions, sources, records, links, checkpoints, operations, consents, import_cursors.
 * Derived projections (rebuildable from `records`): chunks, chunks_fts.
 *
 * Columns that later slices need (sources, consents, import_cursors, superseded_by,
 * retracted_at, freshness) are created now so those slices do not force a migration.
 */
export const sql = /* sql */ `
CREATE TABLE workspaces (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  repository_key      TEXT NOT NULL,
  root_commit         TEXT,
  continuation_secret BLOB NOT NULL,
  created_at          TEXT NOT NULL
) STRICT;

CREATE TABLE workstreams (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  lifecycle     TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'paused', 'done', 'archived')),
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  created_at    TEXT NOT NULL
) STRICT;

-- A worktree (realpath of its top level) is bound to exactly one workstream.
CREATE TABLE worktree_bindings (
  worktree_path TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams (id),
  bound_at      TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  host_session_id TEXT,
  workstream_id   TEXT NOT NULL REFERENCES workstreams (id),
  capabilities    TEXT NOT NULL DEFAULT '{}',
  started_at      TEXT NOT NULL
) STRICT;

CREATE TABLE sources (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('transcript', 'external')),
  host       TEXT,
  locator    TEXT NOT NULL,
  version    TEXT,
  freshness  TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('current', 'stale', 'unknown')),
  created_at TEXT NOT NULL,
  UNIQUE (kind, host, locator)
) STRICT;

-- Append-oriented: rows are inserted, never rewritten, in #18. 'seq' gives a total
-- creation order used for deterministic tie-breaks; 'id' is the public identifier.
CREATE TABLE records (
  seq            INTEGER PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('evidence', 'note', 'preference', 'constraint', 'decision',
                   'attempt', 'question', 'next_step', 'reference', 'checkpoint', 'correction')),
  title          TEXT,
  body           TEXT NOT NULL,
  workstream_id  TEXT REFERENCES workstreams (id),          -- NULL = workspace-level
  session_id     TEXT REFERENCES sessions (id),
  source_id      TEXT REFERENCES sources (id),
  host           TEXT NOT NULL,
  attribution    TEXT NOT NULL CHECK (attribution IN ('user_direction', 'direct_observation', 'agent_inference')),
  review_state   TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'accepted', 'disputed', 'retracted')),
  applicability  TEXT NOT NULL DEFAULT '{}',
  freshness      TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('current', 'stale', 'unknown')),
  external_refs  TEXT NOT NULL DEFAULT '[]',
  content_hash   TEXT NOT NULL,
  superseded_by  TEXT REFERENCES records (id),
  retracted_at   TEXT,
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX records_scope ON records (workstream_id, seq);

CREATE TABLE links (
  from_id    TEXT NOT NULL REFERENCES records (id),
  to_id      TEXT NOT NULL REFERENCES records (id),
  relation   TEXT NOT NULL CHECK (relation IN ('supported_by', 'derived_from', 'supersedes', 'references', 'related_to')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
) STRICT;
CREATE INDEX links_to ON links (to_id);

-- Head revision lives on workstreams.head_revision; this table is the append-only history.
-- UNIQUE(workstream_id, revision) backs the compare-and-swap in checkpoints.ts.
CREATE TABLE checkpoints (
  workstream_id TEXT NOT NULL REFERENCES workstreams (id),
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  record_id     TEXT NOT NULL UNIQUE REFERENCES records (id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (workstream_id, revision)
) STRICT;

CREATE TABLE operations (
  key          TEXT PRIMARY KEY,
  operation    TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  session_id   TEXT REFERENCES sessions (id),
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE consents (
  host       TEXT PRIMARY KEY,
  choice     TEXT NOT NULL CHECK (choice IN ('all', 'current_project', 'none')),
  decided_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_cursors (
  host          TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  position      TEXT NOT NULL,
  content_hash  TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (host, transcript_id)
) STRICT;

-- Derived search projection. Never read as canonical content.
CREATE TABLE chunks (
  id        INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records (id),
  ordinal   INTEGER NOT NULL,
  field     TEXT NOT NULL CHECK (field IN ('title', 'body', 'refs')),
  text      TEXT NOT NULL,
  UNIQUE (record_id, ordinal)
) STRICT;

CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  text,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;
