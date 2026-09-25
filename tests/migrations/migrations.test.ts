import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { rebuildSearchIndex } from "../../src/retrieval/search.js";
import { openDatabase, SCHEMA_VERSION, writeTransaction } from "../../src/storage/database.js";
import { sql as schemaV1 } from "../../src/storage/migrations/0001-initial.js";
import { sql as schemaV2 } from "../../src/storage/migrations/0002-transcript-import.js";
import { sql as schemaV3 } from "../../src/storage/migrations/0003-import-source-fingerprint.js";
import { catchMemchorError, initRepo, tempDir } from "../helpers.js";

const CANONICAL_TABLES = [
  "checkpoints",
  "chunks",
  "chunks_fts",
  "consents",
  "import_cursors",
  "import_events",
  "links",
  "operations",
  "records",
  "sessions",
  "sources",
  "workspaces",
  "workstreams",
  "worktree_bindings",
];

function inspect(path: string): { version: number; tables: string[] } {
  const db = new Database(path, { readonly: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    const tables = (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts_%' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    return { version, tables };
  } finally {
    db.close();
  }
}

/** Creates a database file at schema version 0 (a bare SQLite file, as left by an interrupted first open). */
function atVersionZero(setup = ""): string {
  const path = join(tempDir(), "memory.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS placeholder_probe (x); DROP TABLE placeholder_probe; ${setup}`);
  db.close();
  return path;
}

describe("migrations", () => {
  test("this build introduces schema version 4", () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  test.each([1, 2, 3])("a version-%i database upgrades to version 4: sessions may be workspace-level and every reference survives", (from) => {
    const path = join(tempDir(), "memory.sqlite");
    const old = new Database(path);
    old.pragma("foreign_keys = ON");
    for (const step of [schemaV1, schemaV2, schemaV3].slice(0, from)) old.exec(step);
    old.pragma(`user_version = ${from}`);
    old.exec(`INSERT INTO workstreams (id, label, created_at) VALUES ('wst_1', 'feat/x', 'now');
      INSERT INTO sessions (id, host, host_session_id, workstream_id, started_at) VALUES ('ses_1', 'claude-code', 'host-1', 'wst_1', 'now');
      INSERT INTO records (id, kind, body, workstream_id, session_id, host, attribution, content_hash, created_at)
        VALUES ('rec_1', 'note', 'kept across the upgrade', 'wst_1', 'ses_1', 'claude-code', 'agent_inference', 'h', 'now');
      INSERT INTO operations (key, operation, request_hash, result_json, session_id, created_at) VALUES ('op', 'record', 'h', '{}', 'ses_1', 'now');`);
    if (from >= 2) {
      old.exec(`INSERT INTO sources (id, kind, host, locator, created_at) VALUES ('src_1', 'transcript', 'claude-code', 't', 'now');
        INSERT INTO import_cursors (host, transcript_id, path, source_id, session_id, workstream_id, updated_at) VALUES ('claude-code', 't', '/t.jsonl', 'src_1', 'ses_1', 'wst_1', 'now');`);
    }
    old.close();

    const db = openDatabase(path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT id, host, host_session_id, workstream_id FROM sessions").all()).toEqual([
        { id: "ses_1", host: "claude-code", host_session_id: "host-1", workstream_id: "wst_1" },
      ]);
      expect(db.prepare("SELECT id, label, branch, task_key FROM workstreams").all()).toEqual([{ id: "wst_1", label: "feat/x", branch: "feat/x", task_key: null }]);
      expect(db.prepare("SELECT session_id FROM records").all()).toEqual([{ session_id: "ses_1" }]);
      // A workspace-level session (no workstream chosen yet) is now representable; references still enforced.
      db.prepare("INSERT INTO sessions (id, host, workstream_id, started_at) VALUES ('ses_2', 'codex', NULL, 'now')").run();
      expect(() => db.prepare("INSERT INTO sessions (id, host, workstream_id, started_at) VALUES ('ses_3', 'codex', 'wst_missing', 'now')").run()).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("DELETE FROM sessions WHERE id = 'ses_1'").run()).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
    expect(inspect(path).tables).toEqual(CANONICAL_TABLES);
  });

  test("a version-1 database with memory upgrades to the current version and keeps every row", () => {
    const path = join(tempDir(), "memory.sqlite");
    const v1 = new Database(path);
    v1.exec(schemaV1);
    v1.pragma("user_version = 1");
    v1.exec(`INSERT INTO workstreams (id, label, created_at) VALUES ('wst_1', 'main', 'now');
      INSERT INTO sessions (id, host, workstream_id, started_at) VALUES ('ses_1', 'codex', 'wst_1', 'now');
      INSERT INTO records (id, kind, body, workstream_id, session_id, host, attribution, content_hash, created_at)
        VALUES ('rec_1', 'note', 'kept across the upgrade', 'wst_1', 'ses_1', 'codex', 'agent_inference', 'h', 'now');`);
    v1.close();

    openDatabase(path).close();
    expect(inspect(path)).toEqual({ version: SCHEMA_VERSION, tables: CANONICAL_TABLES });
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT id, body FROM records").all()).toEqual([{ id: "rec_1", body: "kept across the upgrade" }]);
    const cursorColumns = (db.pragma("table_info(import_cursors)") as { name: string }[]).map((c) => c.name);
    expect(cursorColumns).toEqual(expect.arrayContaining(["transcript_id", "byte_offset", "anchor_hash", "source_hash", "state", "gap", "stats"]));
    db.close();
  });

  test("a version-2 database scrubs legacy tool arguments from metadata, result records and search projections", () => {
    const path = join(tempDir(), "memory.sqlite");
    const v2 = new Database(path);
    v2.exec(schemaV1);
    v2.exec(schemaV2);
    v2.pragma("user_version = 2");
    const unknownHead = "LEGACY-UNKNOWN-RAW-HEAD";
    const unknownTail = "LEGACY-UNKNOWN-RAW-TAIL";
    const commandPrefix = "LEGACY-SENSITIVE-COMMAND-PREFIX";
    const commandSecret = "sk-live-LEGACYSECRETVALUE123456789";
    const commandSuffix = "LEGACY-SENSITIVE-COMMAND-SUFFIX";
    const unknownSummary = `FutureTool {"payload":"${unknownHead}${"x".repeat(800)}${unknownTail}"}`;
    const commandSummary = `$ ${commandPrefix}; export API_KEY=${commandSecret}; ${commandSuffix}`;
    const errorMarker = "LEGACY-ERROR-RESULT-MARKER";
    const longAsciiMarker = "LEGACY-LONG-ASCII-RESULT-MARKER";
    const unicodeMarker = "LEGACY-NON-BMP-RESULT-MARKER";
    const longAsciiTool = "A".repeat(210);
    const unicodeTool = "🛠".repeat(100); // 100 code points, 200 UTF-16 code units.
    const jsClip = (text: string): string => text.length <= 200 ? text : `${text.slice(0, 199)}…`;
    const unknownBody = `${unknownSummary}\n\nlegacy unknown result output that cannot be separated safely`;
    const commandBody = `${commandSummary}\n\nlegacy command result output that cannot be separated safely`;
    const errorBody = `ErrorTool ${errorMarker}\n\nlegacy error output`;
    const longAsciiBody = `${longAsciiTool} ${longAsciiMarker}\n\nlegacy long ASCII output`;
    const unicodeBody = `${unicodeTool} ${unicodeMarker}\n\nlegacy non-BMP output`;
    v2.exec(`INSERT INTO workstreams (id, label, created_at) VALUES ('wst_1', 'main', 'now');
      INSERT INTO sessions (id, host, workstream_id, started_at) VALUES ('ses_1', 'claude-code', 'wst_1', 'now');
      INSERT INTO sources (id, kind, host, locator, created_at) VALUES ('src_1', 'transcript', 'claude-code', 't', 'now');`);
    const insertRecord = v2.prepare(`INSERT INTO records
      (id, kind, title, body, workstream_id, session_id, source_id, host, attribution, content_hash, created_at)
      VALUES (?, 'evidence', ?, ?, 'wst_1', 'ses_1', 'src_1', 'claude-code', 'direct_observation', ?, 'now')`);
    insertRecord.run("rec_unknown", `FutureTool: ${unknownSummary}`, unknownBody, "legacy-unknown-hash");
    insertRecord.run("rec_command", `Bash: ${commandSummary}`, commandBody, "legacy-command-hash");
    insertRecord.run("rec_error", `ErrorTool (error): ErrorTool ${errorMarker}`, errorBody, "legacy-error-hash");
    insertRecord.run("rec_long_ascii", jsClip(`${longAsciiTool}: ${longAsciiTool} ${longAsciiMarker}`), longAsciiBody, "legacy-long-ascii-hash");
    insertRecord.run("rec_unicode", jsClip(`${unicodeTool}: ${unicodeTool} ${unicodeMarker}`), unicodeBody, "legacy-unicode-hash");
    insertRecord.run("rec_safe", null, "useful safe transcript observation remains available", "safe-hash");
    v2.exec(`UPDATE records SET attribution = 'agent_inference' WHERE id = 'rec_safe';
      INSERT INTO links (from_id, to_id, relation, created_at) VALUES ('rec_safe', 'rec_unknown', 'references', 'now');`);

    const insertEvent = v2.prepare(`INSERT INTO import_events
      (host, transcript_id, branch, event_id, content_hash, record_id, disposition, meta, seen_epoch, created_at)
      VALUES ('claude-code', 't', 'main', ?, ?, ?, ?, ?, 0, 'now')`);
    insertEvent.run("unknown-call", "call-hash-1", null, "tool_call", JSON.stringify({ callId: "call-1", tool: "FutureTool", summary: unknownSummary, output: "passage", paths: [], urls: [] }));
    // Earliest v2 rows omitted callId; direct_observation + import provenance is the fail-safe identity.
    insertEvent.run("unknown-result", "result-hash-1", "rec_unknown", "record", "{}");
    insertEvent.run("bash-call", "call-hash-2", null, "tool_call", JSON.stringify({ callId: "call-2", tool: "Bash", summary: commandSummary, output: "passage", paths: [], urls: [] }));
    insertEvent.run("bash-result", "result-hash-2", "rec_command", "record", JSON.stringify({ callId: "call-2" }));
    insertEvent.run("error-call", "call-hash-3", null, "tool_call", JSON.stringify({ callId: "call-3", tool: "ErrorTool", summary: `ErrorTool ${errorMarker}`, output: "passage", paths: [], urls: [] }));
    insertEvent.run("error-result", "result-hash-3", "rec_error", "record", JSON.stringify({ callId: "call-3" }));
    insertEvent.run("long-ascii-call", "call-hash-4", null, "tool_call", JSON.stringify({ callId: "call-4", tool: longAsciiTool, summary: `${longAsciiTool} ${longAsciiMarker}`, output: "passage", paths: [], urls: [] }));
    insertEvent.run("long-ascii-result", "result-hash-4", "rec_long_ascii", "record", JSON.stringify({ callId: "call-4" }));
    insertEvent.run("unicode-call", "call-hash-5", null, "tool_call", JSON.stringify({ callId: "call-5", tool: unicodeTool, summary: `${unicodeTool} ${unicodeMarker}`, output: "passage", paths: [], urls: [] }));
    insertEvent.run("unicode-result", "result-hash-5", "rec_unicode", "record", JSON.stringify({ callId: "call-5" }));
    insertEvent.run("safe-message", "safe-hash", "rec_safe", "record", "{}");

    const insertChunk = v2.prepare("INSERT INTO chunks (record_id, ordinal, field, text) VALUES (?, ?, ?, ?)");
    const insertFts = v2.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)");
    for (const [recordId, title, body] of [
      ["rec_unknown", `FutureTool: ${unknownSummary}`, unknownBody],
      ["rec_command", `Bash: ${commandSummary}`, commandBody],
      ["rec_error", `ErrorTool (error): ErrorTool ${errorMarker}`, errorBody],
      ["rec_long_ascii", jsClip(`${longAsciiTool}: ${longAsciiTool} ${longAsciiMarker}`), longAsciiBody],
      ["rec_unicode", jsClip(`${unicodeTool}: ${unicodeTool} ${unicodeMarker}`), unicodeBody],
      ["rec_safe", null, "useful safe transcript observation remains available"],
    ] as const) {
      let ordinal = 0;
      for (const [field, text] of [["title", title], ["body", body]] as const) {
        if (text === null) continue;
        const result = insertChunk.run(recordId, ordinal++, field, text);
        insertFts.run(result.lastInsertRowid, text);
      }
    }
    v2.close();

    const migrated = openDatabase(path);
    const columns = (migrated.pragma("table_info(import_cursors)") as { name: string }[]).map((column) => column.name);
    expect(columns).toContain("source_hash");
    const forbidden = [unknownHead, unknownTail, commandPrefix, commandSecret, commandSuffix, errorMarker, longAsciiMarker, unicodeMarker];
    const searchable = [
      JSON.stringify(migrated.prepare("SELECT * FROM import_events").all()),
      JSON.stringify(migrated.prepare("SELECT * FROM records").all()),
      JSON.stringify(migrated.prepare("SELECT * FROM chunks").all()),
      JSON.stringify(migrated.prepare("SELECT rowid, text FROM chunks_fts").all()),
    ].join("\n");
    for (const value of forbidden) expect(searchable).not.toContain(value);
    expect(migrated.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"legacy unknown raw head"'`).get()).toEqual({ n: 0 });
    expect(migrated.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"legacysecretvalue123456789"'`).get()).toEqual({ n: 0 });

    expect(migrated.prepare("SELECT id FROM records WHERE review_state = 'retracted' ORDER BY id").all()).toEqual([
      { id: "rec_command" },
      { id: "rec_error" },
      { id: "rec_long_ascii" },
      { id: "rec_unicode" },
      { id: "rec_unknown" },
    ]);
    expect(migrated.prepare("SELECT title, body, review_state, retracted_at FROM records WHERE id = 'rec_unicode'").get()).toEqual({
      title: "Legacy imported tool result removed",
      body: expect.stringContaining("schema v3 migration") as unknown,
      review_state: "retracted",
      retracted_at: "migration-v3",
    });
    expect(migrated.prepare("SELECT title, body, review_state, retracted_at FROM records WHERE id = 'rec_safe'").get()).toEqual({
      title: null,
      body: "useful safe transcript observation remains available",
      review_state: "unreviewed",
      retracted_at: null,
    });
    expect(migrated.prepare("SELECT from_id, to_id, relation FROM links").all()).toEqual([{ from_id: "rec_safe", to_id: "rec_unknown", relation: "references" }]);
    expect(migrated.prepare("SELECT event_id, record_id FROM import_events WHERE record_id IS NOT NULL ORDER BY event_id").all()).toEqual([
      { event_id: "bash-result", record_id: "rec_command" },
      { event_id: "error-result", record_id: "rec_error" },
      { event_id: "long-ascii-result", record_id: "rec_long_ascii" },
      { event_id: "safe-message", record_id: "rec_safe" },
      { event_id: "unicode-result", record_id: "rec_unicode" },
      { event_id: "unknown-result", record_id: "rec_unknown" },
    ]);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(() => migrated.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('integrity-check')")).not.toThrow();
    expect(writeTransaction(migrated, () => rebuildSearchIndex(migrated))).toEqual({ records: 6, chunks: 11 });
    const rebuilt = JSON.stringify(migrated.prepare("SELECT rowid, text FROM chunks_fts").all());
    for (const value of forbidden) expect(rebuilt).not.toContain(value);
    migrated.close();
  });

  test("a new database is created at the current schema version", () => {
    const path = join(tempDir(), "nested", "memory.sqlite");
    openDatabase(path).close();
    expect(inspect(path)).toEqual({ version: SCHEMA_VERSION, tables: CANONICAL_TABLES });
  });

  test("an existing version-0 database upgrades to the current version", () => {
    const path = atVersionZero();
    expect(inspect(path).version).toBe(0);
    openDatabase(path).close();
    expect(inspect(path)).toEqual({ version: SCHEMA_VERSION, tables: CANONICAL_TABLES });
  });

  test("reopening a current database is a no-op that preserves data", () => {
    const path = join(tempDir(), "memory.sqlite");
    const db = openDatabase(path);
    db.prepare("INSERT INTO workstreams (id, label, created_at) VALUES ('wst_1', 'main', 'now')").run();
    db.close();
    const again = openDatabase(path);
    expect(again.prepare("SELECT id FROM workstreams").all()).toEqual([{ id: "wst_1" }]);
    again.close();
    expect(inspect(path).version).toBe(SCHEMA_VERSION);
  });

  test("a failing migration rolls back completely and leaves the previous version", () => {
    // A conflicting pre-existing table makes step 0→1 fail part-way through.
    const path = atVersionZero("CREATE TABLE records (unrelated TEXT);");
    expect(() => openDatabase(path)).toThrow();
    expect(inspect(path)).toEqual({ version: 0, tables: ["records"] });
  });

  test("a database newer than this build fails closed with unsupported_runtime and is not modified", () => {
    const path = atVersionZero(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
    const error = catchMemchorError(() => openDatabase(path));
    expect(error.code).toBe("unsupported_runtime");
    expect(error.details).toMatchObject({ schemaVersion: SCHEMA_VERSION + 1, supportedSchemaVersion: SCHEMA_VERSION });
    expect(inspect(path)).toEqual({ version: SCHEMA_VERSION + 1, tables: [] });
    const raw = new Database(path, { readonly: true });
    expect(raw.pragma("journal_mode", { simple: true })).toBe("delete");
    raw.close();
  });

  test("the upgraded schema enforces foreign keys and WAL", () => {
    const path = atVersionZero();
    const db = openDatabase(path);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      expect(() => db.prepare("INSERT INTO worktree_bindings VALUES ('/x', 'wst_missing', 'now')").run()).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  test("a workspace whose database was upgraded by a newer Memchor fails closed at bootstrap", () => {
    const repo = initRepo();
    const home = tempDir();
    const first = openMemory({ cwd: repo, host: "codex", home });
    first.record({ kind: "note", body: "kept", attribution: "agent_inference" });
    const dbPath = first.status().storage.dbPath ?? "";
    first.close();
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    const second = openMemory({ cwd: repo, host: "codex", home });
    expect(catchMemchorError(() => second.bootstrap()).code).toBe("unsupported_runtime");
    expect(second.status().problem?.code).toBe("unsupported_runtime");
    second.close();
  });
});
