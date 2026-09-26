import type BetterSqlite3 from "better-sqlite3";
import { MemchorError } from "../../errors.js";
import * as initial from "./0001-initial.js";
import * as transcriptImport from "./0002-transcript-import.js";
import * as importSourceFingerprint from "./0003-import-source-fingerprint.js";
import * as scopeResolution from "./0004-scope-resolution.js";
import * as lifecycle from "./0005-lifecycle.js";
import * as preferences from "./0006-preferences-private-sessions.js";

/**
 * Ordered schema migrations. Entry `i` upgrades `PRAGMA user_version` from `i` to `i + 1`.
 * Append only: a shipped migration is never edited, because databases in the field
 * have already applied it.
 */
const MIGRATIONS: readonly string[] = [initial.sql, transcriptImport.sql, importSourceFingerprint.sql, scopeResolution.sql, lifecycle.sql, preferences.sql];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings the database to {@link SCHEMA_VERSION}.
 *
 * Each step runs in its own `BEGIN IMMEDIATE` transaction together with the
 * `user_version` bump, so a failed step leaves the database exactly at the previous
 * version, and concurrent openers serialise: the second one re-reads `user_version`
 * inside its own write lock and finds nothing left to do.
 *
 * A database newer than this build fails closed with `unsupported_runtime` rather
 * than being read with the wrong assumptions.
 *
 * Steps run with foreign keys off, because rebuilding a referenced table (SQLite's
 * documented way to change a column constraint) cannot be done with them on, and the
 * pragma cannot change inside a transaction. Each step instead runs `foreign_key_check`
 * inside its own transaction and rolls back on any violation, so no step can commit a
 * dangling reference. Foreign keys are on again when this returns or throws.
 */
export function migrate(db: BetterSqlite3.Database): void {
  const readVersion = (): number => db.pragma("user_version", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    for (;;) {
      const applied = db
        .transaction(() => {
          const current = readVersion();
          if (current > SCHEMA_VERSION) throw newerSchema(current);
          const step = MIGRATIONS[current];
          if (step === undefined) return false;
          db.exec(step);
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) throw new Error(`Migration to schema version ${current + 1} would leave ${violations.length} dangling references`);
          db.pragma(`user_version = ${current + 1}`);
          return true;
        })
        .immediate();
      if (!applied) return;
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** Fails closed before anything (even the journal mode) is changed on a newer database. */
export function assertSupportedSchema(db: BetterSqlite3.Database): void {
  const found = db.pragma("user_version", { simple: true }) as number;
  if (found > SCHEMA_VERSION) throw newerSchema(found);
}

function newerSchema(found: number): MemchorError {
  return new MemchorError(
    "unsupported_runtime",
    `This database uses schema version ${found}, but this Memchor build supports up to ${SCHEMA_VERSION}. Upgrade Memchor; the database was not modified.`,
    { details: { schemaVersion: found, supportedSchemaVersion: SCHEMA_VERSION } },
  );
}
