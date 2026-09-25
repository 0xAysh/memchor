import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MemchorError } from "../errors.js";
import { assertSupportedSchema, migrate, SCHEMA_VERSION } from "./migrations/index.js";

export type Db = Database.Database;

/**
 * Minimum embedded SQLite. 3.7.0–3.51.2 carry the WAL-reset bug, which can corrupt a
 * WAL database when several connections write and checkpoint concurrently — exactly
 * Memchor's multi-process model. Fixed in 3.51.3 (backports exist only as 3.44.6 and
 * 3.50.7, which better-sqlite3 does not ship). Source: https://sqlite.org/wal.html#walresetbug
 */
export const REQUIRED_SQLITE_VERSION = "3.51.3";

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface RuntimeReport {
  sqliteVersion: string;
  requiredSqliteVersion: string;
  fts5: boolean;
  supported: boolean;
}

/** Inspects the embedded SQLite without touching any workspace database. */
export function probeRuntime(): RuntimeReport {
  return withMemoryDb(inspectRuntime);
}

/** Throws `unsupported_runtime` unless the embedded SQLite passes the gate (used at process start). */
export function assertEmbeddedRuntime(): void {
  withMemoryDb((db) => {
    assertSupportedRuntime(runtimeFacts(db));
  });
}

function withMemoryDb<T>(fn: (db: Db) => T): T {
  const db = new Database(":memory:");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Opens (creating if needed) a workspace database and makes it safe to use:
 * runtime gate → schema-version gate → pragmas → migrations. Throws `unsupported_runtime` for an old SQLite,
 * missing FTS5, or a newer schema; `storage_unavailable` when the file cannot be opened.
 *
 * Pragmas: WAL so several host processes share one file; synchronous=FULL so a
 * committed write survives power loss (a capture is never acknowledged and then lost);
 * foreign_keys so provenance links cannot dangle; a bounded busy_timeout so contention
 * becomes a visible `storage_busy` instead of an indefinite hang.
 */
export function openDatabase(path: string, options: { busyTimeoutMs?: number } = {}): Db {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  let db: Db | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path, { timeout: busyTimeoutMs });
    assertSupportedRuntime(runtimeFacts(db));
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    assertSupportedSchema(db);
    const mode = enableWal(db, busyTimeoutMs);
    if (mode !== "wal") {
      throw new MemchorError("storage_unavailable", `Could not enable WAL mode on ${path} (got ${String(mode)}).`, {
        details: { path },
      });
    }
    db.pragma("synchronous = FULL");
    migrate(db); // leaves foreign_keys = ON
    return db;
  } catch (error) {
    db?.close();
    throw toStorageError(error, path);
  }
}

/**
 * Switching a fresh database to WAL needs an exclusive lock, and SQLite can answer
 * SQLITE_BUSY at once (without consulting busy_timeout) while another process is
 * creating the same file. Retry that single pragma with jittered backoff, bounded by
 * the same busy timeout. WAL is persistent, so once any opener succeeds the others see
 * it already set.
 */
function enableWal(db: Db, busyTimeoutMs: number): unknown {
  const deadline = Date.now() + busyTimeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return db.pragma("journal_mode = WAL", { simple: true });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (!code.startsWith("SQLITE_BUSY") || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 5 + Math.random() * 20);
    }
  }
}

/**
 * Runs `fn` in a `BEGIN IMMEDIATE` transaction. Taking the write lock up front means a
 * transaction never upgrades from reader to writer, so it cannot fail mid-way with
 * SQLITE_BUSY_SNAPSHOT after reading state another process has since changed; it waits
 * (bounded by busy_timeout) at BEGIN instead. `fn` must be synchronous.
 */
export function writeTransaction<T>(db: Db, fn: () => T): T {
  try {
    return db.transaction(fn).immediate();
  } catch (error) {
    throw toStorageError(error);
  }
}

/** Maps SQLite/filesystem failures to Memchor error codes; passes MemchorErrors through. */
export function toStorageError(error: unknown, path?: string): unknown {
  if (error instanceof MemchorError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  const details: Record<string, unknown> = { cause: code || message };
  if (path !== undefined) details["path"] = path;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return new MemchorError("storage_busy", "The memory database is busy with another writer; retry shortly.", {
      retryable: true,
      details,
      cause: error,
    });
  }
  if (code === "SQLITE_FULL" || code === "ENOSPC") {
    return new MemchorError("storage_full", "The disk or database is full; nothing was stored.", { details, cause: error });
  }
  if (
    code.startsWith("SQLITE_CANTOPEN") ||
    code.startsWith("SQLITE_IOERR") ||
    code.startsWith("SQLITE_READONLY") ||
    code.startsWith("SQLITE_CORRUPT") ||
    code === "SQLITE_NOTADB" ||
    code === "SQLITE_PERM" ||
    ["EACCES", "EPERM", "ENOTDIR", "EEXIST", "EROFS", "EISDIR", "ENOENT"].includes(code) ||
    (error instanceof TypeError && /directory does not exist/.test(message))
  ) {
    return new MemchorError("storage_unavailable", `Memchor storage is unavailable: ${message}`, {
      details,
      cause: error,
    });
  }
  return error;
}

/**
 * Opens an existing workspace database for inspection only: no migrations, no pragmas
 * that write, no rows. Returns null when the file does not exist. (SQLite may still
 * create its -wal/-shm housekeeping files next to a WAL database.)
 */
export function openReadOnly(path: string): Db | null {
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw toStorageError(error, path);
  }
}

export interface IntegrityReport {
  dbPath: string;
  /** False when the workspace has no database yet (nothing to check). */
  exists: boolean;
  /** `PRAGMA user_version`; null when the file is missing or unreadable. */
  schemaVersion: number | null;
  ok: boolean;
  /** `PRAGMA integrity_check` rows (`["ok"]` when sound), or the error that prevented it. */
  sqlite: string[];
  /** FTS5 'integrity-check' of chunks_fts against its content table: "ok", "absent", or the error. */
  searchIndex: string;
  foreignKeyViolations: number;
}

/**
 * Read-only structural checks of the database at `path`. Never migrates or repairs, and
 * reports (rather than throws for) a damaged, foreign or unmigrated file.
 */
export function checkIntegrity(path: string): IntegrityReport {
  const report: IntegrityReport = { dbPath: path, exists: existsSync(path), schemaVersion: null, ok: true, sqlite: [], searchIndex: "absent", foreignKeyViolations: 0 };
  if (!report.exists) return report;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  let db: Db | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    report.sqlite = (db.pragma("integrity_check") as { integrity_check: string }[]).map((row) => row.integrity_check);
    report.schemaVersion = db.pragma("user_version", { simple: true }) as number;
    report.foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[]).length;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'chunks_fts'").get() !== undefined) {
      // FTS5 spells its check as an INSERT command, which a read-only connection refuses;
      // it modifies nothing. With rank = 1 it also verifies the index against `chunks`.
      const checker = new Database(path, { fileMustExist: true });
      try {
        checker.prepare("INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('integrity-check', 1)").run();
        report.searchIndex = "ok";
      } catch (error) {
        report.searchIndex = describe(error);
      } finally {
        checker.close();
      }
    }
  } catch (error) {
    report.sqlite = [describe(error)];
  } finally {
    db?.close();
  }
  report.ok =
    report.sqlite.length === 1 && report.sqlite[0] === "ok" && report.foreignKeyViolations === 0 && ["ok", "absent"].includes(report.searchIndex);
  return report;
}

const statements = new WeakMap<Db, Map<string, Database.Statement>>();

/**
 * A statement prepared once per connection. better-sqlite3 does not cache statements, and
 * each one holds native SQLite memory until V8 collects its wrapper; preparing per call in a
 * hot write path (thousands of records per import) grows the process by hundreds of MB.
 */
export function prepared(db: Db, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (cache === undefined) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/** Throws unless called inside an open transaction; guards helpers whose atomicity depends on the caller's. */
export function requireTransaction(db: Db, what: string): void {
  if (!db.inTransaction) throw new Error(`${what} must run inside the caller's write transaction`);
}

export interface RuntimeFacts {
  sqliteVersion: string;
  compileOptions: readonly string[];
  /** Whether creating an FTS5 table actually succeeded. */
  fts5Works: boolean;
}

/**
 * The runtime gate as a pure function of what the embedded SQLite reports. Throws
 * `unsupported_runtime` with the found and required versions; no override exists.
 */
export function assertSupportedRuntime(facts: RuntimeFacts): void {
  const details = { sqliteVersion: facts.sqliteVersion, requiredSqliteVersion: REQUIRED_SQLITE_VERSION };
  if (compareVersions(facts.sqliteVersion, REQUIRED_SQLITE_VERSION) < 0) {
    throw new MemchorError(
      "unsupported_runtime",
      `Embedded SQLite ${facts.sqliteVersion} is too old; Memchor requires ${REQUIRED_SQLITE_VERSION} or newer (fix for the WAL-reset corruption bug, https://sqlite.org/wal.html#walresetbug). Reinstall Memchor so better-sqlite3 bundles a newer SQLite.`,
      { details },
    );
  }
  if (!facts.compileOptions.includes("ENABLE_FTS5") || !facts.fts5Works) {
    throw new MemchorError("unsupported_runtime", `Embedded SQLite ${facts.sqliteVersion} lacks a working FTS5, which Memchor requires for search.`, {
      details,
    });
  }
}

function runtimeFacts(db: Db): RuntimeFacts {
  const sqliteVersion = (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
  const compileOptions = (db.pragma("compile_options") as { compile_options: string }[]).map((row) => row.compile_options);
  let fts5Works = false;
  if (compileOptions.includes("ENABLE_FTS5")) {
    try {
      db.exec("CREATE VIRTUAL TABLE temp.memchor_fts5_probe USING fts5(x); DROP TABLE temp.memchor_fts5_probe;");
      fts5Works = true;
    } catch {
      fts5Works = false;
    }
  }
  return { sqliteVersion, compileOptions, fts5Works };
}

function inspectRuntime(db: Db): RuntimeReport {
  const facts = runtimeFacts(db);
  let supported = true;
  try {
    assertSupportedRuntime(facts);
  } catch {
    supported = false;
  }
  return {
    sqliteVersion: facts.sqliteVersion,
    requiredSqliteVersion: REQUIRED_SQLITE_VERSION,
    fts5: facts.fts5Works && facts.compileOptions.includes("ENABLE_FTS5"),
    supported,
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export { SCHEMA_VERSION };
