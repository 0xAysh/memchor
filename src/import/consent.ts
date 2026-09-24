import { existsSync, readFileSync } from "node:fs";
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

/** The host's decision, or null if it was never asked. An unreadable file fails closed: nothing is imported. */
export function readConsent(home: string, host: string): Consent | null {
  return readFile(home).hosts[host] ?? null;
}

/**
 * Records a decision. `current_project` adds this repository to the approved set (it never
 * approves another one); `all` and `none` replace the set. Written with tmp + fsync + rename;
 * two processes changing the decision at the same instant keep the later write.
 */
export function writeConsent(home: string, host: string, choice: ImportChoice, repositoryKey: string): Consent {
  try {
    const file = readFile(home);
    const now = new Date().toISOString();
    const previous = file.hosts[host];
    const projects = choice === "current_project" ? [...new Set([...(previous?.choice === "current_project" ? previous.projects : []), repositoryKey])].sort() : [];
    const consent: Consent = { choice, projects, decidedAt: previous?.decidedAt ?? now, updatedAt: now };
    file.hosts[host] = consent;
    writeFileAtomic(path(home), JSON.stringify(file, null, 2) + "\n");
    return consent;
  } catch (error) {
    throw toStorageError(error, home);
  }
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
