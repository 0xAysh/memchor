/**
 * Schema version 3: whole-source fingerprints for caught-up transcript cursors.
 *
 * The trailing anchor keeps append resumption cheap, but cannot detect an in-place edit
 * before that anchor when file size is unchanged. A fingerprint is recorded atomically
 * with the caught-up cursor and checked on the next reconciliation. Existing cursors get
 * NULL and therefore perform one full reconciliation before establishing a fingerprint.
 *
 * Version 2 briefly stored adapter-produced tool summaries in import_events.meta and
 * copied them into tool-result records and the search projection. The schema did not
 * retain a structured boundary between a bounded summary and result output, so the only
 * safe migration is to retract and replace those result records wholesale. Their ids,
 * import provenance and links remain intact. Non-tool transcript records remain usable.
 */
export const sql = /* sql */ `
ALTER TABLE import_cursors ADD COLUMN source_hash TEXT;

-- External-content FTS can otherwise retain terms for chunks changed below.
INSERT INTO chunks_fts (chunks_fts) VALUES ('delete-all');

-- Prefer the durable v2 call/result identity: same host, transcript and branch plus callId,
-- with the result's record_id naming the canonical row. Some early v2 result rows omitted
-- callId from meta; imported tool results are still provable without title heuristics because
-- they alone are transcript import_events records attributed as direct_observation.
CREATE TEMP TABLE migration_v3_legacy_tool_results (
  record_id TEXT PRIMARY KEY
) WITHOUT ROWID;

INSERT OR IGNORE INTO migration_v3_legacy_tool_results (record_id)
SELECT result.record_id
FROM import_events AS result
JOIN import_events AS call
  ON call.host = result.host
 AND call.transcript_id = result.transcript_id
 AND call.branch = result.branch
 AND call.disposition = 'tool_call'
 AND json_extract(call.meta, '$.callId') = json_extract(result.meta, '$.callId')
WHERE result.disposition = 'record'
  AND result.record_id IS NOT NULL
  AND json_type(result.meta, '$.callId') = 'text';

INSERT OR IGNORE INTO migration_v3_legacy_tool_results (record_id)
SELECT result.record_id
FROM import_events AS result
JOIN records AS record ON record.id = result.record_id
WHERE result.disposition = 'record'
  AND result.record_id IS NOT NULL
  AND record.attribution = 'direct_observation';

DELETE FROM chunks
WHERE record_id IN (SELECT record_id FROM migration_v3_legacy_tool_results);

UPDATE records
SET title = 'Legacy imported tool result removed',
    body = 'Content removed during schema v3 migration because legacy tool-call arguments may have been embedded in this record.',
    external_refs = '[]',
    content_hash = 'migration:v3:legacy-tool-result-quarantined',
    review_state = 'retracted',
    retracted_at = coalesce(retracted_at, 'migration-v3')
WHERE id IN (SELECT record_id FROM migration_v3_legacy_tool_results);

-- Keep the derived projection internally consistent now; the normal rebuild operation
-- can later regenerate the identical title/body chunks from canonical records.
INSERT INTO chunks (record_id, ordinal, field, text)
SELECT id, 0, 'title', title FROM records
WHERE content_hash = 'migration:v3:legacy-tool-result-quarantined';
INSERT INTO chunks (record_id, ordinal, field, text)
SELECT id, 1, 'body', body FROM records
WHERE content_hash = 'migration:v3:legacy-tool-result-quarantined';
INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');
INSERT INTO chunks_fts (chunks_fts) VALUES ('integrity-check');

UPDATE import_events
SET meta = json_object(
  'callId', json_extract(meta, '$.callId'),
  'tool', 'Tool',
  'summary', 'Tool call [legacy arguments removed]',
  'retention', coalesce(json_extract(meta, '$.retention'), json_extract(meta, '$.output'), 'passage'),
  'paths', json('[]'),
  'urls', json('[]'),
  'sensitive', json('true')
)
WHERE disposition = 'tool_call';

DROP TABLE migration_v3_legacy_tool_results;
`;
