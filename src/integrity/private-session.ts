import { type Db, prepared, requireTransaction } from "../storage/database.js";
import type { PrivateSessionEntry } from "./ledger.js";

/**
 * Private sessions ("don't remember this session"): the markers and lookups. Marking itself,
 * which also forgets what the session left behind, is `forgetSession` in lifecycle.ts.
 *
 * A session is private when its own row says so, or when another session of the same host
 * session is private (a resumed Codex thread starts a new Memchor session with the same thread
 * id). Its transcripts are found two ways: the host session id is the transcript id (Codex), or
 * the transcript's Memchor output names the session (`transcript_sessions`, recorded at import;
 * Claude Code sends no session id). A private transcript is never imported again.
 */

/**
 * The session a Memchor result was returned to: `scope.sessionId`, which in every result follows
 * `scope.headRevision`. Pack items and checkpoints also carry a `sessionId` (the session that
 * wrote the record), but never after `headRevision`, so a recall of another session's records
 * never links this transcript to that session. Matched as text, so output Codex truncated still counts.
 */
const SCOPE_SESSION = /"headRevision":\d+,"sessionId":"(ses_[0-9a-f]{32})"/g;

export function sessionIsPrivate(db: Db, session: { sessionId: string; host: string; hostSessionId: string | undefined }): boolean {
  return (
    prepared(db, "SELECT 1 FROM sessions WHERE private = 1 AND (id = $id OR ($hostSessionId IS NOT NULL AND host = $host AND host_session_id = $hostSessionId)) LIMIT 1").get({
      id: session.sessionId,
      host: session.host,
      hostSessionId: session.hostSessionId ?? null,
    }) !== undefined
  );
}

export function isPrivateTranscript(db: Db, host: string, transcriptId: string): boolean {
  return prepared(db, "SELECT 1 FROM private_transcripts WHERE host = ? AND transcript_id = ?").get(host, transcriptId) !== undefined;
}

/**
 * Records which Memchor sessions a transcript's Memchor output names, and says whether any of
 * them is private (the importer then drops the transcript). Call inside the import batch.
 */
export function linkTranscriptSessions(db: Db, host: string, transcriptId: string, memchorOutput: string): { privateSessionId: string | null } {
  requireTransaction(db, "linkTranscriptSessions");
  const named = [...new Set([...memchorOutput.matchAll(SCOPE_SESSION)].map((match) => match[1] ?? ""))];
  let found: string | null = null;
  const known = prepared(db, "SELECT private FROM sessions WHERE id = ?");
  const link = prepared(db, "INSERT OR IGNORE INTO transcript_sessions (host, transcript_id, session_id) VALUES (?, ?, ?)");
  for (const sessionId of named) {
    const row = known.get(sessionId) as { private: number } | undefined;
    if (row === undefined) continue;
    link.run(host, transcriptId, sessionId);
    if (row.private === 1) found = sessionId;
  }
  return { privateSessionId: found };
}

/** The transcripts that belong to a session: its host session id, and every transcript whose Memchor output named it. */
export function transcriptsOf(db: Db, session: { sessionId: string; host: string; hostSessionId: string | undefined }): { host: string; transcriptId: string }[] {
  const linked = prepared(db, "SELECT host, transcript_id AS transcriptId FROM transcript_sessions WHERE session_id = ?").all(session.sessionId) as { host: string; transcriptId: string }[];
  const own = session.hostSessionId === undefined ? [] : [{ host: session.host, transcriptId: session.hostSessionId }];
  return [...new Map([...own, ...linked].map((t) => [`${t.host}\u0000${t.transcriptId}`, t])).values()];
}

/** Marks the session and its transcripts private (live, or replayed from the ledger into a restored copy). */
export function applyPrivateSession(db: Db, entry: PrivateSessionEntry): void {
  requireTransaction(db, "applyPrivateSession");
  prepared(db, "UPDATE sessions SET private = 1 WHERE id = ?").run(entry.sessionId);
  const mark = prepared(db, "INSERT OR IGNORE INTO private_transcripts (host, transcript_id, session_id, created_at) VALUES (?, ?, ?, ?)");
  for (const transcript of entry.transcripts) mark.run(transcript.host, transcript.transcriptId, entry.sessionId, entry.at);
}

/** Whether a ledger entry's markers are all present (a restored older copy lacks them). */
export function privateSessionApplied(db: Db, entry: PrivateSessionEntry): boolean {
  const session = prepared(db, "SELECT private FROM sessions WHERE id = ?").get(entry.sessionId) as { private: number } | undefined;
  if (session !== undefined && session.private !== 1) return false;
  return entry.transcripts.every((transcript) => isPrivateTranscript(db, transcript.host, transcript.transcriptId));
}
