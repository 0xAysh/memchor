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
  /** Keys this workspace's repository had before it was moved, newest first (see {@link locateWorkspace}). */
  formerRepositoryKeys: string[];
  rootCommit: string | null;
  /** realpath of this worktree's top level; the key for workstream binding. */
  worktree: string;
  /** Current branch, or `detached@<sha>` / `detached` when HEAD is not on a branch. */
  branch: string;
  home: string;
  dbPath: string;
  /** True when this call found no database for the workspace (first use). */
  isNew: boolean;
  /** What {@link registerWorkspace} still has to write to the registry for this location. */
  registration: Registration;
}

/**
 * - `current`: the registry already maps this repository key to the workspace.
 * - `new`: first sighting of this repository.
 * - `root_known`: registered while its branch was unborn; the root commit is now known.
 * - `moved`: the repository moved here from `from` (re-point that entry).
 * - `replaced`: this path used to hold a *different* repository, whose entry is retired.
 */
export type Registration = { kind: "current" | "new" | "root_known" | "replaced" } | { kind: "moved"; from: string };

interface RegistryEntry {
  workspaceId: string;
  label: string;
  rootCommit: string | null;
  registeredAt: string;
  /** Repository keys this workspace had before moves, newest first (bounded). */
  formerKeys?: string[];
}

/**
 * `retired` holds workspaces whose path now belongs to another repository; they stay
 * findable so the moved original can reclaim its memory. Builds that predate it ignore it.
 */
interface Registry {
  version: 1;
  repositories: Record<string, RegistryEntry>;
  retired?: Record<string, RegistryEntry & { repositoryKey: string }>;
}

const MAX_FORMER_KEYS = 10;

export function resolveHome(home: string | undefined): string {
  return home ?? process.env["MEMCHOR_HOME"] ?? join(homedir(), ".memchor");
}

/**
 * cwd → Git worktree → repository identity → workspace, without writing anything.
 *
 * Repository identity, strongest signal first:
 * - **Repository key** (realpath of the Git common dir). Authoritative while the repository
 *   stays put: every worktree of one repository shares it, and two unrelated repositories
 *   never do, however similar their directory names.
 * - **Root commit** (recorded at registration). Evidence, not identity: every clone and fork
 *   shares it. It is used only to say "not the same repository" (a registered path whose
 *   recorded root commit is absent from the object store now holds a different repository)
 *   and to recognise a move.
 * - **Move.** An unregistered key is the moved repository of exactly one registered workspace
 *   when that workspace's old key no longer exists on disk and its root commit exists here.
 *   Requiring the old location to be gone keeps a clone or fork whose original still exists a
 *   separate workspace; requiring exactly one candidate means two vanished copies of one
 *   history are never guessed between (the newcomer gets its own workspace). An unborn
 *   repository has no root commit, so it is never matched this way. Known limit: a fresh clone
 *   made after the original was deleted is indistinguishable from a move (Memchor keeps no
 *   marker inside the repository) and continues the original's memory.
 *
 * Invariants:
 * - Only reads the repository (`git rev-parse`/`rev-list`/`cat-file`, optional locks disabled);
 *   every file Memchor writes lives under `home`, and only {@link registerWorkspace} writes.
 * - The workspace id is a pure function of the repository key and the registry, so two
 *   processes that first-bootstrap the same repository concurrently converge on the same id
 *   even if one registry write is lost to the other's rename.
 * - A corrupt registry fails closed (`storage_unavailable`); it is never overwritten.
 */
export function locateWorkspace(cwd: string, home: string): WorkspaceLocation {
  // One spawn for both paths; --show-toplevel fails outside a worktree (and in bare repos).
  const [topLevel, commonDir] = gitOrScopeError(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).split("\n");
  if (topLevel === undefined || commonDir === undefined) {
    throw new MemchorError("scope_unresolved", `Memchor could not resolve a Git worktree from ${cwd}.`, { details: { cwd } });
  }
  const worktree = realpathSync(topLevel);
  const repositoryKey = realpathSync(commonDir);
  const branch = currentBranch(worktree);
  const rootCommit = tryGit(worktree, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n").sort()[0] ?? null;

  let registry: Registry;
  try {
    registry = readRegistry(join(home, "registry.json"));
  } catch (error) {
    throw toStorageError(error, home);
  }
  const existing = registry.repositories[repositoryKey];
  let resolved: { workspaceId: string; label: string; formerKeys: string[]; registration: Registration };
  const sameRepository = (recorded: string | null): boolean =>
    recorded === null || recorded === rootCommit || commitsExist(worktree, [recorded]).has(recorded);
  if (existing !== undefined && sameRepository(existing.rootCommit)) {
    resolved = {
      workspaceId: existing.workspaceId,
      label: existing.label,
      formerKeys: existing.formerKeys ?? [],
      registration: { kind: existing.rootCommit === null && rootCommit !== null ? "root_known" : "current" },
    };
  } else {
    const moved = rootCommit === null ? null : movedRepository(registry, repositoryKey, worktree);
    resolved =
      moved === null
        ? {
            workspaceId: unusedWorkspaceId(registry, repositoryKey),
            label: basename(mainWorktreeOf(repositoryKey) ?? repositoryKey),
            formerKeys: [],
            registration: { kind: existing === undefined ? "new" : "replaced" },
          }
        : {
            workspaceId: moved.entry.workspaceId,
            label: moved.entry.label,
            formerKeys: [moved.key, ...(moved.entry.formerKeys ?? [])].filter((key) => key !== repositoryKey).slice(0, MAX_FORMER_KEYS),
            registration: { kind: "moved", from: moved.key },
          };
  }
  const dbPath = join(home, "workspaces", resolved.workspaceId, "memory.sqlite");
  return {
    workspaceId: resolved.workspaceId,
    label: resolved.label,
    repositoryKey,
    formerRepositoryKeys: resolved.formerKeys,
    rootCommit,
    worktree,
    branch,
    home,
    dbPath,
    isNew: !existsSync(dbPath),
    registration: resolved.registration,
  };
}

/**
 * The registered workspace this unregistered repository was moved from, or null. See
 * {@link locateWorkspace} for why each condition is needed.
 */
function movedRepository(registry: Registry, repositoryKey: string, worktree: string): { key: string; entry: RegistryEntry } | null {
  const vanished: { key: string; entry: RegistryEntry }[] = [];
  for (const [key, entry] of Object.entries(registry.repositories)) {
    if (key !== repositoryKey && entry.rootCommit !== null && !existsSync(key)) vanished.push({ key, entry });
  }
  // A retired workspace's old path holds another repository now, so its own repository moved on.
  for (const entry of Object.values(registry.retired ?? {})) {
    if (entry.rootCommit !== null) vanished.push({ key: entry.repositoryKey, entry });
  }
  if (vanished.length === 0) return null;
  const present = commitsExist(worktree, vanished.map((v) => v.entry.rootCommit ?? ""));
  const candidates = vanished.filter((v) => present.has(v.entry.rootCommit ?? ""));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * `ws_` + hash of the repository key, unless the registry already gives that id to another
 * workspace (the path once held a repository that moved away or was replaced); then the next
 * free salted hash. Only registry state is consulted, so concurrent first bootstraps agree.
 */
function unusedWorkspaceId(registry: Registry, repositoryKey: string): string {
  const used = new Set([...Object.values(registry.repositories), ...Object.values(registry.retired ?? {})].map((entry) => entry.workspaceId));
  for (let salt = 0; ; salt++) {
    const id = `ws_${createHash("sha256").update(salt === 0 ? repositoryKey : `${repositoryKey}\u0000${salt}`).digest("hex").slice(0, 16)}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Records the workspace in the registry (re-pointing a moved repository's entry, retiring a
 * replaced one) and writes its config.json when missing or stale. Atomic writes.
 */
export function registerWorkspace(location: WorkspaceLocation): void {
  try {
    const { registration } = location;
    if (registration.kind !== "current") {
      const registryPath = join(location.home, "registry.json");
      const registry = readRegistry(registryPath);
      const previous = registry.repositories[location.repositoryKey];
      if (registration.kind === "replaced" && previous !== undefined && previous.workspaceId !== location.workspaceId) {
        registry.retired = { ...registry.retired, [previous.workspaceId]: { ...previous, repositoryKey: location.repositoryKey } };
      }
      if (registration.kind === "moved") {
        const { from } = registration;
        registry.repositories = Object.fromEntries(Object.entries(registry.repositories).filter(([key, entry]) => key !== from || entry.workspaceId !== location.workspaceId));
        if (registry.retired !== undefined) registry.retired = Object.fromEntries(Object.entries(registry.retired).filter(([id]) => id !== location.workspaceId));
      }
      const kept = previous?.workspaceId === location.workspaceId ? previous : undefined;
      registry.repositories[location.repositoryKey] = {
        workspaceId: location.workspaceId,
        label: location.label,
        rootCommit: location.rootCommit ?? kept?.rootCommit ?? null,
        registeredAt: kept?.registeredAt ?? new Date().toISOString(),
        ...(location.formerRepositoryKeys.length === 0 ? {} : { formerKeys: location.formerRepositoryKeys }),
      };
      writeFileAtomic(registryPath, JSON.stringify(registry, null, 2) + "\n");
    }
    const configPath = join(dirname(location.dbPath), "config.json");
    if (!existsSync(configPath) || (JSON.parse(readFileSync(configPath, "utf8")) as { repositoryKey?: unknown }).repositoryKey !== location.repositoryKey) {
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

/**
 * The main worktree's top level for a repository key (`<top>/.git`), or null when the common
 * dir is not inside a worktree (e.g. `--separate-git-dir`). Worktrees under it move with the
 * repository.
 */
export function mainWorktreeOf(repositoryKey: string): string | null {
  return basename(repositoryKey) === ".git" ? dirname(repositoryKey) : null;
}

function currentBranch(worktree: string): string {
  const branch = tryGit(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== null) return branch;
  const sha = tryGit(worktree, ["rev-parse", "--short", "HEAD"]);
  return sha === null ? "detached" : `detached@${sha}`;
}

/** Which of `shas` are commits in this repository's object store (one spawn). */
function commitsExist(worktree: string, shas: readonly string[]): Set<string> {
  const wanted = shas.filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  if (wanted.length === 0) return new Set();
  let out: string;
  try {
    out = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      cwd: worktree,
      env: GIT_ENV,
      encoding: "utf8",
      input: wanted.join("\n") + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return new Set();
  }
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha !== undefined && type === "commit") found.add(sha);
  }
  return found;
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
export function writeFileAtomic(path: string, content: string): void {
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
