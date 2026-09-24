import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type ContextPack, type Memory } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

const entryBytes = (pack: ContextPack): number =>
  (pack.checkpoint ? Buffer.byteLength(JSON.stringify(pack.checkpoint)) : 0) +
  pack.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);

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

describe("context pack budgets", () => {
  test("a truncated pack cuts bodies, never warnings or citations, and stays within its byte budget", () => {
    const { repo, home, evidence } = staleMemory();
    const memory = open(repo, home, "codex");
    let cutItems = 0;
    // Sweep budgets so every packing boundary (whole item, cut item, no room) is exercised.
    for (let maxBytes = 3_000; maxBytes <= 9_000; maxBytes += 250) {
      const pack = memory.recall({ query: "queue decision drain", maxBytes });
      expect(pack.truncated).toBe(true);
      expect(pack.budget.usedBytes).toBe(entryBytes(pack));
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
    const pack = open(repo, home).recall({ maxBytes: 1_600 });
    expect(pack.checkpoint).toMatchObject({ truncated: true, freshness: "stale", citations: [{ recordId: evidence, relation: "supported_by" }] });
    expect(pack.checkpoint?.warning).toMatch(/read the current file/i);
    expect(pack.checkpoint?.excerpt).toMatch(/cut by Memchor.*memory_read/);
    expect(pack.items).toEqual([]);
    expect(pack.omissions).toEqual([{ reason: "budget", count: 9 }]);
    expect(pack.budget.usedBytes).toBeLessThanOrEqual(1_600);
  });

  test("at a tiny budget a leading item keeps its warning and citations with its body cut", () => {
    const { repo, home, evidence } = staleMemory();
    const memory = open(repo, home);
    const first = memory.recall({ query: "queue decision", kinds: ["decision"], maxBytes: 1_200 });
    // A continuation page has no checkpoint, so a decision leads it.
    const page = memory.recall({ continuation: first.continuation ?? "", maxBytes: 1_300 });
    const [lead] = page.items;
    expect(lead).toMatchObject({ kind: "decision", truncated: true, freshness: "stale", citations: [{ recordId: evidence, relation: "supported_by" }] });
    expect(lead?.warning).toMatch(/read the current file/i);
    expect(lead?.excerpt).toMatch(/cut by Memchor/);
    expect(page.budget.usedBytes).toBeLessThanOrEqual(1_300);
  });

  test("the initial bootstrap pack stays within the default token and byte budget", () => {
    const { repo, home } = staleMemory();
    const context = open(repo, home, "codex").bootstrap().context;
    expect(context.budget).toMatchObject({ maxTokens: 2_000, maxBytes: 8_000 });
    expect(context.budget.usedBytes).toBe(entryBytes(context));
    expect(context.budget.usedBytes).toBeLessThanOrEqual(8_000);
    expect(context.budget.usedTokens).toBeLessThanOrEqual(2_000);
    expect(context.checkpoint?.warning).toMatch(/read the current file/i);
  });
});
