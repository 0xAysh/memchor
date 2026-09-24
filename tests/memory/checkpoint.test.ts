import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("checkpoint", () => {
  test("publishing from revision 0 creates revision 1, which recall returns first with its citations", () => {
    const memory = open(initRepo(), tempDir());
    const evidence = memory.record({ kind: "evidence", body: "integration suite green on main", attribution: "direct_observation" });

    const published = memory.checkpoint({
      expectedRevision: 0,
      goal: "Ship retry hardening",
      status: "Gateway idempotency keys implemented; load test pending",
      nextSteps: ["Run the load test"],
      supportedBy: [evidence.recordId],
    });

    expect(published).toMatchObject({ revision: 1, previousRevision: 0, replayed: false });
    const pack = memory.recall();
    expect(pack.scope.headRevision).toBe(1);
    expect(pack.checkpoint).toMatchObject({
      recordId: published.recordId,
      revision: 1,
      truncated: false,
      citations: [{ recordId: evidence.recordId, relation: "supported_by" }],
    });
    expect(pack.checkpoint?.excerpt).toBe(
      "Goal: Ship retry hardening\n\nStatus: Gateway idempotency keys implemented; load test pending\n\nNext steps:\n- Run the load test",
    );
    expect(pack.items.map((item) => item.recordId)).toEqual([evidence.recordId]);
  });

  test("a stale expectedRevision is a checkpoint_conflict carrying the current revision; the head is unchanged", () => {
    const memory = open(initRepo(), tempDir());
    memory.checkpoint({ expectedRevision: 0, goal: "g", status: "one" });

    const error = catchMemchorError(() => memory.checkpoint({ expectedRevision: 0, goal: "g", status: "two" }));
    expect(error.code).toBe("checkpoint_conflict");
    expect(error.details).toMatchObject({ currentRevision: 1, expectedRevision: 0 });
    expect(memory.recall().checkpoint?.excerpt).toContain("Status: one");
    expect(memory.checkpoint({ expectedRevision: 1, goal: "g", status: "two" }).revision).toBe(2);
  });

  test("two writers on separate connections with the same expectedRevision: one succeeds, one conflicts", () => {
    const repo = initRepo();
    const home = tempDir();
    const claude = open(repo, home, "claude-code");
    const codex = open(repo, home, "codex");
    const seen = [claude.bootstrap().scope.headRevision, codex.bootstrap().scope.headRevision];
    expect(seen).toEqual([0, 0]);

    const win = claude.checkpoint({ expectedRevision: 0, goal: "g", status: "claude's view" });
    const lose = catchMemchorError(() => codex.checkpoint({ expectedRevision: 0, goal: "g", status: "codex's view" }));

    expect(win.revision).toBe(1);
    expect(lose.code).toBe("checkpoint_conflict");
    expect(lose.details["currentRevision"]).toBe(1);
    const head = codex.recall().checkpoint;
    expect(head?.excerpt).toContain("claude's view");
    expect(head?.host).toBe("claude-code");
    expect(codex.status().counts?.checkpoints).toBe(1);
  });

  test("retrying a checkpoint that already succeeded replays its result instead of conflicting", () => {
    const memory = open(initRepo(), tempDir());
    const input = { expectedRevision: 0, goal: "g", status: "s", operationKey: "cp-1" };
    const first = memory.checkpoint(input);

    expect(memory.checkpoint(input)).toEqual({ ...first, replayed: true });
    expect(memory.status().counts?.checkpoints).toBe(1);
    expect(catchMemchorError(() => memory.checkpoint({ ...input, status: "different" })).code).toBe("idempotency_conflict");
  });

  test("checkpoint history is append-only; only the head is surfaced by recall, earlier revisions stay readable", () => {
    const memory = open(initRepo(), tempDir());
    const r1 = memory.checkpoint({ expectedRevision: 0, goal: "g", status: "first status" });
    memory.checkpoint({ expectedRevision: 1, goal: "g", status: "second status" });

    const pack = memory.recall({ query: "status" });
    expect(pack.checkpoint?.revision).toBe(2);
    expect(pack.items).toEqual([]);
    expect(memory.read({ recordId: r1.recordId })).toMatchObject({ checkpointRevision: 1, kind: "checkpoint" });
  });
});
