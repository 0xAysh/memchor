import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type ContextPack, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string): Memory {
  const memory = openMemory({ cwd, host: "claude-code", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** The whole pack as a client receives it: the budget covers all of it. */
const bytesOf = (pack: ContextPack): number => Buffer.byteLength(JSON.stringify(pack), "utf8");

describe("recall", () => {
  test("an empty store is an honest miss", () => {
    const pack = open(initRepo(), tempDir()).recall();
    expect(pack).toMatchObject({ empty: true, checkpoint: null, items: [], omissions: [], truncated: false, continuation: null });
    expect(pack.budget.usedBytes).toBe(bytesOf(pack));
    expect(pack.notice).toMatch(/no prior context/i);
  });

  test("a query nothing matches is an honest miss even when other memory exists", () => {
    const memory = open(initRepo(), tempDir());
    memory.record({ kind: "note", body: "the database uses WAL", attribution: "direct_observation" });
    const pack = memory.recall({ query: "kubernetes" });
    expect(pack.empty).toBe(true);
    expect(pack.notice).toMatch(/no eligible memory/i);
  });

  test("query text is data, not FTS syntax", () => {
    const memory = open(initRepo(), tempDir());
    memory.record({ kind: "note", body: "retry NEAR backoff with jitter", attribution: "agent_inference" });
    for (const query of ['"unbalanced', "retry AND (", "text:retry", "NEAR(retry backoff)", "-retry", "retry*"]) {
      expect(() => memory.recall({ query })).not.toThrow();
    }
    expect(memory.recall({ query: 'retry" OR "x' }).items).toHaveLength(1);
    expect(catchMemchorError(() => memory.recall({ query: "!!! ???" })).code).toBe("invalid_input");
  });

  test("ranking prefers records matching more of the query, with a deterministic order", () => {
    const memory = open(initRepo(), tempDir());
    const weak = memory.record({ kind: "note", body: "retry logic lives in the worker", attribution: "agent_inference" });
    const strong = memory.record({ kind: "decision", body: "retry with exponential backoff and jitter", attribution: "user_direction" });
    const ids = memory.recall({ query: "retry backoff jitter" }).items.map((item) => item.recordId);
    expect(ids).toEqual([strong.recordId, weak.recordId]);
    expect(memory.recall({ query: "retry backoff jitter" }).items.map((item) => item.recordId)).toEqual(ids);
  });

  test("scope applies before ranking: other workstreams are excluded, workspace-level records are included", () => {
    const repo = initRepo();
    const home = tempDir();
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const mine = open(repo, home);
    const theirs = open(worktree, home);

    const own = mine.record({ kind: "note", body: "flaky test in payments", attribution: "direct_observation" });
    const shared = mine.record({ kind: "preference", body: "never mock payments in tests", attribution: "user_direction", workspaceLevel: true });
    theirs.record({ kind: "note", body: "payments payments payments flaky flaky test", attribution: "direct_observation" });

    expect(mine.recall({ query: "payments flaky test" }).items.map((i) => i.recordId).sort()).toEqual([own.recordId, shared.recordId].sort());
    const fromOther = theirs.recall({ query: "never mock payments" }).items;
    expect(fromOther.map((i) => i.recordId)).toContain(shared.recordId);
    expect(fromOther.find((i) => i.recordId === shared.recordId)?.workspaceLevel).toBe(true);
    expect(fromOther.map((i) => i.recordId)).not.toContain(own.recordId);
  });

  test("retracted records are filtered before ranking: they neither appear nor displace eligible matches", () => {
    const memory = open(initRepo(), tempDir());
    // More strong-matching retracted records than one page of candidates holds; an explicit
    // commit keeps the loop fast (it skips the per-record HEAD lookup).
    for (let i = 0; i < 210; i++) {
      const { recordId } = memory.record({
        kind: "note",
        body: `redis redis redis cluster required ${i}`,
        attribution: "agent_inference",
        applicability: { commit: "0000000" },
      });
      memory.manage({ action: "retract", recordId, reason: "wrong", attribution: "user_direction" });
    }
    const eligible = memory.record({ kind: "decision", body: "redis was only an option", attribution: "user_direction" });

    const pack = memory.recall({ query: "redis cluster required", maxTokens: 8000 });
    expect(pack.items.map((item) => item.recordId)).toEqual([eligible.recordId]);
    expect(pack.omissions).toEqual([]);
    expect(pack.truncated).toBe(false);
  });

  test("citations never point at records the workstream cannot see", () => {
    const memory = open(initRepo(), tempDir());
    const evidence = memory.record({ kind: "evidence", body: "p99 latency 900ms", attribution: "direct_observation" });
    const retracted = memory.record({ kind: "evidence", body: "p99 latency 20ms", attribution: "direct_observation" });
    memory.manage({ action: "retract", recordId: retracted.recordId, reason: "wrong", attribution: "user_direction" });
    expect(catchMemchorError(() => memory.record({ kind: "decision", body: "x", attribution: "agent_inference", supportedBy: [retracted.recordId] })).code).toBe("not_found");
    const decision = memory.record({ kind: "decision", body: "optimise the latency path", attribution: "agent_inference", supportedBy: [evidence.recordId] });
    expect(memory.recall({ query: "latency" }).items.find((i) => i.recordId === decision.recordId)?.citations).toEqual([
      { recordId: evidence.recordId, relation: "supported_by" },
    ]);
  });

  test("kinds narrow the items; the head checkpoint is still returned first", () => {
    const memory = open(initRepo(), tempDir());
    memory.record({ kind: "note", body: "alpha note", attribution: "agent_inference" });
    const pref = memory.record({ kind: "preference", body: "alpha preference", attribution: "user_direction" });
    memory.checkpoint({ expectedRevision: 0, goal: "alpha", status: "going" });
    const pack = memory.recall({ query: "alpha", kinds: ["preference"] });
    expect(pack.items.map((i) => i.recordId)).toEqual([pref.recordId]);
    expect(pack.checkpoint?.revision).toBe(1);
  });

  test("a small budget truncates; continuation pages resume the sequence exactly, each within budget", () => {
    const memory = open(initRepo(), tempDir());
    const recorded = new Set<string>();
    for (let i = 0; i < 12; i++) {
      recorded.add(memory.record({ kind: "note", body: `deploy step ${i}: ${"details ".repeat(40)}`, attribution: "agent_inference" }).recordId);
    }

    const seen: string[] = [];
    let pack = memory.recall({ query: "deploy", maxTokens: 600 });
    expect(pack.truncated).toBe(true);
    expect(pack.omissions).toEqual([{ reason: "budget", count: 12 - pack.items.length }]);
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(20);
      expect(pack.items.length).toBeGreaterThan(0);
      expect(pack.budget.usedBytes).toBe(bytesOf(pack));
      expect(pack.budget.usedBytes).toBeLessThanOrEqual(pack.budget.maxBytes);
      expect(pack.budget.usedTokens).toBe(Math.ceil(pack.budget.usedBytes / 4));
      seen.push(...pack.items.map((i) => i.recordId));
      if (pack.continuation === null) break;
      pack = memory.recall({ continuation: pack.continuation, maxTokens: 600 });
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(recorded);
    expect(pack.truncated).toBe(false);
  });

  test("records written after the first page never enter an in-flight continuation", () => {
    const memory = open(initRepo(), tempDir());
    for (let i = 0; i < 6; i++) memory.record({ kind: "note", body: `lint rule ${i} ${"x ".repeat(150)}`, attribution: "agent_inference" });
    const first = memory.recall({ maxTokens: 500 });
    const late = memory.record({ kind: "note", body: "lint rule late", attribution: "agent_inference" });

    const ids = [...first.items.map((i) => i.recordId)];
    let continuation = first.continuation;
    while (continuation !== null) {
      const page = memory.recall({ continuation, maxTokens: 500 });
      ids.push(...page.items.map((i) => i.recordId));
      continuation = page.continuation;
    }
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(late.recordId);
  });

  test("a query continuation never skips or duplicates page-1 items, even when heavy writes shift bm25 statistics", () => {
    const memory = open(initRepo(), tempDir());
    const pad = "filler ".repeat(60);
    const existing = new Set<string>();
    for (let i = 0; i < 6; i++) existing.add(memory.record({ kind: "note", body: `alpha ${i} ${pad}`, attribution: "agent_inference" }).recordId);
    for (let i = 0; i < 6; i++) existing.add(memory.record({ kind: "note", body: `beta beta ${i} ${pad}`, attribution: "agent_inference" }).recordId);

    const first = memory.recall({ query: "alpha beta", maxTokens: 600 });
    expect(first.continuation).not.toBeNull();
    const seen = first.items.map((i) => i.recordId);
    // Make "beta" common so its IDF collapses and the live ranking reorders.
    for (let i = 0; i < 60; i++) memory.record({ kind: "note", body: `beta common ${i}`, attribution: "agent_inference", applicability: { commit: "0000000" } });

    let continuation = first.continuation;
    while (continuation !== null) {
      const page = memory.recall({ continuation, maxTokens: 600 });
      seen.push(...page.items.map((i) => i.recordId));
      continuation = page.continuation;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(existing);
  });

  test("a tampered or foreign continuation is invalid_input", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    for (let i = 0; i < 5; i++) memory.record({ kind: "note", body: `item ${i} ${"y ".repeat(200)}`, attribution: "agent_inference" });
    const { continuation } = memory.recall({ maxTokens: 500 });
    expect(continuation).not.toBeNull();
    const token = continuation ?? "";

    const [payload = "", signature = ""] = token.split(".");
    const state = JSON.parse(Buffer.from(payload, "base64url").toString()) as { r: string };
    const forged = Buffer.from(JSON.stringify({ ...state, r: state.r.split(",").slice(1).join(",") })).toString("base64url") + "." + signature;
    expect(catchMemchorError(() => memory.recall({ continuation: forged })).code).toBe("invalid_input");
    expect(catchMemchorError(() => memory.recall({ continuation: token.slice(0, -2) + "zz" })).code).toBe("invalid_input");
    expect(catchMemchorError(() => memory.recall({ continuation: token, query: "other" })).code).toBe("invalid_input");

    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "elsewhere", worktree);
    expect(catchMemchorError(() => open(worktree, home).recall({ continuation: token })).code).toBe("invalid_input");
  });

  test("the head checkpoint consumes budget first and is clipped, never exceeding the budget", () => {
    const memory = open(initRepo(), tempDir());
    memory.record({ kind: "note", body: "some later item", attribution: "agent_inference" });
    memory.checkpoint({ expectedRevision: 0, goal: "big", status: "s ".repeat(1500) });

    const pack = memory.recall({ maxTokens: 500 });
    expect(pack.checkpoint?.truncated).toBe(true);
    expect(pack.items).toEqual([]);
    expect(pack.truncated).toBe(true);
    expect(pack.budget.usedBytes).toBeLessThanOrEqual(2_000);
    const next = memory.recall({ continuation: pack.continuation ?? "", maxTokens: 500 });
    expect(next.checkpoint).toBeNull();
    expect(next.items).toHaveLength(1);
  });

  test("budgets have hard caps", () => {
    const memory = open(initRepo(), tempDir());
    expect(catchMemchorError(() => memory.recall({ maxTokens: 1_000_000 })).code).toBe("invalid_input");
    expect(catchMemchorError(() => memory.recall({ maxBytes: 10_000_000 })).code).toBe("invalid_input");
    expect(memory.recall({ maxBytes: 1000 }).budget).toMatchObject({ maxBytes: 1000, maxTokens: 250 });
  });
});
