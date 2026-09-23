import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, snapshotTree, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("scope", () => {
  test("outside a Git repository every operation fails closed with scope_unresolved, while status still reports", () => {
    const notARepo = tempDir("memchor-plain-");
    const memory = open(notARepo, tempDir());

    expect(catchMemchorError(() => memory.bootstrap()).code).toBe("scope_unresolved");
    expect(catchMemchorError(() => memory.recall()).code).toBe("scope_unresolved");
    expect(
      catchMemchorError(() => memory.record({ kind: "note", body: "x", attribution: "agent_inference" })).code,
    ).toBe("scope_unresolved");

    const status = memory.status();
    expect(status.problem?.code).toBe("scope_unresolved");
    expect(status.scope).toBeNull();
    expect(status.runtime.supported).toBe(true);
  });

  test("a payload cannot select scope: workspace, workstream and path keys are rejected", () => {
    const memory = open(initRepo(), tempDir());
    const base = { kind: "note", body: "hello", attribution: "agent_inference" } as const;

    for (const smuggled of [{ workspaceId: "ws_0000000000000000" }, { workstreamId: "wst_x" }, { path: "/etc" }, { cwd: "/tmp" }]) {
      const error = catchMemchorError(() => memory.record({ ...base, ...smuggled }));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toMatch(/scope/);
    }
    expect(catchMemchorError(() => memory.recall({ workspaceId: "ws_0000000000000000" } as never)).code).toBe("invalid_input");
    expect(catchMemchorError(() => memory.bootstrap({ cwd: "/" } as never)).code).toBe("invalid_input");
    expect(memory.recall().empty).toBe(true);
  });

  test("a new Memory in the same worktree resolves the same workspace and workstream", () => {
    const repo = initRepo();
    const home = tempDir();
    const first = open(repo, home).bootstrap();
    const second = open(repo, home).bootstrap();

    expect(second.scope.workspaceId).toBe(first.scope.workspaceId);
    expect(second.scope.workstreamId).toBe(first.scope.workstreamId);
    expect(second.scope.sessionId).not.toBe(first.scope.sessionId);
    expect(second.created).toEqual({ workspace: false, workstream: false });
  });

  test("the worktree binding, not the branch, identifies the workstream", () => {
    const repo = initRepo({ branch: "main" });
    const home = tempDir();
    const first = open(repo, home).bootstrap();
    git(repo, "checkout", "--quiet", "-b", "later-branch");

    const again = open(repo, home).bootstrap();
    expect(again.scope.workstreamId).toBe(first.scope.workstreamId);
    expect(again.scope.branch).toBe("later-branch");
    expect(again.scope.workstreamLabel).toBe("main");
  });

  test("a second worktree of the same repository shares the workspace but gets its own workstream", () => {
    const repo = initRepo();
    const home = tempDir();
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "mobile-bug", worktree);

    const main = open(repo, home).bootstrap();
    const other = open(worktree, home).bootstrap();

    expect(other.scope.workspaceId).toBe(main.scope.workspaceId);
    expect(other.scope.workstreamId).not.toBe(main.scope.workstreamId);
    expect(other.scope.workstreamLabel).toBe("mobile-bug");
  });

  test("a subdirectory of the worktree resolves the same scope as its root", () => {
    const repo = initRepo();
    const home = tempDir();
    const sub = join(repo, "packages", "api");
    mkdirSync(sub, { recursive: true });

    expect(open(sub, home).bootstrap().scope.workstreamId).toBe(open(repo, home).bootstrap().scope.workstreamId);
  });

  test("bootstrapping, recording, checkpointing and recalling writes nothing into the repository", () => {
    const repo = initRepo();
    const before = snapshotTree(repo);
    const statusBefore = git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored");

    const memory = open(repo, tempDir());
    memory.bootstrap();
    const { recordId } = memory.record({ kind: "evidence", body: "tests pass", attribution: "direct_observation" });
    memory.checkpoint({ expectedRevision: 0, goal: "g", status: "s", supportedBy: [recordId] });
    memory.recall({ query: "tests" });
    memory.status();
    memory.close();

    expect(snapshotTree(repo)).toEqual(before);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(statusBefore);
  });
});

describe("ambiguous scope", () => {
  test("an unbound worktree with two active candidate workstreams fails closed with scope_ambiguous", async () => {
    const { default: Database } = await import("better-sqlite3");
    const repo = initRepo({ branch: "feat" });
    const home = tempDir();
    const memory = open(repo, home);
    memory.bootstrap();
    const dbPath = memory.status().storage.dbPath;
    memory.close();
    // Fixture: a second active workstream with the same label, as a later slice's
    // "start a separate workstream" operation could create.
    const db = new Database(dbPath ?? "");
    db.prepare("INSERT INTO workstreams (id, label, created_at) VALUES ('wst_fixture', 'feat', ?)").run(new Date().toISOString());
    db.close();

    git(repo, "checkout", "--quiet", "-b", "elsewhere");
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", worktree, "feat");

    const error = catchMemchorError(() => open(worktree, home).bootstrap());
    expect(error.code).toBe("scope_ambiguous");
    expect(error.details["candidates"]).toHaveLength(2);
  });

  test("an unbound worktree adopts the single active workstream labelled with its branch", () => {
    const repo = initRepo({ branch: "feat" });
    const home = tempDir();
    const original = open(repo, home).bootstrap();
    git(repo, "checkout", "--quiet", "-b", "elsewhere");
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", worktree, "feat");

    const adopted = open(worktree, home).bootstrap();
    expect(adopted.scope.workstreamId).toBe(original.scope.workstreamId);
    expect(adopted.created.workstream).toBe(false);
  });
});
