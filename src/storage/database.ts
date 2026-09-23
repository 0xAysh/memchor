import { mkdirSync } from "node:fs";
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
  const db = new Database(":memory:");
  try {
    return inspectRuntime(db);
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
    const runtime = inspectRuntime(db);
    if (!runtime.supported) {
      throw new MemchorError(
        "unsupported_runtime",
        runtime.fts5
          ? `Embedded SQLite ${runtime.sqliteVersion} is too old; Memchor requires ${REQUIRED_SQLITE_VERSION} or newer (WAL-reset corruption fix). Reinstall Memchor with a newer better-sqlite3.`
          : `Embedded SQLite ${runtime.sqliteVersion} was built without FTS5, which Memchor requires for search.`,
        { details: { ...runtime } },
      );
    }
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    assertSupportedSchema(db);
    const mode = enableWal(db, busyTimeoutMs);
    if (mode !== "wal") {
      throw new MemchorError("storage_unavailable", `Could not enable WAL mode on ${path} (got ${String(mode)}).`, {
        details: { path },
      });
    }
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    migrate(db);
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

export interface IntegrityReport {
  ok: boolean;
  /** `PRAGMA integrity_check` rows; `["ok"]` when the file is sound. */
  sqlite: string[];
  /** FTS5 'integrity-check' of chunks_fts against its content table: "ok" or the error. */
  searchIndex: string;
  foreignKeyViolations: number;
}

/** Read-only structural checks of a workspace database. */
export function checkIntegrity(db: Db): IntegrityReport {
  const sqlite = (db.pragma("integrity_check") as { integrity_check: string }[]).map((row) => row.integrity_check);
  const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[]).length;
  let searchIndex = "ok";
  try {
    // 'integrity-check' with rank 1 also verifies the index matches the external content table.
    db.prepare("INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('integrity-check', 1)").run();
  } catch (error) {
    searchIndex = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: sqlite.length === 1 && sqlite[0] === "ok" && searchIndex === "ok" && foreignKeyViolations === 0,
    sqlite,
    searchIndex,
    foreignKeyViolations,
  };
}

function inspectRuntime(db: Db): RuntimeReport {
  const sqliteVersion = (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
  const options = (db.pragma("compile_options") as { compile_options: string }[]).map((row) => row.compile_options);
  let fts5 = options.includes("ENABLE_FTS5");
  if (fts5) {
    try {
      // The compile option says FTS5 was built in; creating a table proves it works.
      db.exec("CREATE VIRTUAL TABLE temp.memchor_fts5_probe USING fts5(x); DROP TABLE temp.memchor_fts5_probe;");
    } catch {
      fts5 = false;
    }
  }
  return {
    sqliteVersion,
    requiredSqliteVersion: REQUIRED_SQLITE_VERSION,
    fts5,
    supported: fts5 && compareVersions(sqliteVersion, REQUIRED_SQLITE_VERSION) >= 0,
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
