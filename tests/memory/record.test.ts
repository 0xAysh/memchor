import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string): Memory {
  const memory = openMemory({ cwd, host: "codex", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("record", () => {
  test("a recorded decision cites its evidence and is recallable with attribution and applicability", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir());
    const evidence = memory.record({
      kind: "evidence",
      title: "Retry storm in checkout",
      body: "Observed 40 duplicate charge attempts when the payment gateway timed out.",
      attribution: "direct_observation",
      externalRefs: [{ kind: "code", locator: "src/checkout/retry.ts", path: "src/checkout/retry.ts", lines: [40, 82] }],
    });
    const decision = memory.record({
      kind: "decision",
      body: "Use idempotency keys on every gateway charge instead of client-side retries.",
      attribution: "user_direction",
      supportedBy: [evidence.recordId],
    });

    expect(decision.links).toEqual([{ recordId: evidence.recordId, relation: "supported_by" }]);
    expect(decision.replayed).toBe(false);

    const pack = memory.recall({ query: "gateway charge" });
    const byId = new Map(pack.items.map((item) => [item.recordId, item]));
    expect(byId.get(decision.recordId)).toMatchObject({
      kind: "decision",
      attribution: "user_direction",
      reviewState: "unreviewed",
      freshness: "unknown",
      citations: [{ recordId: evidence.recordId, relation: "supported_by" }],
      applicability: { commit: git(repo, "rev-parse", "HEAD") },
    });
    expect(byId.get(evidence.recordId)?.externalRefs).toEqual([
      { kind: "code", locator: "src/checkout/retry.ts", path: "src/checkout/retry.ts", lines: [40, 82] },
    ]);
  });

  test("replaying an operation key with the same payload returns the stored result and writes nothing new", () => {
    const memory = open(initRepo(), tempDir());
    const input = { kind: "note", body: "cache is warmed at boot", attribution: "agent_inference", operationKey: "op-1" } as const;

    const first = memory.record(input);
    const replay = memory.record({ ...input, reviewState: "unreviewed" });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(memory.status().counts?.records).toBe(1);
    expect(memory.recall({ query: "cache" }).items).toHaveLength(1);
  });

  test("reusing an operation key with a different payload is an idempotency_conflict", () => {
    const memory = open(initRepo(), tempDir());
    memory.record({ kind: "note", body: "first", attribution: "agent_inference", operationKey: "op-1" });

    const error = catchMemchorError(() =>
      memory.record({ kind: "note", body: "second", attribution: "agent_inference", operationKey: "op-1" }),
    );
    expect(error.code).toBe("idempotency_conflict");
    expect(memory.status().counts?.records).toBe(1);
  });

  test("a failed link rolls back the whole write: no record, no chunks, no operation key", () => {
    const memory = open(initRepo(), tempDir());
    const missing = "rec_" + "0".repeat(32);

    const error = catchMemchorError(() =>
      memory.record({ kind: "decision", body: "orphan decision", attribution: "agent_inference", supportedBy: [missing], operationKey: "k" }),
    );
    expect(error.code).toBe("not_found");
    expect(memory.status().counts?.records).toBe(0);
    expect(memory.recall({ query: "orphan" }).empty).toBe(true);
    // The key was not consumed, so a corrected retry with it succeeds.
    expect(memory.record({ kind: "decision", body: "orphan decision", attribution: "agent_inference", operationKey: "k" }).replayed).toBe(false);
  });

  test("bodies over 16 KiB are rejected: memory stores knowledge about artifacts, not artifacts", () => {
    const memory = open(initRepo(), tempDir());
    const error = catchMemchorError(() => memory.record({ kind: "evidence", body: "x".repeat(16 * 1024 + 1), attribution: "direct_observation" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(/content_too_large/);
  });

  test("records cannot cite a record from another workstream", () => {
    const repo = initRepo();
    const home = tempDir();
    const worktree = tempDir("memchor-wt-") + "/wt";
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const foreign = open(worktree, home).record({ kind: "note", body: "other stream", attribution: "agent_inference" });

    const error = catchMemchorError(() =>
      open(repo, home).record({ kind: "note", body: "mine", attribution: "agent_inference", links: [{ to: foreign.recordId, relation: "related_to" }] }),
    );
    expect(error.code).toBe("scope_denied");
  });
});
