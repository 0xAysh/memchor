import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, options: { host?: string; hostSessionId?: string } = {}): Memory {
  const memory = openMemory({ cwd, host: options.host ?? "claude-code", home, ...(options.hostSessionId === undefined ? {} : { hostSessionId: options.hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** A new linked worktree of `repo` checked out on `branch` (created when `create`). */
function addWorktree(repo: string, branch: string, create = false): string {
  const path = join(tempDir("memchor-wt-"), "wt");
  git(repo, "worktree", "add", "--quiet", ...(create ? ["-b", branch, path] : [path, branch]));
  return path;
}

describe("workstream resolution", () => {
  test("branch evidence alone never binds: a new worktree on the branch of an orphaned workstream gets a choice, not a guess", () => {
    const home = tempDir();
    const repo = initRepo();
    const first = addWorktree(repo, "feat/retry", true);
    const orphan = open(first, home);
    const orphanScope = orphan.bootstrap().scope;
    orphan.checkpoint({ expectedRevision: 0, goal: "Make retries idempotent", status: "outbox drafted", nextSteps: ["wire the outbox"] });
    orphan.close();
    git(repo, "worktree", "remove", "--force", first);

    const again = open(addWorktree(repo, "feat/retry"), home).bootstrap();

    expect(again.scope.workstreamId).toBeNull();
    expect(again.scope.resolvedBy).toBeNull();
    expect(again.created.workstream).toBe(false);
    expect(again.scope.ambiguity?.candidates).toEqual([
      expect.objectContaining({
        workstreamId: orphanScope.workstreamId,
        label: "feat/retry",
        branch: "feat/retry",
        headRevision: 1,
        lastCheckpoint: { goal: "Make retries idempotent", status: "outbox drafted", next: "wire the outbox" },
        reasons: [expect.objectContaining({ signal: "branch" })],
      }),
    ]);
    expect(again.scope.ambiguity?.question).toMatch(/workstream set to the chosen workstreamId, or "new"/);
    expect(again.context.checkpoint).toBeNull();
  });

  test("two credible candidates: both are listed, nothing is bound, and the user's choice binds the worktree for later sessions", () => {
    const home = tempDir();
    const repo = initRepo();
    const firstPath = addWorktree(repo, "feat/x", true);
    const a = open(firstPath, home).bootstrap().scope.workstreamId ?? "";
    git(repo, "worktree", "remove", "--force", firstPath);
    // The next worktree on the branch is asked; the user starts a new workstream there.
    const secondPath = addWorktree(repo, "feat/x");
    const second = open(secondPath, home);
    expect(second.bootstrap().scope.ambiguity?.candidates.map((c) => c.workstreamId)).toEqual([a]);
    const chosenNew = second.bootstrap({ workstream: "new" });
    const b = chosenNew.scope.workstreamId ?? "";
    expect(chosenNew.scope).toMatchObject({ resolvedBy: "choice", ambiguity: null, workstreamLabel: "feat/x" });
    expect(chosenNew.created.workstream).toBe(true);
    expect(b).not.toBe(a);
    second.close();
    git(repo, "worktree", "remove", "--force", secondPath);

    const thirdPath = addWorktree(repo, "feat/x");
    const third = open(thirdPath, home);
    const asked = third.bootstrap();
    expect(asked.scope.workstreamId).toBeNull();
    expect(asked.scope.ambiguity?.candidates.map((c) => c.workstreamId).sort()).toEqual([a, b].sort());
    expect(asked.scope.ambiguity?.omittedCandidates).toBe(0);

    const chosen = third.bootstrap({ workstream: a });
    expect(chosen.scope).toMatchObject({ workstreamId: a, resolvedBy: "choice", ambiguity: null });
    expect(open(thirdPath, home).bootstrap().scope).toMatchObject({ workstreamId: a, resolvedBy: "worktree_binding", ambiguity: null });
  });

  test("while ambiguous the session is workspace-level: workstream writes are refused, recall and read see only workspace-level memory", () => {
    const home = tempDir();
    const repo = initRepo();
    const firstPath = addWorktree(repo, "feat/y", true);
    const orphan = open(firstPath, home);
    orphan.bootstrap();
    const privateRecord = orphan.record({ kind: "decision", body: "zebracorn decision of the orphaned workstream", attribution: "user_direction" });
    const shared = orphan.record({ kind: "preference", body: "zebracorn preference for the whole repository", attribution: "user_direction", workspaceLevel: true });
    orphan.close();
    git(repo, "worktree", "remove", "--force", firstPath);

    const memory = open(addWorktree(repo, "feat/y"), home);
    expect(memory.bootstrap().scope.ambiguity).not.toBeNull();

    const refusedRecord = catchMemchorError(() => memory.record({ kind: "note", body: "x", attribution: "agent_inference" }));
    expect(refusedRecord.code).toBe("scope_ambiguous");
    expect(refusedRecord.message).toMatch(/memory_bootstrap with workstream/);
    expect(catchMemchorError(() => memory.checkpoint({ expectedRevision: 0, goal: "g", status: "s" })).code).toBe("scope_ambiguous");
    expect(memory.record({ kind: "note", body: "workspace-wide note", attribution: "agent_inference", workspaceLevel: true }).workspaceLevel).toBe(true);

    const pack = memory.recall({ query: "zebracorn" });
    expect(pack.items.map((item) => item.recordId)).toEqual([shared.recordId]);
    expect(pack.scope.ambiguity?.candidates).toHaveLength(1);
    expect(pack.notice).toMatch(/No workstream is bound yet/);
    expect(catchMemchorError(() => memory.read({ recordId: privateRecord.recordId })).code).toBe("scope_denied");
    expect(memory.read({ recordId: shared.recordId }).body).toMatch(/zebracorn preference/);
  });

  test("a chosen id must be a workstream of this workspace; another workspace's id is not found and nothing widens", () => {
    const home = tempDir();
    const other = open(initRepo(), home).bootstrap().scope.workstreamId ?? "";
    const repo = initRepo();
    const memory = open(repo, home);
    const own = memory.bootstrap().scope.workstreamId;

    const foreign = catchMemchorError(() => memory.bootstrap({ workstream: other }));
    expect(foreign.code).toBe("not_found");
    expect(catchMemchorError(() => memory.bootstrap({ workstream: "ws_0000000000000000" })).code).toBe("invalid_input");
    expect(memory.recall().scope.workstreamId).toBe(own);
    expect(open(repo, home).bootstrap().scope.workstreamId).toBe(own);
  });

  test("the worktree binding outranks a branch that matches an orphaned workstream", () => {
    const home = tempDir();
    const repo = initRepo({ branch: "main" });
    const mainScope = open(repo, home).bootstrap().scope;
    const firstPath = addWorktree(repo, "feat/z", true);
    open(firstPath, home).bootstrap();
    git(repo, "worktree", "remove", "--force", firstPath);
    git(repo, "checkout", "--quiet", "feat/z");

    const again = open(repo, home).bootstrap().scope;
    expect(again).toMatchObject({ workstreamId: mainScope.workstreamId, resolvedBy: "worktree_binding", ambiguity: null, branch: "feat/z" });
  });

  test("an explicit task outranks the branch, and the same task in any form finds its workstream", () => {
    const home = tempDir();
    const repo = initRepo();
    const taskPath = addWorktree(repo, "fix/issue-20", true);
    const tasked = open(taskPath, home).bootstrap({ task: "#20" }).scope;
    expect(tasked).toMatchObject({ taskKey: "#20", resolvedBy: "new_workstream" });
    // An orphaned workstream carries the branch the new worktree is on.
    const branchPath = addWorktree(repo, "feat/b", true);
    open(branchPath, home).bootstrap();
    git(repo, "worktree", "remove", "--force", branchPath);

    const fresh = open(addWorktree(repo, "feat/b"), home).bootstrap({ task: "issue 20" }).scope;
    expect(fresh).toMatchObject({ workstreamId: tasked.workstreamId, resolvedBy: "task", taskKey: "#20", ambiguity: null });
    // A URL names its repository, so it is a different task key than a bare number.
    const byUrl = open(addWorktree(repo, "feat/c", true), home).bootstrap({ task: "https://github.com/Org/Repo/pull/20" }).scope;
    expect(byUrl).toMatchObject({ resolvedBy: "new_workstream", taskKey: "github.com/org/repo#20" });
    expect(byUrl.workstreamId).not.toBe(tasked.workstreamId);
  });

  test("a task that contradicts the bound workstream's task is asked about, never overridden", () => {
    const home = tempDir();
    const repo = initRepo();
    const bound = open(repo, home).bootstrap({ task: "PROJ-7" }).scope;
    expect(bound.taskKey).toBe("PROJ-7");

    const conflicting = open(repo, home);
    const asked = conflicting.bootstrap({ task: "proj-8" });
    expect(asked.scope.workstreamId).toBeNull();
    expect(asked.scope.ambiguity?.candidates).toEqual([
      expect.objectContaining({ workstreamId: bound.workstreamId, taskKey: "PROJ-7", reasons: [expect.objectContaining({ signal: "worktree_binding" })] }),
    ]);
    const started = conflicting.bootstrap({ workstream: "new", task: "proj-8" }).scope;
    expect(started).toMatchObject({ taskKey: "PROJ-8", resolvedBy: "choice" });
    // The earlier task stays reachable by naming it.
    expect(open(repo, home).bootstrap({ task: "PROJ-7" }).scope.ambiguity?.candidates.map((c) => c.workstreamId)).toContain(bound.workstreamId);
    expect(open(repo, home).bootstrap().scope.workstreamId).toBe(started.workstreamId);
  });

  test("a host session already bound to a workstream resumes it, even from another worktree", () => {
    const home = tempDir();
    const repo = initRepo();
    const first = open(repo, home, { host: "codex", hostSessionId: "thread-1" }).bootstrap().scope;
    const elsewhere = addWorktree(repo, "other", true);

    const resumed = open(elsewhere, home, { host: "codex", hostSessionId: "thread-1" }).bootstrap().scope;
    expect(resumed).toMatchObject({ workstreamId: first.workstreamId, resolvedBy: "session_binding" });
    // The same id from another host is another session.
    const third = addWorktree(repo, "third", true);
    expect(open(third, home, { host: "claude-code", hostSessionId: "thread-1" }).bootstrap().scope.resolvedBy).toBe("new_workstream");
  });
});
