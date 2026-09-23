import type BetterSqlite3 from "better-sqlite3";
import { MemchorError } from "../../errors.js";
import * as initial from "./0001-initial.js";

/**
 * Ordered schema migrations. Entry `i` upgrades `PRAGMA user_version` from `i` to `i + 1`.
 * Append only: a shipped migration is never edited, because databases in the field
 * have already applied it.
 */
const MIGRATIONS: readonly string[] = [initial.sql];

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
 */
export function migrate(db: BetterSqlite3.Database): void {
  const readVersion = (): number => db.pragma("user_version", { simple: true }) as number;
  for (;;) {
    const applied = db
      .transaction(() => {
        const current = readVersion();
        if (current > SCHEMA_VERSION) throw newerSchema(current);
        const step = MIGRATIONS[current];
        if (step === undefined) return false;
        db.exec(step);
        db.pragma(`user_version = ${current + 1}`);
        return true;
      })
      .immediate();
    if (!applied) return;
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
