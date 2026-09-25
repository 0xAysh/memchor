import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapResult } from "../../src/memory.js";
import { git, initRepo, tempDir } from "../helpers.js";
import { spawnServer } from "./harness.js";

describe("MCP scope resolution across processes", () => {
  test("two hosts bootstrapping a moved repository at once both land in its original workspace and workstream", async () => {
    const home = tempDir();
    const repo = initRepo();
    const before = await spawnServer({ cwd: repo, home, host: "claude-code" });
    const original = (await before.ok<BootstrapResult>("memory_bootstrap")).scope;
    await before.ok("memory_record", { kind: "decision", body: "decided before the move", attribution: "user_direction" });
    await before.close();

    const moved = join(tempDir("memchor-moved-"), "checkout");
    renameSync(repo, moved);
    const servers = await Promise.all(["claude-code", "codex"].map((host) => spawnServer({ cwd: moved, home, host })));
    const boots = await Promise.all(servers.map((s) => s.ok<BootstrapResult>("memory_bootstrap")));

    for (const boot of boots) {
      expect(boot.scope).toMatchObject({ workspaceId: original.workspaceId, workstreamId: original.workstreamId, worktree: moved });
      expect(boot.context.items.map((item) => item.excerpt)).toContain("decided before the move");
    }
    const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8")) as { repositories: Record<string, { workspaceId: string }> };
    expect(Object.entries(registry.repositories)).toEqual([[join(moved, ".git"), expect.objectContaining({ workspaceId: original.workspaceId })]]);
  });

  test("an ambiguous bootstrap asks, refuses workstream writes, and binds the user's choice", async () => {
    const home = tempDir();
    const repo = initRepo();
    const first = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/pay", first);
    const orphanServer = await spawnServer({ cwd: first, home, host: "claude-code" });
    const orphan = (await orphanServer.ok<BootstrapResult>("memory_bootstrap")).scope.workstreamId;
    await orphanServer.close();
    git(repo, "worktree", "remove", "--force", first);
    const second = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", second, "feat/pay");

    const server = await spawnServer({ cwd: second, home, host: "codex" });
    expect(server.client.getInstructions()).toMatch(/scope\.ambiguity/);
    const tools = await server.client.listTools();
    const bootstrapSchema = tools.tools.find((tool) => tool.name === "memory_bootstrap")?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(bootstrapSchema.properties ?? {})).toEqual(expect.arrayContaining(["task", "workstream"]));

    const asked = await server.ok<BootstrapResult>("memory_bootstrap");
    expect(asked.scope.workstreamId).toBeNull();
    expect(asked.scope.ambiguity?.candidates.map((c) => c.workstreamId)).toEqual([orphan]);
    const refused = await server.call("memory_record", { kind: "note", body: "x", attribution: "agent_inference" });
    expect(refused).toMatchObject({ isError: true, structured: { error: { code: "scope_ambiguous" } } });
    expect((await server.call("memory_bootstrap", { workstreamId: orphan })).structured).toMatchObject({ error: { code: "invalid_input" } });

    const chosen = await server.ok<BootstrapResult>("memory_bootstrap", { workstream: orphan });
    expect(chosen.scope).toMatchObject({ workstreamId: orphan, resolvedBy: "choice", ambiguity: null });
    expect((await server.call("memory_record", { kind: "note", body: "after choosing", attribution: "agent_inference" })).isError).toBe(false);
  });
});
