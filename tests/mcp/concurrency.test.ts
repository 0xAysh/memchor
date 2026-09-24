import { describe, expect, test } from "vitest";
import type { BootstrapResult, StatusResult } from "../../src/memory.js";
import { initRepo, tempDir } from "../helpers.js";
import { spawnServer } from "./harness.js";

describe("MCP multi-process concurrency", () => {
  test("three processes checkpointing with the same expectedRevision: exactly one succeeds, two conflict", async () => {
    const repo = initRepo();
    const home = tempDir();
    const hosts = ["claude-code", "codex", "pi"];
    const servers = await Promise.all(hosts.map((host) => spawnServer({ cwd: repo, home, host })));
    const heads = await Promise.all(servers.map(async (s) => (await s.ok<BootstrapResult>("memory_bootstrap")).scope.headRevision));
    expect(heads).toEqual([0, 0, 0]);

    const outcomes = await Promise.all(
      servers.map((s, i) => s.call("memory_checkpoint", { expectedRevision: 0, goal: "race", status: `written by ${hosts[i] ?? "?"}` })),
    );

    const wins = outcomes.filter((o) => !o.isError);
    const conflicts = outcomes.filter((o) => o.isError);
    expect(wins).toHaveLength(1);
    expect(wins[0]?.structured).toMatchObject({ revision: 1 });
    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts) {
      expect(conflict.structured).toMatchObject({ error: { code: "checkpoint_conflict", details: { currentRevision: 1 } } });
    }
    const status = await servers[0]?.ok<StatusResult>("memory_status");
    expect(status?.counts?.checkpoints).toBe(1);
  });

  test("three processes recording concurrently lose no writes", async () => {
    const repo = initRepo();
    const home = tempDir();
    const servers = await Promise.all(["claude-code", "codex", "pi"].map((host) => spawnServer({ cwd: repo, home, host })));
    const perServer = 25;

    const outcomes = await Promise.all(
      servers.flatMap((s, i) =>
        Array.from({ length: perServer }, (_, n) =>
          s.call("memory_record", { kind: "note", body: `observation ${i}-${n}`, attribution: "direct_observation", applicability: { commit: "0000000" } }),
        ),
      ),
    );

    expect(outcomes.filter((o) => o.isError).map((o) => o.text)).toEqual([]);
    const ids = new Set(outcomes.map((o) => o.structured["recordId"]));
    expect(ids.size).toBe(3 * perServer);
    for (const s of servers) {
      expect((await s.ok<StatusResult>("memory_status")).counts?.records).toBe(3 * perServer);
    }
  });
});
