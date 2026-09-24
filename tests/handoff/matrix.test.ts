import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
import type { RecordInput } from "../../src/schemas.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";
import { writeArtifact } from "./artifacts.js";

/**
 * The repository/worktree identity and freshness matrix for the #20 PR: each case runs
 * against real Git repositories and SQLite through the memory module, asserts what Memchor
 * observed against the documented expectation, and is written (case → expected → observed)
 * to the git-ignored `tests/mcp/__artifacts__/handoff/identity-freshness-matrix.json`.
 */

interface Row {
  group: "identity" | "freshness";
  case: string;
  why: string;
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
}
const rows: Row[] = [];

afterAll(() => {
  writeArtifact("identity-freshness-matrix", { issue: "#20", rows });
});

function matrixCase(group: Row["group"], name: string, why: string, expected: Record<string, unknown>, observe: () => Record<string, unknown>): void {
  test(`${group}: ${name}`, () => {
    const observed = observe();
    rows.push({ group, case: name, why, expected, observed });
    expect(observed).toEqual(expected);
  });
}

function open(cwd: string, home: string, options: { host?: string; claudeConfigDir?: string } = {}): Memory {
  const memory = openMemory({ cwd, home, host: options.host ?? "claude-code", ...(options.claudeConfigDir === undefined ? {} : { claudeConfigDir: options.claudeConfigDir }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function worktree(repo: string, branch: string, create = false): string {
  const path = join(tempDir("memchor-wt-"), "wt");
  git(repo, "worktree", "add", "--quiet", ...(create ? ["-b", branch, path] : [path, branch]));
  return path;
}

/** A committed repository at `<fresh temp dir>/<name>`, so two can share a basename. */
function namedRepo(name: string): string {
  const dir = join(tempDir("memchor-matrix-"), name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "src/gateway.ts"), "export function charge() {\n  return retry(3);\n}\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "gateway");
  return dir;
}

describe("repository/worktree identity matrix", () => {
  matrixCase(
    "identity",
    "same path, new session",
    "the repository key (Git common dir) and the worktree binding are unchanged",
    { sameWorkspace: true, sameWorkstream: true, resolvedBy: "worktree_binding" },
    () => {
      const home = tempDir();
      const repo = initRepo();
      const first = open(repo, home).bootstrap().scope;
      const again = open(repo, home, { host: "codex" }).bootstrap().scope;
      return { sameWorkspace: again.workspaceId === first.workspaceId, sameWorkstream: again.workstreamId === first.workstreamId, resolvedBy: again.resolvedBy };
    },
  );

  matrixCase(
    "identity",
    "repository moved to another path",
    "old key gone, recorded root commit present, exactly one such workspace: a move",
    { sameWorkspace: true, sameWorkstream: true, resolvedBy: "worktree_binding", memoryVisible: true },
    () => {
      const home = tempDir();
      const repo = initRepo();
      const before = open(repo, home);
      const scope = before.bootstrap().scope;
      const { recordId } = before.record({ kind: "decision", body: "kept across the move", attribution: "user_direction" });
      before.close();
      const moved = join(tempDir("memchor-moved-"), "checkout");
      renameSync(repo, moved);
      const after = open(moved, home).bootstrap();
      return {
        sameWorkspace: after.scope.workspaceId === scope.workspaceId,
        sameWorkstream: after.scope.workstreamId === scope.workstreamId,
        resolvedBy: after.scope.resolvedBy,
        memoryVisible: after.context.items.some((i) => i.recordId === recordId),
      };
    },
  );

  matrixCase(
    "identity",
    "unrelated repository with the same basename",
    "different Git common dir and no shared root commit: a different repository, whatever its name",
    { sameWorkspace: false, sameLabel: true, otherMemoryVisible: false },
    () => {
      const home = tempDir();
      const a = open(namedRepo("store"), home);
      const scopeA = a.bootstrap().scope;
      a.record({ kind: "note", body: "only in the first store", attribution: "agent_inference" });
      const b = open(namedRepo("store"), home).bootstrap();
      return { sameWorkspace: b.scope.workspaceId === scopeA.workspaceId, sameLabel: b.scope.workspaceLabel === scopeA.workspaceLabel, otherMemoryVisible: !b.context.empty };
    },
  );

  matrixCase(
    "identity",
    "clone while the original still exists",
    "a shared root commit is evidence, never identity; the original is still on disk",
    { sameWorkspace: false, originalKeepsWorkspace: true },
    () => {
      const home = tempDir();
      const original = initRepo();
      const scope = open(original, home).bootstrap().scope;
      const clone = join(tempDir("memchor-clone-"), "copy");
      git(original, "clone", "--quiet", original, clone);
      const cloned = open(clone, home).bootstrap().scope;
      return { sameWorkspace: cloned.workspaceId === scope.workspaceId, originalKeepsWorkspace: open(original, home).bootstrap().scope.workspaceId === scope.workspaceId };
    },
  );

  matrixCase(
    "identity",
    "fresh clone made after the original was deleted (known limit)",
    "indistinguishable from a move without a marker inside the repository: it continues the original's memory",
    { sameWorkspace: true },
    () => {
      const home = tempDir();
      const original = initRepo();
      const scope = open(original, home).bootstrap().scope;
      const clone = join(tempDir("memchor-clone-"), "copy");
      git(original, "clone", "--quiet", original, clone);
      rmSync(original, { recursive: true, force: true });
      return { sameWorkspace: open(clone, home).bootstrap().scope.workspaceId === scope.workspaceId };
    },
  );

  matrixCase(
    "identity",
    "linked worktree of the same repository",
    "worktrees share the repository key (one workspace) but each worktree is its own place of work",
    { sameWorkspace: true, sameWorkstream: false, resolvedBy: "new_workstream" },
    () => {
      const home = tempDir();
      const repo = initRepo();
      const main = open(repo, home).bootstrap().scope;
      const linked = open(worktree(repo, "side", true), home).bootstrap().scope;
      return { sameWorkspace: linked.workspaceId === main.workspaceId, sameWorkstream: linked.workstreamId === main.workstreamId, resolvedBy: linked.resolvedBy };
    },
  );

  matrixCase(
    "identity",
    "worktree binding vs a branch that names an orphaned workstream",
    "the binding is where the work physically happens and survives branch switches; a branch is only a suggestion",
    { boundTo: "binding", resolvedBy: "worktree_binding", ambiguity: false },
    () => {
      const home = tempDir();
      const repo = initRepo({ branch: "main" });
      const main = open(repo, home).bootstrap().scope;
      const first = worktree(repo, "feat/z", true);
      const orphan = open(first, home).bootstrap().scope;
      git(repo, "worktree", "remove", "--force", first);
      git(repo, "checkout", "--quiet", "feat/z");
      const again = open(repo, home).bootstrap().scope;
      return { boundTo: again.workstreamId === main.workstreamId ? "binding" : again.workstreamId === orphan.workstreamId ? "branch" : "other", resolvedBy: again.resolvedBy, ambiguity: again.ambiguity !== null };
    },
  );

  matrixCase(
    "identity",
    "explicit task vs branch",
    "the user named the task; branch similarity never outranks it",
    { boundTo: "task", resolvedBy: "task", taskKey: "#20" },
    () => {
      const home = tempDir();
      const repo = initRepo();
      const tasked = open(worktree(repo, "fix/issue-20", true), home).bootstrap({ task: "#20" }).scope;
      const branchPath = worktree(repo, "feat/b", true);
      const orphan = open(branchPath, home).bootstrap().scope;
      git(repo, "worktree", "remove", "--force", branchPath);
      const fresh = open(worktree(repo, "feat/b"), home).bootstrap({ task: "issue 20" }).scope;
      return { boundTo: fresh.workstreamId === tasked.workstreamId ? "task" : fresh.workstreamId === orphan.workstreamId ? "branch" : "other", resolvedBy: fresh.resolvedBy, taskKey: fresh.taskKey };
    },
  );

  matrixCase(
    "identity",
    "branch only: a new worktree on an orphaned workstream's branch",
    "branch evidence alone never binds: the user is asked",
    { workstreamBound: false, ambiguity: true, candidates: 1, candidateSignal: "branch" },
    () => {
      const home = tempDir();
      const repo = initRepo();
      const first = worktree(repo, "feat/retry", true);
      open(first, home).bootstrap();
      git(repo, "worktree", "remove", "--force", first);
      const again = open(worktree(repo, "feat/retry"), home).bootstrap().scope;
      return {
        workstreamBound: again.workstreamId !== null,
        ambiguity: again.ambiguity !== null,
        candidates: again.ambiguity?.candidates.length,
        candidateSignal: again.ambiguity?.candidates[0]?.reasons[0]?.signal,
      };
    },
  );
});

describe("freshness matrix", () => {
  /** Records one reference in a fresh repository, applies `change`, and returns the reference as recall labels it. */
  function freshnessOf(ref: RecordInput["externalRefs"], change: (repo: string) => void, before?: (repo: string) => void): Record<string, unknown> {
    const repo = namedRepo("store");
    const memory = open(repo, tempDir());
    before?.(repo);
    const { recordId } = memory.record({ kind: "evidence", body: "charge() retries three times", attribution: "direct_observation", externalRefs: ref });
    change(repo);
    return labelled(memory.recall({ maxTokens: 8_000 }).items.find((i) => i.recordId === recordId));
  }
  const labelled = (item: PackItem | undefined): Record<string, unknown> => ({
    freshness: item?.freshness,
    reason: item?.externalRefs[0]?.reason,
    warning: item?.warning === null ? null : /read the current file/i.test(item?.warning ?? "") ? "read the current file" : /verify/i.test(item?.warning ?? "") ? "verify with your own tools" : item?.warning,
  });
  const gateway = [{ kind: "code" as const, locator: "src/gateway.ts", path: "src/gateway.ts" }];
  const edit = (repo: string, content = "export function charge() {\n  return retry(0, { key });\n}\n"): void => {
    writeFileSync(join(repo, "src/gateway.ts"), content);
  };

  matrixCase("freshness", "unchanged file", "same bytes: the observation still describes the file (reuse, no re-read)", { freshness: "current", reason: "unchanged", warning: null }, () =>
    freshnessOf(gateway, () => undefined),
  );
  matrixCase("freshness", "file edited and committed", "different bytes at a new HEAD", { freshness: "stale", reason: "changed", warning: "read the current file" }, () =>
    freshnessOf(gateway, (repo) => {
      edit(repo);
      git(repo, "commit", "--quiet", "-am", "edit");
    }),
  );
  matrixCase("freshness", "file deleted", "the observed file no longer exists", { freshness: "stale", reason: "missing", warning: "read the current file" }, () =>
    freshnessOf(gateway, (repo) => {
      rmSync(join(repo, "src/gateway.ts"));
    }),
  );
  matrixCase("freshness", "clean when observed, dirty now", "uncommitted edits change the bytes", { freshness: "stale", reason: "changed", warning: "read the current file" }, () =>
    freshnessOf(gateway, (repo) => {
      edit(repo);
    }),
  );
  matrixCase(
    "freshness",
    "dirty when observed, unchanged since",
    "the hash covers the dirty bytes: the commit alone never vouches for a dirty file",
    { freshness: "current", reason: "unchanged", warning: null },
    () =>
      freshnessOf(
        gateway,
        () => undefined,
        (repo) => {
          edit(repo);
        },
      ),
  );
  matrixCase(
    "freshness",
    "dirty when observed, edited again",
    "same commit, different bytes",
    { freshness: "stale", reason: "changed", warning: "read the current file" },
    () =>
      freshnessOf(
        gateway,
        (repo) => {
          edit(repo, "// edited again\n");
        },
        (repo) => {
          edit(repo);
        },
      ),
  );
  matrixCase("freshness", "path in another repository", "never read: each repository has its own database", { freshness: "unknown", reason: "outside_worktree", warning: "read the current file" }, () =>
    freshnessOf([{ kind: "code", locator: join(namedRepo("store"), "src/gateway.ts") }], () => undefined),
  );
  matrixCase("freshness", "caller-pinned commit this repository lacks", "nothing to compare against", { freshness: "unknown", reason: "unknown_commit", warning: "read the current file" }, () =>
    freshnessOf([{ kind: "code", locator: "src/gateway.ts", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }], () => undefined),
  );
  matrixCase("freshness", "remote reference (issue/PR/URL)", "remote state changes without a local trace and Memchor makes no network call", { freshness: "unknown", reason: "remote_unverified", warning: "verify with your own tools" }, () =>
    freshnessOf([{ kind: "issue", locator: "#20" }], () => undefined),
  );
  matrixCase(
    "freshness",
    "file a transcript read (imported reference)",
    "the transcript never fingerprinted what it saw; hashing at import would certify today's bytes",
    { freshness: "unknown", reason: "transcript_reference", warning: "read the current file" },
    () => {
      const repo = namedRepo("store");
      const config = claudeConfigDir();
      installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
      const memory = open(repo, tempDir(), { claudeConfigDir: config });
      memory.bootstrap({ importChoice: "current_project" });
      return labelled(memory.recall({ query: "gateway.ts", maxTokens: 8_000 }).items.find((i) => i.title?.startsWith("Read") === true && i.externalRefs[0]?.path === "src/gateway.ts"));
    },
  );
});
