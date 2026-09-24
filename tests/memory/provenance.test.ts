import { describe, expect, test } from "vitest";
import { openMemory, type ContextPack, type Memory, type PackItem } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "../import/fixtures.js";

interface Env {
  repo: string;
  home: string;
  config: string;
}

function env(): Env {
  return { repo: initRepo(), home: tempDir(), config: claudeConfigDir() };
}

function open(e: Env, host = "claude-code"): Memory {
  const memory = openMemory({ cwd: e.repo, home: e.home, host, claudeConfigDir: e.config });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function itemsStating(pack: ContextPack, text: string): PackItem[] {
  return pack.items.filter((item) => item.excerpt === text);
}

const USER_ASK = "Checkout double-charges when the payment gateway times out. Find out why before changing anything.";

describe("provenance and independent roots", () => {
  test("a transcript copied by /branch is one root: its events collapse into one item listing the copy", () => {
    const e = env();
    // A branched session re-stores the parent's entries (same event ids) under a new session id.
    const parent = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: e.repo });
    const branch = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: e.repo });
    open(e).bootstrap({ importChoice: "current_project" });

    const pack = open(e, "codex").recall({ query: "double charges gateway times out", maxTokens: 8_000 });
    const items = itemsStating(pack, USER_ASK);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.corroboration).toEqual({ independentRoots: 1, records: 2 });
    expect(item?.independentRoot).toBe("event:claude-code/00000000-0000-4000-8000-000000000001");
    expect(item?.copies).toHaveLength(1);
    const transcripts = [item?.source?.transcriptId, item?.copies[0]?.source?.transcriptId].sort();
    expect(transcripts).toEqual([parent.sessionId, branch.sessionId].sort());
    expect(item).toMatchObject({ host: "claude-code", source: { host: "claude-code", eventId: "00000000-0000-4000-8000-000000000001" } });
    expect(item?.sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(item?.copies[0]?.sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  test("records derived from or resting on a claim repeat its root instead of corroborating it", () => {
    const e = env();
    const memory = open(e);
    const claim = "The gateway retries a 504 without an idempotency key.";
    const original = memory.record({ kind: "evidence", body: claim, attribution: "direct_observation" });
    const derived = memory.record({ kind: "note", body: claim, attribution: "agent_inference", links: [{ to: original.recordId, relation: "derived_from" }] });
    const restated = open(e, "codex").record({ kind: "decision", body: `  ${claim}\n`, attribution: "agent_inference", supportedBy: [derived.recordId] });

    const items = itemsStating(open(e, "codex").recall({ query: "idempotency key" }), claim);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ independentRoot: `record:${original.recordId}`, corroboration: { independentRoots: 1, records: 3 } });
    const ids = [items[0]?.recordId, ...(items[0]?.copies.map((copy) => copy.recordId) ?? [])].sort();
    expect(ids).toEqual([original.recordId, derived.recordId, restated.recordId].sort());
    expect(memory.read({ recordId: restated.recordId }).independentRoot).toBe(`record:${original.recordId}`);
  });

  test("Memchor output echoed in a transcript never becomes a second copy of the claim", () => {
    const e = env();
    const claim = "Charges must carry a server-side idempotency key per order.";
    const { recordId } = open(e).record({ kind: "decision", body: claim, attribution: "user_direction" });
    const echoed = renderFixture("2.1.281/basic.jsonl", { cwd: e.repo, sessionId: "00000000-0000-4000-8000-00000000e40e" })
      .replace("rec_0123456789abcdef0123456789abcdef", recordId)
      .replace("SYNTHETIC-ECHO previously recalled memory", claim);
    installTranscript(e.config, "", { cwd: e.repo, content: echoed });
    open(e).bootstrap({ importChoice: "current_project" });

    const items = itemsStating(open(e, "codex").recall({ query: "idempotency key per order" }), claim);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ recordId, corroboration: { independentRoots: 1, records: 1 }, copies: [] });
  });

  test("two independent observations of the same claim are two roots, both kept", () => {
    const e = env();
    const claim = "npm test passes on main.";
    const claude = open(e).record({ kind: "evidence", body: claim, attribution: "direct_observation" });
    const codex = open(e, "codex").record({ kind: "evidence", body: claim, attribution: "direct_observation" });

    const items = itemsStating(open(e).recall({ query: "npm test passes" }), claim);
    expect(items.map((item) => item.recordId).sort()).toEqual([claude.recordId, codex.recordId].sort());
    for (const item of items) expect(item).toMatchObject({ corroboration: { independentRoots: 2, records: 2 }, copies: [] });
    expect(items.map((item) => item.host).sort()).toEqual(["claude-code", "codex"]);
  });

  test("conflicting Claude and Codex observations are both returned, each attributed to its host", () => {
    const e = env();
    const claude = open(e).record({ kind: "decision", body: "Use Redis for the retry queue.", attribution: "agent_inference" });
    const codex = open(e, "codex").record({ kind: "decision", body: "Do not add Redis; the retry queue is an outbox table.", attribution: "direct_observation" });

    const pack = open(e, "claude-code").recall({ query: "retry queue redis" });
    const byId = new Map(pack.items.map((item) => [item.recordId, item]));
    expect(byId.get(claude.recordId)).toMatchObject({ host: "claude-code", attribution: "agent_inference", independentRoot: `record:${claude.recordId}`, corroboration: { independentRoots: 1, records: 1 } });
    expect(byId.get(codex.recordId)).toMatchObject({ host: "codex", attribution: "direct_observation", independentRoot: `record:${codex.recordId}`, corroboration: { independentRoots: 1, records: 1 } });
  });

  test("a newer restatement never displaces the observation it copies: the item keeps the original's host, kind and attribution", () => {
    const e = env();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: e.repo });
    const claude = open(e);
    claude.bootstrap({ importChoice: "current_project" });
    const imported = itemsStating(claude.recall({ query: "double charges gateway times out" }), USER_ASK)[0];
    // The decision rests on the imported ask, so it and its restatement share the ask's root and neither is the root itself.
    const decision = claude.record({ kind: "decision", body: "Charge with a server-side idempotency key per order.", attribution: "user_direction", supportedBy: [imported?.recordId ?? ""] });
    const codex = open(e, "codex");
    const restatedDecision = codex.record({ kind: "note", body: "Charge with a server-side idempotency key per order.", attribution: "agent_inference", links: [{ to: decision.recordId, relation: "derived_from" }] });
    const restatedAsk = codex.record({ kind: "note", body: USER_ASK, attribution: "agent_inference", supportedBy: [imported?.recordId ?? ""] });

    const pack = codex.recall({ query: "idempotency key per order double charges", maxTokens: 8_000 });
    expect(itemsStating(pack, "Charge with a server-side idempotency key per order.")).toEqual([
      expect.objectContaining({ recordId: decision.recordId, kind: "decision", attribution: "user_direction", host: "claude-code", copies: [expect.objectContaining({ recordId: restatedDecision.recordId, host: "codex" })] }),
    ]);
    expect(itemsStating(pack, USER_ASK)).toEqual([
      expect.objectContaining({ recordId: imported?.recordId, attribution: "user_direction", source: expect.objectContaining({ host: "claude-code" }) as unknown, copies: [expect.objectContaining({ recordId: restatedAsk.recordId })] }),
    ]);
  });

  test("copies folded into a returned item are never returned again on later pages", () => {
    const e = env();
    const memory = open(e);
    for (let i = 0; i < 6; i++) {
      const original = memory.record({ kind: "note", body: `rollout step ${i}: ${"detail ".repeat(30)}`, attribution: "agent_inference" });
      memory.record({ kind: "note", body: `rollout step ${i}: ${"detail ".repeat(30)}`, attribution: "agent_inference", links: [{ to: original.recordId, relation: "derived_from" }] });
    }
    const seen: string[] = [];
    let pack = memory.recall({ query: "rollout", maxTokens: 300 });
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(20);
      expect(pack.budget.usedBytes).toBeLessThanOrEqual(pack.budget.maxBytes);
      for (const item of pack.items) seen.push(item.recordId, ...item.copies.map((copy) => copy.recordId));
      if (pack.continuation === null) break;
      pack = memory.recall({ continuation: pack.continuation, maxTokens: 300 });
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });
});
