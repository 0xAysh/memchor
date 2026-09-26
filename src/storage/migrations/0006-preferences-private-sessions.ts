/**
 * Schema version 6: preferences confirmed by the user, and private sessions (issue #21).
 *
 * - `preference_candidates`: a preference an agent proposed (or a change/removal it inferred)
 *   that the user has not answered yet. A candidate is a question, not memory: it is never a
 *   record, so it can never be recalled, read or injected. Answering it deletes the row (and,
 *   for "everywhere" / "this repo" / "yes", writes or changes the preference record).
 *   `reasked_session` is the later session that put it to the user once more; after that it is
 *   dropped. `relay` says whether the agent may relay the user's answer (`refused` once the user
 *   was asked directly and dismissed it).
 * - `sessions.private`: "don't remember this session". Its writes are refused, and transcripts
 *   that belong to it are never imported.
 * - `transcript_sessions`: which Memchor sessions a transcript's Memchor output names, so that
 *   marking a session private can find its transcript (Claude Code sends no session id).
 * - `private_transcripts`: transcripts that are never imported again. No foreign keys: markers
 *   outlive what they name, and a restored older database gets them back from the ledger.
 */
export const sql = /* sql */ `
CREATE TABLE preference_candidates (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('new', 'change', 'remove')),
  body            TEXT NOT NULL,
  target_id       TEXT,
  target_scope    TEXT CHECK (target_scope IN ('global', 'repo')),
  reason          TEXT,
  session_id      TEXT NOT NULL,
  reasked_session TEXT,
  relay           TEXT NOT NULL DEFAULT 'allowed' CHECK (relay IN ('allowed', 'refused')),
  host            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK ((kind = 'new') = (target_id IS NULL))
) STRICT;

ALTER TABLE sessions ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1));

CREATE TABLE transcript_sessions (
  host          TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  PRIMARY KEY (host, transcript_id, session_id)
) STRICT;
CREATE INDEX transcript_sessions_session ON transcript_sessions (session_id);

CREATE TABLE private_transcripts (
  host          TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  session_id    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (host, transcript_id)
) STRICT;
`;
