import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, options: { host?: string; busyTimeoutMs?: number } = {}): Memory {
  const memory = openMemory({ cwd, home, host: options.host ?? "claude-code", ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function mkdirp(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

/** A pack with the per-session scope fields (and the byte usage they change) removed, for comparing across instances. */
function stable(memory: Memory, query?: string) {
  const { scope, budget, ...pack } = memory.recall(query === undefined ? {} : { query });
  return { workspaceId: scope.workspaceId, workstreamId: scope.workstreamId, headRevision: scope.headRevision, maxBytes: budget.maxBytes, ...pack };
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

describe("atomic writes", () => {
  test("a failure after the chunks are written rolls back the record, its links, its chunks and its operation key", () => {
    const memory = open(initRepo(), tempDir());
    const evidence = memory.record({ kind: "evidence", body: "baseline evidence", attribution: "direct_observation" });
    const dbPath = memory.status().storage.dbPath ?? "";
    const raw = new Database(dbPath);
    onCleanup(() => {
      raw.close();
    });
    const counts = () =>
      raw.prepare("SELECT (SELECT count(*) FROM records) AS records, (SELECT count(*) FROM links) AS links, (SELECT count(*) FROM chunks) AS chunks, (SELECT count(*) FROM operations) AS operations").get();
    const before = counts();
    // The operation row is the last insert of a record write, after links and chunks.
    raw.exec("CREATE TRIGGER fail_operations BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");

    expect(() =>
      memory.record({ kind: "decision", body: "zeppelin decision", attribution: "agent_inference", supportedBy: [evidence.recordId], operationKey: "op-rollback" }),
    ).toThrow(/injected failure/);

    raw.exec("DROP TRIGGER fail_operations");
    expect(counts()).toEqual(before);
    expect(memory.recall({ query: "zeppelin" }).empty).toBe(true);
    expect(memory.read({ recordId: evidence.recordId }).links).toEqual([]);
    expect(memory.checkIntegrity()).toMatchObject({ ok: true, searchIndex: "ok" });
  });
});

describe("read-only diagnostics", () => {
  test("status on a fresh repository writes nothing, and the first bootstrap still creates the workspace and workstream", () => {
    const repo = initRepo();
    const home = tempDir();
    const status = open(repo, home).status();
    expect(status.problem).toBeNull();
    expect(status.scope).toMatchObject({ worktree: repo, workstreamId: null, sessionId: null });
    expect(status.storage.schemaVersion).toBeNull();
    expect(readdirSync(home)).toEqual([]);
    expect(open(repo, home).checkIntegrity()).toMatchObject({ exists: false, ok: true });
    expect(readdirSync(home)).toEqual([]);

    expect(open(repo, home).bootstrap().created).toEqual({ workspace: true, workstream: true });
  });

  test("status and checkIntegrity on an existing workspace create no sessions, workstreams or bindings", () => {
    const repo = initRepo();
    const home = tempDir();
    const boot = open(repo, home).bootstrap();
    const other = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "unbound", other);

    const inspector = open(other, home);
    const status = inspector.status();
    expect(status.scope).toMatchObject({ workspaceId: boot.scope.workspaceId, workstreamId: null });
    expect(inspector.checkIntegrity().ok).toBe(true);
    expect(open(repo, home).status()).toMatchObject({
      counts: { sessions: 1, workstreams: 1 },
      scope: { workstreamId: boot.scope.workstreamId, sessionId: null },
    });
    expect(open(other, home).bootstrap().created.workstream).toBe(true);
  });

  test("checkIntegrity reports a damaged database instead of throwing, and never migrates one", () => {
    const repo = initRepo();
    const home = tempDir();
    const dbPath = open(repo, home).status().storage.dbPath ?? "";
    mkdirp(dbPath);
    const empty = new Database(dbPath);
    empty.exec("CREATE TABLE unrelated (x)");
    empty.close();
    expect(open(repo, home).checkIntegrity()).toMatchObject({ exists: true, schemaVersion: 0 });
    const still = new Database(dbPath, { readonly: true });
    expect(still.pragma("user_version", { simple: true })).toBe(0);
    still.close();

    writeFileSync(dbPath, "this is not a database ".repeat(200));
    const report = open(repo, home).checkIntegrity();
    expect(report.ok).toBe(false);
    expect(report.sqlite.join(" ")).toMatch(/not a database/);
  });
});

describe("storage failures", () => {
  test("a writer held off past the busy timeout gets a retryable storage_busy, and nothing is written", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir(), { busyTimeoutMs: 100 });
    memory.bootstrap();
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
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    const status = memory.status();
    expect(status.runtime).toMatchObject({ fts5: true, supported: true, requiredSqliteVersion: "3.51.3" });
    expect(status.runtime.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    expect(status.storage).toMatchObject({ schemaVersion: 5, supportedSchemaVersion: 5, journalMode: "wal" });
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
