import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemchorError } from "../errors.js";
import type { Attribution } from "../schemas.js";
import type { Db } from "../storage/database.js";

/**
 * The lifecycle ledger: `lifecycle.jsonl` next to a workspace's `memory.sqlite`, one line per
 * lifecycle change (correct, supersede, retract, restore, forget), appended and fsynced inside
 * the change's transaction, just before it commits.
 *
 * It exists for one supported restore procedure: putting an older copy of `memory.sqlite` back
 * (a backup, a file-level restore). On the next open, Memchor re-applies every ledger entry the
 * database lacks (see `replayLedger`), so the older copy cannot bring back what was corrected,
 * retracted or forgotten after it was taken. Entries hold ids only, never content: the ledger
 * must not become a second copy of what the user asked Memchor to forget.
 *
 * An entry whose transaction then failed to commit (a crash at COMMIT) is re-applied on the next
 * open; the user asked for it, so erring towards applying it is the safe side. Replaying an entry
 * whose precondition no longer holds (already corrected) records it as applied and changes nothing.
 */
export interface LedgerEntry {
  v: 1;
  /** Also `lifecycle_events.ledger_id`, which marks the entry as applied in a database. */
  id: string;
  action: "correct" | "supersede" | "retract" | "restore" | "forget";
  recordId: string;
  replacementId: string | null;
  attribution: Attribution;
  host: string;
  /** Host events (the claim's own, and for a forgotten tool result its call) to suppress, or to release on restore. */
  events: { host: string; eventId: string }[];
  at: string;
}

export function ledgerPath(db: Db): string {
  return join(dirname(db.name), "lifecycle.jsonl");
}

/** Appends one entry durably. Called inside the change's write transaction, so a failure rolls the change back. */
export function appendLedger(db: Db, entry: LedgerEntry): void {
  const path = ledgerPath(db);
  let fd: number | undefined;
  try {
    fd = openSync(path, "a", 0o600);
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } catch (error) {
    throw new MemchorError("storage_unavailable", `Could not write the lifecycle ledger ${path}; nothing was changed.`, { details: { path }, cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Every well-formed entry, in order. A torn last line (a crash mid-append) is ignored. */
export function readLedger(db: Db): LedgerEntry[] {
  const path = ledgerPath(db);
  if (!existsSync(path)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as Partial<LedgerEntry> | null;
      if (entry?.v === 1 && typeof entry.id === "string" && typeof entry.recordId === "string") entries.push(entry as LedgerEntry);
    } catch {
      // A partial line from an interrupted append; the change it described never committed.
    }
  }
  return entries;
}
