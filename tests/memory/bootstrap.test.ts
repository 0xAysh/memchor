import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code") {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("bootstrap", () => {
  test("an empty Git repository bootstraps a workspace and workstream with an honest empty context", () => {
    const repo = initRepo({ branch: "feature/retry" });
    const home = tempDir();

    const result = open(repo, home).bootstrap();

    expect(result.scope.workspaceId).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(result.scope.workstreamId).toMatch(/^wst_/);
    expect(result.scope.workstreamLabel).toBe("feature/retry");
    expect(result.scope.branch).toBe("feature/retry");
    expect(result.scope.worktree).toBe(repo);
    expect(result.scope.headRevision).toBe(0);
    expect(result.created).toEqual({ workspace: true, workstream: true });
    expect(result.context.empty).toBe(true);
    expect(result.context.checkpoint).toBeNull();
    expect(result.context.items).toEqual([]);
    expect(result.context.notice).toMatch(/no memory/i);
  });
});
