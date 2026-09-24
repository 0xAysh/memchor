import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/workspace-resolution.js";
import { MemchorError } from "../errors.js";
import { type ImportChoice } from "../schemas.js";
import { toStorageError } from "../storage/database.js";

/**
 * A host's transcript-import decision. It is host-level, not per workspace ("all projects"
 * chosen in one repository governs every other), so it lives in `$MEMCHOR_HOME/consent.json`
 * rather than in a workspace database.
 */
export interface Consent {
  choice: ImportChoice;
  /** Repository keys approved by `current_project` choices (empty for `all` and `none`). */
  projects: string[];
  decidedAt: string;
  updatedAt: string;
}

interface ConsentFile {
  version: 1;
  hosts: Record<string, Consent>;
}

const path = (home: string): string => join(home, "consent.json");
const LOCK_TIMEOUT_MS = 5_000;
const INCOMPLETE_LOCK_GRACE_MS = 100;

/** The host's decision, or null if it was never asked. An unreadable file fails closed: nothing is imported. */
export function readConsent(home: string, host: string): Consent | null {
  return readFile(home).hosts[host] ?? null;
}

/**
 * Records a decision. `current_project` adds this repository to the approved set (it never
 * approves another one); `all` and `none` replace the set. A bounded cross-process lock covers
 * the read-modify-rename so concurrent additive choices cannot revoke each other.
 */
export function writeConsent(home: string, host: string, choice: ImportChoice, repositoryKey: string): Consent {
  try {
    return withConsentLock(home, () => {
      // This read must happen after lock acquisition: another process may just have added a project.
      const file = readFile(home);
      const now = new Date().toISOString();
      const previous = file.hosts[host];
      const projects = choice === "current_project" ? [...new Set([...(previous?.choice === "current_project" ? previous.projects : []), repositoryKey])].sort() : [];
      const consent: Consent = { choice, projects, decidedAt: previous?.decidedAt ?? now, updatedAt: now };
      file.hosts[host] = consent;
      writeFileAtomic(path(home), JSON.stringify(file, null, 2) + "\n");
      return consent;
    });
  } catch (error) {
    throw toStorageError(error, home);
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

/** Exclusive-create lock with dead-owner recovery; waiting is synchronous and bounded like SQLite writes. */
function withConsentLock<T>(home: string, fn: () => T): T {
  mkdirSync(home, { recursive: true });
  const lockPath = `${path(home)}.lock`;
  const token = randomBytes(16).toString("hex");
  const candidatePath = `${lockPath}.${process.pid}.${token}.tmp`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));

  // Publish a fully written owner record with one atomic link. A crash before the link leaves
  // no visible lock; a crash after it leaves enough information for dead-owner recovery.
  const fd = openSync(candidatePath, "wx", 0o600);
  let candidateReady = false;
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token } satisfies LockOwner));
    fsyncSync(fd);
    candidateReady = true;
  } finally {
    closeSync(fd);
    if (!candidateReady) {
      try {
        unlinkSync(candidatePath);
      } catch {
        // The write error is the useful failure.
      }
    }
  }
  try {
    for (;;) {
      try {
        linkSync(candidatePath, lockPath);
        break;
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EEXIST") throw error;
        if (removeAbandonedLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new MemchorError("storage_busy", "The transcript-import consent file is busy with another writer; retry shortly.", {
            retryable: true,
            details: { path: lockPath },
            cause: error,
          });
        }
        Atomics.wait(pause, 0, 0, 5 + Math.random() * 20);
      }
    }
  } finally {
    try {
      unlinkSync(candidatePath);
    } catch {
      // The candidate does not grant ownership; a leftover cannot block another writer.
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

function removeAbandonedLock(lockPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  let owner: LockOwner | null = null;
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === "string") {
      owner = { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // A process can be pre-empted between exclusive create and writing its owner record.
  }
  if (owner !== null && processIsAlive(owner.pid)) return false;
  if (owner === null) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (owner.token === token) unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

/** Whether transcripts of the repository may be imported under this decision. */
export function approves(consent: Consent | null, repositoryKey: string): boolean {
  return consent !== null && (consent.choice === "all" || (consent.choice === "current_project" && consent.projects.includes(repositoryKey)));
}

function readFile(home: string): ConsentFile {
  const file = path(home);
  if (!existsSync(file)) return { version: 1, hosts: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MemchorError("storage_unavailable", `The Memchor consent file at ${file} is unreadable; nothing will be imported until it is fixed.`, {
      details: { path: file },
      cause: error,
    });
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if ((parsed as { version?: unknown } | null)?.version !== 1 || hosts === null || typeof hosts !== "object") {
    throw new MemchorError("storage_unavailable", `The Memchor consent file at ${file} has an unsupported format; it was left untouched.`, {
      details: { path: file },
    });
  }
  return parsed as ConsentFile;
}
