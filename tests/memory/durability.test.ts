import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, options: { host?: string; busyTimeoutMs?: number } = {}): Memory {
  const memory = openMemory({ cwd, home, host: options.host ?? "claude-code", ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** A pack with the per-session scope fields removed, for comparing across instances. */
function stable(memory: Memory, query?: string) {
  const { scope, ...pack } = memory.recall(query === undefined ? {} : { query });
  return { workspaceId: scope.workspaceId, workstreamId: scope.workstreamId, headRevision: scope.headRevision, ...pack };
}

describe("durability", () => {
  test("bootstrap → record → checkpoint → close → reopen → recall returns the checkpoint and cited evidence", () => {
    const repo = initRepo({ branch: "fix/retries" });
    const home = tempDir();

    const first = open(repo, home, { host: "claude-code" });
    expect(first.bootstrap().context.empty).toBe(true);
    const evidence = first.record({
      kind: "evidence",
      body: "Gateway returns 504 after 30s; client retried 3x and double-charged.",
      attribution: "direct_observation",
      externalRefs: [{ kind: "code", locator: "src/gateway.ts", lines: [10, 20] }],
      operationKey: "ev-1",
    });
    const decision = first.record({
      kind: "decision",
      body: "Charge with a server-side idempotency key; no client retries.",
      attribution: "user_direction",
      supportedBy: [evidence.recordId],
    });
    first.checkpoint({
      expectedRevision: 0,
      goal: "Stop double charges",
      status: "Decided on server-side idempotency keys",
      decisions: ["Server-side idempotency key per charge"],
      nextSteps: ["Implement key storage"],
      supportedBy: [evidence.recordId, decision.recordId],
    });
    const before = stable(first, "idempotency charge");
    first.close();

    const second = open(repo, home, { host: "codex" });
    const boot = second.bootstrap();
    expect(boot.created).toEqual({ workspace: false, workstream: false });
    expect(boot.context.checkpoint).toMatchObject({ revision: 1, host: "claude-code" });
    expect(boot.context.checkpoint?.citations.map((c) => c.recordId)).toEqual([evidence.recordId, decision.recordId]);
    expect(stable(second, "idempotency charge")).toEqual(before);
    expect(before.items.map((i) => i.recordId).sort()).toEqual([evidence.recordId, decision.recordId].sort());
    // Operation keys survive restart.
    expect(
      second.record({
        kind: "evidence",
        body: "Gateway returns 504 after 30s; client retried 3x and double-charged.",
        attribution: "direct_observation",
        externalRefs: [{ kind: "code", locator: "src/gateway.ts", lines: [10, 20] }],
        operationKey: "ev-1",
      }),
    ).toEqual({ ...evidence, replayed: true });
    expect(catchMemchorError(() => second.checkpoint({ expectedRevision: 0, goal: "g", status: "s" })).code).toBe("checkpoint_conflict");
  });

  test("rebuilding the search index preserves canonical records and search results", () => {
    const memory = open(initRepo(), tempDir());
    const ids = [
      memory.record({ kind: "note", title: "Queue", body: "the queue drains every 5 minutes", attribution: "direct_observation" }).recordId,
      memory.record({ kind: "decision", body: "keep the queue drain interval " + "long ".repeat(400), attribution: "user_direction" }).recordId,
      memory.record({ kind: "reference", body: "see runbook", attribution: "agent_inference", externalRefs: [{ kind: "document", locator: "docs/queue-runbook.md" }] }).recordId,
    ];
    memory.checkpoint({ expectedRevision: 0, goal: "queue", status: "tuning drain" });
    const reads = ids.map((recordId) => memory.read({ recordId }));
    const packs = ["queue drain", "runbook", "interval"].map((q) => stable(memory, q));

    expect(memory.rebuildSearchIndex()).toMatchObject({ records: 4 });

    expect(ids.map((recordId) => memory.read({ recordId }))).toEqual(reads);
    expect(["queue drain", "runbook", "interval"].map((q) => stable(memory, q))).toEqual(packs);
    expect(packs[1]?.items.map((i) => i.recordId)).toEqual([ids[2]]);
  });
});

describe("storage failures", () => {
  test("a writer held off past the busy timeout gets a retryable storage_busy, and nothing is written", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir(), { busyTimeoutMs: 100 });
    const dbPath = memory.status().storage.dbPath ?? "";
    const other = new Database(dbPath);
    onCleanup(() => {
      other.close();
    });
    other.exec("BEGIN IMMEDIATE");

    const error = catchMemchorError(() => memory.record({ kind: "note", body: "blocked", attribution: "agent_inference" }));
    expect(error.code).toBe("storage_busy");
    expect(error.retryable).toBe(true);

    other.exec("ROLLBACK");
    expect(memory.status().counts?.records).toBe(0);
    expect(memory.record({ kind: "note", body: "unblocked", attribution: "agent_inference" }).replayed).toBe(false);
  });

  test("an unusable storage home is storage_unavailable", () => {
    const home = join(tempDir(), "home-is-a-file");
    writeFileSync(home, "");
    const error = catchMemchorError(() => open(initRepo(), home).bootstrap());
    expect(error.code).toBe("storage_unavailable");
  });

  test("a corrupt registry fails closed and is left untouched", () => {
    const home = tempDir();
    writeFileSync(join(home, "registry.json"), "{ not json");
    expect(catchMemchorError(() => open(initRepo(), home).bootstrap()).code).toBe("storage_unavailable");
  });

  test("status reports the runtime gate and storage health", () => {
    const status = open(initRepo(), tempDir()).status();
    expect(status.runtime).toMatchObject({ fts5: true, supported: true, requiredSqliteVersion: "3.51.3" });
    expect(status.runtime.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    expect(status.storage).toMatchObject({ schemaVersion: 1, supportedSchemaVersion: 1, journalMode: "wal" });
    expect(status.counts).toEqual({ records: 0, checkpoints: 0, workstreams: 1, sessions: 1 });
    expect(status.problem).toBeNull();
  });

  test("a closed Memory refuses further operations", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    memory.close();
    expect(catchMemchorError(() => memory.recall()).code).toBe("storage_unavailable");
  });
});
