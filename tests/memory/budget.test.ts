import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type ContextPack, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** The pack as an MCP client receives it (`structuredContent`, and the same JSON as text). */
const packBytes = (pack: ContextPack): number => Buffer.byteLength(JSON.stringify(pack), "utf8");

/** A repository whose memory references `src/queue.ts`, which then changes: every item carries a stale warning. */
function staleMemory(): { repo: string; home: string; evidence: string } {
  const repo = initRepo();
  const home = tempDir();
  writeFileSync(join(repo, "queue.ts"), "export const drain = () => 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "queue");
  const memory = open(repo, home);
  const evidence = memory.record({
    kind: "evidence",
    body: "queue drain takes 40s under load",
    attribution: "direct_observation",
    externalRefs: [{ kind: "code", locator: "queue.ts" }],
  }).recordId;
  for (let i = 0; i < 8; i++) {
    memory.record({
      kind: "decision",
      body: `queue decision ${i}: ${"batch the drain loop and back off between batches ".repeat(12)}`,
      attribution: "agent_inference",
      supportedBy: [evidence],
      externalRefs: [{ kind: "code", locator: "queue.ts" }, { kind: "issue", locator: `#${100 + i}` }],
    });
  }
  memory.checkpoint({
    expectedRevision: 0,
    goal: "speed up the queue drain",
    status: "status ".repeat(200),
    externalRefs: [{ kind: "code", locator: "queue.ts" }],
    supportedBy: [evidence],
  });
  writeFileSync(join(repo, "queue.ts"), "export const drain = () => 2;\n");
  return { repo, home, evidence };
}

/** Records that each cite ten long code references: every one is larger than a small budget's room. */
function refHeavyMemory(count: number): { repo: string; home: string } {
  const repo = initRepo();
  const home = tempDir();
  const memory = open(repo, home);
  const refs = Array.from({ length: 10 }, (_, i) => ({ kind: "code" as const, locator: `src/${"deeply/nested/module/".repeat(8)}file-${i}.ts` }));
  for (let i = 0; i < count; i++) memory.record({ kind: "note", body: `ref-heavy note ${i}`, attribution: "agent_inference", externalRefs: refs });
  return { repo, home };
}

describe("context pack budgets", () => {
  test("a truncated pack cuts bodies, never warnings or citations, and stays within its byte budget", () => {
    const { repo, home, evidence } = staleMemory();
    const memory = open(repo, home, "codex");
    let cutItems = 0;
    // Sweep budgets so every packing boundary (whole item, cut item, no room) is exercised.
    for (let maxBytes = 3_000; maxBytes <= 9_000; maxBytes += 250) {
      const pack = memory.recall({ query: "queue decision drain", maxBytes });
      expect(pack.truncated).toBe(true);
      expect(pack.budget.usedBytes).toBe(packBytes(pack));
      expect(pack.budget.usedBytes).toBeLessThanOrEqual(maxBytes);
      expect(pack.omissions).toContainEqual({ reason: "budget", count: 9 - pack.items.length });
      expect(pack.checkpoint).toMatchObject({ freshness: "stale", citations: [{ recordId: evidence, relation: "supported_by" }] });
      expect(pack.checkpoint?.warning).toMatch(/read the current file/i);

      for (const item of pack.items.filter((i) => i.kind === "decision")) {
        expect(item.citations).toEqual([{ recordId: evidence, relation: "supported_by" }]);
        expect(item.freshness).toBe("stale");
        expect(item.warning).toMatch(/read the current file/i);
        expect(item.warning).toMatch(/verify .* with your own tools/i);
        expect(item.externalRefs.map((ref) => ref.reason)).toEqual(["changed", "remote_unverified"]);
        if (item.excerpt.includes("cut by Memchor")) {
          cutItems++;
          expect(item.excerpt).toMatch(/cut by Memchor.*memory_read/);
          expect(item.truncated).toBe(true);
        }
      }
    }
    expect(cutItems).toBeGreaterThan(0);
  });

  test("a checkpoint larger than the budget is cut with a marker and keeps its warning and citations", () => {
    const { repo, home, evidence } = staleMemory();
    const pack = open(repo, home).recall({ maxBytes: 2_400 });
    expect(pack.checkpoint).toMatchObject({ truncated: true, freshness: "stale", citations: [{ recordId: evidence, relation: "supported_by" }] });
    expect(pack.checkpoint?.warning).toMatch(/read the current file/i);
    expect(pack.checkpoint?.excerpt).toMatch(/cut by Memchor.*memory_read/);
    expect(pack.items).toEqual([]);
    expect(pack.omissions).toEqual([{ reason: "budget", count: 9 }]);
    expect(pack.budget.usedBytes).toBeLessThanOrEqual(2_400);
  });

  test("at a tiny budget a leading item keeps its warning and citations with its body cut", () => {
    const { repo, home, evidence } = staleMemory();
    const memory = open(repo, home);
    const first = memory.recall({ query: "queue decision", kinds: ["decision"], maxBytes: 2_000 });
    // A continuation page has no checkpoint, so a decision leads it.
    const page = memory.recall({ continuation: first.continuation ?? "", maxBytes: 2_100 });
    const [lead] = page.items;
    expect(lead).toMatchObject({ kind: "decision", truncated: true, freshness: "stale", citations: [{ recordId: evidence, relation: "supported_by" }] });
    expect(lead?.warning).toMatch(/read the current file/i);
    expect(lead?.excerpt).toMatch(/cut by Memchor/);
    expect(page.budget.usedBytes).toBeLessThanOrEqual(2_100);
  });

  test("the whole returned pack, scope, notice, omissions and continuation included, fits its budget", () => {
    const { repo, home } = staleMemory();
    const memory = open(repo, home, "codex");
    for (let maxBytes = 1_500; maxBytes <= 9_000; maxBytes += 250) {
      for (const pack of [memory.recall({ query: "queue decision drain", maxBytes }), memory.recall({ maxBytes })]) {
        expect(packBytes(pack)).toBeLessThanOrEqual(maxBytes);
        expect(pack.budget.usedBytes).toBe(packBytes(pack));
        expect(pack.budget.usedTokens).toBe(Math.ceil(pack.budget.usedBytes / 4));
        if (pack.continuation !== null) expect(packBytes(memory.recall({ continuation: pack.continuation, maxBytes }))).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  test("with records larger than the budget, every page fits, none is starved, and each record is returned or reported once", () => {
    const { repo, home } = refHeavyMemory(60);
    const memory = open(repo, home, "codex");
    // 1_000 holds the envelope and one oversized id but not the whole continuation: what it cannot carry is reported.
    for (const maxBytes of [1_000, 1_500, 1_750, 2_000, 2_500, 3_500, 5_000, 9_000]) {
      let pack = memory.recall({ maxBytes });
      const seen: string[] = [];
      let limited = 0;
      for (let pages = 0; pages < 100; pages++) {
        expect(packBytes(pack)).toBeLessThanOrEqual(maxBytes);
        expect(pack.notice ?? "").not.toMatch(/too small for even/);
        const oversized = pack.omissions.find((o) => o.reason === "exceeds_budget");
        expect(oversized?.recordIds?.length ?? 0).toBe(oversized?.count ?? 0);
        seen.push(...pack.items.map((item) => item.recordId), ...(oversized?.recordIds ?? []));
        if (pack.continuation === null) {
          limited = pack.omissions.find((o) => o.reason === "candidate_limit")?.count ?? 0;
          break;
        }
        expect(pack.items.length + (oversized?.count ?? 0)).toBeGreaterThan(0);
        pack = memory.recall({ continuation: pack.continuation, maxBytes });
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length + limited).toBe(60);
    }
  });

  test("a large candidate set keeps its continuation within the budget, and what the token cannot carry is reported", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir());
    for (let i = 0; i < 520; i++) memory.record({ kind: "note", body: `widget fact ${i}`, attribution: "agent_inference" });
    for (const maxBytes of [2_000, 3_000, 4_000, 8_000, 16_000, 32_000]) {
      let pack = memory.recall({ query: "widget", maxBytes });
      expect(pack.continuation).not.toBeNull();
      const reachable = pack.items.length + (pack.omissions.find((o) => o.reason === "budget")?.count ?? 0);
      const reported = pack.omissions.find((o) => o.reason === "candidate_limit")?.count ?? 0;
      expect(reachable + reported).toBe(520);
      const seen = new Set<string>();
      for (let pages = 0; pages < 200; pages++) {
        expect(packBytes(pack)).toBeLessThanOrEqual(maxBytes);
        for (const item of pack.items) seen.add(item.recordId);
        if (pack.continuation === null) break;
        pack = memory.recall({ continuation: pack.continuation, maxBytes });
      }
      // Every record the first page promised through its continuation is delivered, once.
      expect(seen.size).toBe(reachable);
    }
  });

  test("an ambiguous session's pack, its scope question and notice included, fits the budget", () => {
    const home = tempDir();
    const repo = initRepo();
    const first = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/amb", first);
    const orphan = open(first, home);
    orphan.bootstrap();
    orphan.checkpoint({ expectedRevision: 0, goal: "an orphaned goal ".repeat(10), status: "still going ".repeat(20), nextSteps: ["resume it"] });
    for (let i = 0; i < 12; i++) orphan.record({ kind: "preference", body: `repository-wide preference ${i}: ${"prefer small commits ".repeat(10)}`, attribution: "user_direction", workspaceLevel: true });
    orphan.close();
    git(repo, "worktree", "remove", "--force", first);
    const second = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", second, "feat/amb");

    const memory = open(second, home);
    const boot = memory.bootstrap({ maxBytes: 4_000 });
    expect(boot.scope.ambiguity).not.toBeNull();
    expect(boot.context.notice).toMatch(/No workstream is bound yet/);
    expect(packBytes(boot.context)).toBeLessThanOrEqual(4_000);
    expect(boot.context.budget.usedBytes).toBe(packBytes(boot.context));
    for (let maxBytes = 3_000; maxBytes <= 9_000; maxBytes += 500) {
      const pack = memory.recall({ maxBytes });
      expect(pack.notice).toMatch(/No workstream is bound yet/);
      expect(packBytes(pack)).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("bootstrap takes the same budget inputs as recall, validated the same way", () => {
    const { repo, home } = staleMemory();
    const memory = open(repo, home, "codex");
    const context = memory.bootstrap({ maxTokens: 700 }).context;
    expect(context.budget).toMatchObject({ maxTokens: 700, maxBytes: 2_800 });
    expect(packBytes(context)).toBeLessThanOrEqual(2_800);
    expect(catchMemchorError(() => memory.bootstrap({ maxTokens: 1_000_000 })).code).toBe("invalid_input");
    expect(catchMemchorError(() => memory.bootstrap({ maxBytes: 10 })).code).toBe("invalid_input");
  });

  test("records too large for a small budget are reported by id without starving the pack of what fits", () => {
    const { repo, home } = refHeavyMemory(60);
    const memory = open(repo, home);
    for (const maxBytes of [1_500, 2_500]) {
      const pack = memory.recall({ maxBytes });
      expect(packBytes(pack)).toBeLessThanOrEqual(maxBytes);
      expect(pack.notice).not.toMatch(/too small for even/);
      // Every record is accounted for: returned, reported as too large, or carried/reported for later.
      const accounted = (reason: string): number => pack.omissions.find((o) => o.reason === reason)?.count ?? 0;
      expect(pack.items.length + accounted("exceeds_budget") + accounted("budget") + accounted("candidate_limit")).toBe(60);
      expect(pack.items.length + accounted("exceeds_budget")).toBeGreaterThan(0);
      expect(pack.continuation).not.toBeNull();
      expect(accounted("budget")).toBeGreaterThan(0);
    }
  });

  test("a budget too small for the pack's own scope returns no entries and no continuation, and says why", () => {
    const { repo, home } = staleMemory();
    const pack = open(repo, home).recall({ maxBytes: 64 });
    expect(pack).toMatchObject({ checkpoint: null, items: [], continuation: null, truncated: true, empty: false });
    expect(pack.omissions).toEqual([{ reason: "candidate_limit", count: 9 }]);
    expect(pack.notice).toMatch(/too small/);
    expect(pack.budget.usedBytes).toBe(packBytes(pack));
  });

  test("the initial bootstrap pack stays within the default token and byte budget", () => {
    const { repo, home } = staleMemory();
    const context = open(repo, home, "codex").bootstrap().context;
    expect(context.budget).toMatchObject({ maxTokens: 2_000, maxBytes: 8_000 });
    expect(context.budget.usedBytes).toBe(packBytes(context));
    expect(packBytes(context)).toBeLessThanOrEqual(8_000);
    expect(context.budget.usedBytes).toBeLessThanOrEqual(8_000);
    expect(context.budget.usedTokens).toBeLessThanOrEqual(2_000);
    expect(context.checkpoint?.warning).toMatch(/read the current file/i);
  });
});
