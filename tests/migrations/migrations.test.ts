import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { openDatabase, SCHEMA_VERSION } from "../../src/storage/database.js";
import { catchMemchorError, initRepo, tempDir } from "../helpers.js";

const CANONICAL_TABLES = [
  "checkpoints",
  "chunks",
  "chunks_fts",
  "consents",
  "import_cursors",
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
  test("this build introduces schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
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
