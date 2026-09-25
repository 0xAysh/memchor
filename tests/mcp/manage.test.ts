import { describe, expect, test } from "vitest";
import type { ContextPack, ManageResult } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { spawnServer } from "./harness.js";

describe("memory_manage over MCP, across processes", () => {
  test("a correction made by one host's server reaches another host's running session once, and the old claim is gone for both", async () => {
    const repo = initRepo();
    const home = tempDir();
    const claude = await spawnServer({ cwd: repo, home, host: "claude-code" });
    onCleanup(() => void claude.close());
    await claude.ok("memory_bootstrap");
    const claim = await claude.ok<{ recordId: string }>("memory_record", { kind: "decision", body: "Redis is required for the job queue.", attribution: "user_direction" });

    const codex = await spawnServer({ cwd: repo, home, host: "codex" });
    onCleanup(() => void codex.close());
    const boot = await codex.ok<{ context: ContextPack }>("memory_bootstrap");
    expect(boot.context.items.map((item) => item.recordId)).toContain(claim.recordId);

    const corrected = await claude.ok<ManageResult>("memory_manage", {
      action: "correct",
      recordId: claim.recordId,
      body: "Redis is one option for the job queue.",
      reason: "The user said Redis was only an option.",
      attribution: "user_direction",
    });
    if (corrected.action !== "correct") throw new Error("unreachable");

    const pack = await codex.ok<ContextPack>("memory_recall", { query: "redis job queue" });
    expect(pack.items.map((item) => item.recordId)).toEqual([corrected.replacementId]);
    expect(pack.corrections?.changes).toEqual([expect.objectContaining({ recordId: claim.recordId, action: "correct", host: "claude-code" })]);
    expect((await codex.ok<ContextPack>("memory_recall")).corrections).toBeNull();

    const again = await codex.call("memory_manage", { action: "retract", recordId: claim.recordId, reason: "r", attribution: "user_direction" });
    expect(again.isError).toBe(true);
    expect(again.structured).toMatchObject({ error: { code: "lifecycle_conflict", retryable: false, details: { lifecycle: "corrected", replacementId: corrected.replacementId } } });
    const read = await codex.call("memory_read", { recordId: claim.recordId });
    expect(read.structured).toMatchObject({ error: { code: "not_found", details: { replacementId: corrected.replacementId } } });
  });
});
