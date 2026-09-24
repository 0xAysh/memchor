import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MemchorError } from "../errors.js";
import { toStorageError } from "../storage/database.js";

/** Where a worktree's memory lives, derived only from trusted inputs (cwd + Git + home). */
export interface WorkspaceLocation {
  workspaceId: string;
  label: string;
  /** realpath of the Git common dir: identical for every worktree of one repository. */
  repositoryKey: string;
  rootCommit: string | null;
  /** realpath of this worktree's top level; the key for workstream binding. */
  worktree: string;
  /** Current branch, or `detached@<sha>` / `detached` when HEAD is not on a branch. */
  branch: string;
  home: string;
  dbPath: string;
  /** True when this call found no database for the workspace (first use). */
  isNew: boolean;
}

interface Registry {
  version: 1;
  repositories: Record<string, { workspaceId: string; label: string; rootCommit: string | null; registeredAt: string }>;
}

export function resolveHome(home: string | undefined): string {
  return home ?? process.env["MEMCHOR_HOME"] ?? join(homedir(), ".memchor");
}

/**
 * cwd → Git worktree → repository identity → workspace, without writing anything.
 *
 * Invariants:
 * - Only reads the repository (`git rev-parse` family with optional locks disabled);
 *   every file Memchor writes lives under `home`, and only {@link registerWorkspace} writes.
 * - The workspace id is a pure function of the repository key, so two processes that
 *   first-bootstrap the same repository concurrently converge on the same id even if
 *   one registry write is lost to the other's rename. The registry records the mapping
 *   (and the root commit) so a later slice can re-point a moved repository.
 * - A corrupt registry fails closed (`storage_unavailable`); it is never overwritten.
 */
export function locateWorkspace(cwd: string, home: string): WorkspaceLocation & { registered: boolean } {
  // One spawn for both paths; --show-toplevel fails outside a worktree (and in bare repos).
  const [topLevel, commonDir] = gitOrScopeError(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).split("\n");
  if (topLevel === undefined || commonDir === undefined) {
    throw new MemchorError("scope_unresolved", `Memchor could not resolve a Git worktree from ${cwd}.`, { details: { cwd } });
  }
  const worktree = realpathSync(topLevel);
  const repositoryKey = realpathSync(commonDir);
  const branch = currentBranch(worktree);
  const rootCommit = tryGit(worktree, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n").sort()[0] ?? null;

  try {
    const existing = readRegistry(join(home, "registry.json")).repositories[repositoryKey];
    const workspaceId = existing?.workspaceId ?? `ws_${createHash("sha256").update(repositoryKey).digest("hex").slice(0, 16)}`;
    const label = existing?.label ?? basename(basename(repositoryKey) === ".git" ? dirname(repositoryKey) : repositoryKey);
    const dbPath = join(home, "workspaces", workspaceId, "memory.sqlite");
    return { workspaceId, label, repositoryKey, rootCommit, worktree, branch, home, dbPath, isNew: !existsSync(dbPath), registered: existing !== undefined };
  } catch (error) {
    throw toStorageError(error, home);
  }
}

/** Records the workspace in the registry and writes its config.json, if missing (atomic writes). */
export function registerWorkspace(location: WorkspaceLocation & { registered: boolean }): void {
  try {
    if (!location.registered) {
      const registryPath = join(location.home, "registry.json");
      const registry = readRegistry(registryPath);
      registry.repositories[location.repositoryKey] ??= {
        workspaceId: location.workspaceId,
        label: location.label,
        rootCommit: location.rootCommit,
        registeredAt: new Date().toISOString(),
      };
      writeFileAtomic(registryPath, JSON.stringify(registry, null, 2) + "\n");
    }
    const configPath = join(dirname(location.dbPath), "config.json");
    if (!existsSync(configPath)) {
      writeFileAtomic(
        configPath,
        JSON.stringify(
          { workspaceId: location.workspaceId, label: location.label, repositoryKey: location.repositoryKey, createdAt: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      );
    }
  } catch (error) {
    throw toStorageError(error, location.home);
  }
}

/** Current HEAD commit of the worktree, or null for an unborn branch. */
export function headCommit(worktree: string): string | null {
  return tryGit(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

function currentBranch(worktree: string): string {
  const branch = tryGit(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== null) return branch;
  const sha = tryGit(worktree, ["rev-parse", "--short", "HEAD"]);
  return sha === null ? "detached" : `detached@${sha}`;
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { version: 1, repositories: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MemchorError("storage_unavailable", `The Memchor registry at ${path} is unreadable; it was left untouched.`, {
      details: { path },
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { repositories?: unknown }).repositories !== "object"
  ) {
    throw new MemchorError("storage_unavailable", `The Memchor registry at ${path} has an unsupported format; it was left untouched.`, {
      details: { path },
    });
  }
  return parsed as Registry;
}

/** Write to a unique temp file in the same directory, fsync, then rename over the target. */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    const out = runGit(cwd, args);
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function gitOrScopeError(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args);
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    throw new MemchorError(
      "scope_unresolved",
      `Memchor could not resolve a Git worktree from ${cwd}. Start the agent inside a Git repository.`,
      { details: { cwd, git: stderr || (error instanceof Error ? error.message : String(error)) } },
    );
  }
}
