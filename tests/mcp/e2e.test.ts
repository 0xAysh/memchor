import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapResult, CheckpointResult, ContextPack, RecordResult } from "../../src/memory.js";
import { initRepo, tempDir } from "../helpers.js";
import { spawnServer } from "./harness.js";

const ARTIFACTS = join(import.meta.dirname, "__artifacts__");

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`process ${pid} did not exit`);
}

describe("MCP end-to-end", () => {
  test("bootstrap → record → checkpoint → kill → restart → recall returns the checkpoint and cited evidence within budget", async () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const home = tempDir();

    const first = await spawnServer({ cwd: repo, home, host: "claude-code" });
    const boot = await first.ok<BootstrapResult>("memory_bootstrap", { hostSessionId: "claude-session-1" });
    expect(boot.context.empty).toBe(true);
    expect(boot.scope.workstreamLabel).toBe("fix/double-charge");

    const evidence = await first.ok<RecordResult>("memory_record", {
      kind: "evidence",
      title: "Gateway timeout causes duplicate charges",
      body: "Load test: gateway returned 504 after 30s; the client retried 3 times and the card was charged twice.",
      attribution: "direct_observation",
      externalRefs: [{ kind: "code", locator: "src/payments/gateway.ts", path: "src/payments/gateway.ts", lines: [41, 88] }],
    });
    const decision = await first.ok<RecordResult>("memory_record", {
      kind: "decision",
      body: "Charge with a server-side idempotency key per order; remove client-side retries.",
      attribution: "user_direction",
      supportedBy: [evidence.recordId],
    });
    const checkpoint = await first.ok<CheckpointResult>("memory_checkpoint", {
      expectedRevision: boot.scope.headRevision,
      goal: "Stop duplicate charges on gateway timeouts",
      status: "Root cause confirmed; idempotency-key design agreed; implementation not started.",
      decisions: ["Server-side idempotency key per order"],
      failedAttempts: ["Client retry with backoff still double-charges"],
      nextSteps: ["Add idempotency_keys table", "Remove client retries in checkout.ts"],
      supportedBy: [evidence.recordId, decision.recordId],
    });
    expect(checkpoint.revision).toBe(1);

    process.kill(first.pid, "SIGKILL");
    await waitForExit(first.pid);

    const second = await spawnServer({ cwd: repo, home, host: "codex" });
    const pack = await second.ok<ContextPack>("memory_recall", { query: "duplicate charge idempotency", maxTokens: 1200 });

    expect(pack.scope.headRevision).toBe(1);
    expect(pack.checkpoint).toMatchObject({ recordId: checkpoint.recordId, revision: 1, host: "claude-code" });
    expect(pack.checkpoint?.citations).toEqual([
      { recordId: evidence.recordId, relation: "supported_by" },
      { recordId: decision.recordId, relation: "supported_by" },
    ]);
    const decisionItem = pack.items.find((item) => item.recordId === decision.recordId);
    expect(decisionItem?.citations).toEqual([{ recordId: evidence.recordId, relation: "supported_by" }]);
    expect(pack.items.find((item) => item.recordId === evidence.recordId)).toMatchObject({
      attribution: "direct_observation",
      freshness: "unknown",
      externalRefs: [{ kind: "code", locator: "src/payments/gateway.ts" }],
    });
    expect(pack.budget.usedBytes).toBeLessThanOrEqual(pack.budget.maxBytes);
    expect(pack.budget.maxTokens).toBe(1200);
    expect(pack.empty).toBe(false);

    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "sample-context-pack.json"), JSON.stringify(pack, null, 2) + "\n");
  });
});
