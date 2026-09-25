import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** Moves a repository directory to a fresh location (same filesystem), as `mv` would. */
function moveRepo(repo: string): string {
  const target = join(tempDir("memchor-moved-"), "renamed-checkout");
  renameSync(repo, target);
  return target;
}

describe("repository identity", () => {
  test("a moved repository keeps its workspace and workstream, and its memory stays visible", () => {
    const home = tempDir();
    const repo = initRepo({ branch: "feat/moves" });
    const before = open(repo, home);
    const boot = before.bootstrap();
    const { recordId } = before.record({ kind: "decision", body: "Keep retries idempotent with an outbox", attribution: "user_direction" });
    before.checkpoint({ expectedRevision: 0, goal: "survive a move", status: "recorded before mv" });
    before.close();

    const moved = moveRepo(repo);
    const after = open(moved, home).bootstrap();

    expect(after.scope.workspaceId).toBe(boot.scope.workspaceId);
    expect(after.scope.workstreamId).toBe(boot.scope.workstreamId);
    expect(after.scope.worktree).toBe(moved);
    expect(after.scope.headRevision).toBe(1);
    expect(after.created).toEqual({ workspace: false, workstream: false });
    expect(after.context.items.map((item) => item.recordId)).toContain(recordId);
    // The next session there resolves the same way without re-detecting the move.
    expect(open(moved, home).bootstrap().scope.workstreamId).toBe(boot.scope.workstreamId);
  });

  test("two unrelated repositories with the same directory name are different workspaces", () => {
    const home = tempDir();
    const a = join(tempDir("memchor-a-"), "api");
    const b = join(tempDir("memchor-b-"), "api");
    for (const dir of [a, b]) {
      mkdirSync(dir);
      git(dir, "init", "--quiet", "--initial-branch=main");
      writeFileSync(join(dir, "README.md"), `# ${dir}\n`);
      git(dir, "add", "README.md");
      git(dir, "commit", "--quiet", "-m", "initial");
    }
    const first = open(a, home);
    first.record({ kind: "note", body: "only in repository a", attribution: "agent_inference" });
    const scopeA = first.bootstrap().scope;
    const scopeB = open(b, home).bootstrap();

    expect(scopeA.workspaceLabel).toBe("api");
    expect(scopeB.scope.workspaceLabel).toBe("api");
    expect(scopeB.scope.workspaceId).not.toBe(scopeA.workspaceId);
    expect(scopeB.context.empty).toBe(true);
  });

  test("a clone whose original still exists is a separate workspace, even with the same history", () => {
    const home = tempDir();
    const original = initRepo();
    const originalScope = open(original, home).bootstrap().scope;
    const clone = join(tempDir("memchor-clone-"), "copy");
    git(original, "clone", "--quiet", original, clone);

    const cloneScope = open(clone, home).bootstrap().scope;
    expect(cloneScope.workspaceId).not.toBe(originalScope.workspaceId);
    expect(open(original, home).bootstrap().scope.workspaceId).toBe(originalScope.workspaceId);
  });

  test("a repository without commits is never matched by history: moving it starts a new workspace", () => {
    const home = tempDir();
    const repo = initRepo({ commit: false });
    const before = open(repo, home).bootstrap().scope;
    const after = open(moveRepo(repo), home).bootstrap();

    expect(after.scope.workspaceId).not.toBe(before.workspaceId);
    expect(after.created.workspace).toBe(true);
  });

  test("worktrees inside a moved repository follow it, each keeping its own workstream", () => {
    const home = tempDir();
    const repo = initRepo({ branch: "main" });
    const nested = join(repo, ".worktrees", "side");
    git(repo, "worktree", "add", "--quiet", "-b", "side", nested);
    const outside = join(tempDir("memchor-wt-"), "outside");
    git(repo, "worktree", "add", "--quiet", "-b", "outside", outside);
    const main = open(repo, home).bootstrap().scope;
    const side = open(nested, home).bootstrap().scope;
    const out = open(outside, home).bootstrap().scope;
    expect(new Set([main.workstreamId, side.workstreamId, out.workstreamId]).size).toBe(3);

    const moved = moveRepo(repo);
    git(moved, "worktree", "repair", join(moved, ".worktrees", "side"));

    expect(open(join(moved, ".worktrees", "side"), home).bootstrap().scope).toMatchObject({ workspaceId: main.workspaceId, workstreamId: side.workstreamId });
    expect(open(moved, home).bootstrap().scope).toMatchObject({ workspaceId: main.workspaceId, workstreamId: main.workstreamId });
    expect(open(outside, home).bootstrap().scope).toMatchObject({ workspaceId: main.workspaceId, workstreamId: out.workstreamId });
  });

  test("a path reused by a different repository gets its own workspace, and the moved original reclaims its memory", () => {
    const home = tempDir();
    const repo = initRepo();
    const original = open(repo, home);
    const { recordId } = original.record({ kind: "decision", body: "Original repository decision", attribution: "user_direction" });
    const originalScope = original.bootstrap().scope;
    original.close();

    const moved = moveRepo(repo);
    // An unrelated repository appears at the old path before the original is used again.
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "OTHER.md"), "unrelated\n");
    git(repo, "add", "OTHER.md");
    git(repo, "commit", "--quiet", "-m", "unrelated root");

    const newcomer = open(repo, home).bootstrap();
    expect(newcomer.scope.workspaceId).not.toBe(originalScope.workspaceId);
    expect(newcomer.context.items).toEqual([]);

    const reclaimed = open(moved, home).bootstrap();
    expect(reclaimed.scope).toMatchObject({ workspaceId: originalScope.workspaceId, workstreamId: originalScope.workstreamId });
    expect(reclaimed.context.items.map((item) => item.recordId)).toEqual([recordId]);
  });

  test("when two vanished copies share the history, a newcomer is not guessed onto either", () => {
    const home = tempDir();
    const original = initRepo();
    const copy = join(tempDir("memchor-clone-"), "copy");
    git(original, "clone", "--quiet", original, copy);
    const a = open(original, home).bootstrap().scope.workspaceId;
    const b = open(copy, home).bootstrap().scope.workspaceId;
    const third = join(tempDir("memchor-clone-"), "third");
    git(original, "clone", "--quiet", original, third);
    rmSync(original, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });

    const newcomer = open(third, home).bootstrap().scope.workspaceId;
    expect([a, b]).not.toContain(newcomer);
  });

  test("the transcript-import approval given before a move still applies after it", () => {
    const home = tempDir();
    const config = tempDir("memchor-claude-");
    const repo = initRepo();
    const first = openMemory({ cwd: repo, host: "claude-code", home, claudeConfigDir: config });
    onCleanup(() => {
      first.close();
    });
    expect(first.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
    first.close();

    const moved = moveRepo(repo);
    const after = openMemory({ cwd: moved, host: "claude-code", home, claudeConfigDir: config });
    onCleanup(() => {
      after.close();
    });
    expect(after.bootstrap().import.state).toBe("complete");
  });
});
