import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type ContextPack, type Memory, type PackItem } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { codexHome, codexThreadId, installCodexRollout } from "./fixtures.js";

interface Env {
  home: string;
  codex: string;
}

function env(): Env {
  return { home: tempDir(), codex: codexHome() };
}

function open(cwd: string, e: Env): Memory {
  const memory = openMemory({ cwd, home: e.home, host: "codex", codexHome: e.codex });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function addWorktree(repo: string, branch: string): string {
  const path = join(tempDir("memchor-wt-"), "wt");
  git(repo, "worktree", "add", "--quiet", "-b", branch, path);
  return path;
}

function allItems(memory: Memory): PackItem[] {
  const items: PackItem[] = [];
  let pack: ContextPack = memory.recall({ maxTokens: 8_000 });
  for (;;) {
    items.push(...pack.items);
    if (pack.continuation === null) return items;
    pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
  }
}

const USER_ASK = "Checkout double-charges when the payment gateway times out. Find out why before changing anything.";

describe("Codex transcript import through the memory interface", () => {
  test("host codex asks about Codex sessions, imports the approved project with Codex provenance, reports unsupported rollouts as gaps, and replays as a no-op", () => {
    const e = env();
    const repo = initRepo();
    const basic = installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo });
    installCodexRollout(e.codex, "0.148.0-alpha.21/paginated.jsonl", { cwd: repo });
    installCodexRollout(e.codex, "unknown-version.jsonl", { cwd: repo, archived: true });
    installCodexRollout(e.codex, "0.133.0-alpha.1/subagent.jsonl", { cwd: repo });

    const memory = open(repo, e);
    const asked = memory.bootstrap();
    expect(asked.import).toMatchObject({
      host: "codex",
      state: "consent_required",
      transcriptsRoot: e.codex,
      transcripts: { found: 3, currentProject: 3, unsupportedVersion: 2 },
    });
    expect(asked.import.question).toMatch(/found 3 local Codex sessions/);
    expect(asked.import.question).toMatch(/2 written by a Codex version Memchor cannot read yet/);

    const imported = memory.bootstrap({ importChoice: "current_project" }).import;
    expect(imported).toMatchObject({ state: "complete", currentProject: { transcripts: 3, complete: 1, stopped: 2 } });
    expect(imported.gaps.map((g) => [g.reason, g.hostVersion]).sort()).toEqual([
      ["unsupported_version", "0.104.0-alpha.1"],
      ["unsupported_version", "0.148.0-alpha.21+paginated"],
    ]);
    // 4 messages and 4 call results; Codex writes no result for a web search, so a search is bookkeeping only.
    const records = imported.currentProject?.counters.records ?? 0;
    expect(records).toBe(8);

    const ask = allItems(memory).find((item) => item.excerpt === USER_ASK);
    expect(ask).toMatchObject({ host: "codex", attribution: "user_direction", source: { host: "codex", transcriptId: basic.sessionId, branch: "main" } });
    expect(ask?.independentRoot).toMatch(new RegExp(`^event:codex/${basic.sessionId}@\\d+$`));
    const text = JSON.stringify(allItems(memory));
    expect(text).not.toMatch(/SYNTHETIC-(HIDDEN|INJECTED)|SYNTHETICBINARY|SYNTHETIC parent agent prompt/);

    const replay = open(repo, e).bootstrap().import;
    expect(replay.currentProject?.counters.records).toBe(records);
  });

  test("two different Codex threads with identical content at identical offsets stay two independent observations", () => {
    const e = env();
    const repo = initRepo();
    const a = installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo });
    const b = installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo });
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "current_project" });

    const asks = memory.recall({ query: "double charges gateway times out", maxTokens: 8_000 }).items.filter((item) => item.excerpt === USER_ASK);
    expect(asks).toHaveLength(2);
    const roots = asks.map((item) => item.independentRoot).sort();
    expect(roots[0]?.split("@")[1]).toBe(roots[1]?.split("@")[1]); // same byte offset …
    expect(roots).toEqual([`event:codex/${a.sessionId}`, `event:codex/${b.sessionId}`].sort().map((prefix, i) => `${prefix}@${roots[i]?.split("@")[1] ?? ""}`));
    for (const item of asks) expect(item.corroboration).toEqual({ independentRoots: 2, records: 2 });
  });

  test("a fork's copy of its parent is not independent corroboration: it collapses into the parent's observation", () => {
    const e = env();
    const repo = initRepo();
    const parentId = codexThreadId();
    installCodexRollout(e.codex, "0.148.0-alpha.21/fork-parent.jsonl", { cwd: repo, threadId: parentId });
    installCodexRollout(e.codex, "0.148.0-alpha.21/fork.jsonl", { cwd: repo, parentId });
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "current_project" });

    const items = memory.recall({ query: "retry test flaky", maxTokens: 8_000 }).items.filter((item) => item.excerpt === "The retry test is flaky on CI; find out why.");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ corroboration: { independentRoots: 1, records: 2 } });
    expect(items[0]?.independentRoot).toMatch(new RegExp(`^event:codex/${parentId}@\\d+$`));
    expect(items[0]?.copies).toHaveLength(1);
  });

  test("Memchor output in a Codex rollout binds it to the workstream that output names; the output itself is never a record", () => {
    const e = env();
    const repo = initRepo();
    const bound = open(addWorktree(repo, "a"), e);
    const workstreamId = bound.bootstrap({ importChoice: "none" }).scope.workstreamId ?? "";
    const earlier = bound.record({ kind: "decision", body: "Keep one idempotency key per order.", attribution: "user_direction" });

    // A thread in another, not yet bound worktree whose memory_bootstrap output reported that workstream.
    const other = addWorktree(repo, "b");
    installCodexRollout(e.codex, "0.142.5/memchor-echo.jsonl", { cwd: other, workstreamId, recordId: earlier.recordId });
    const boot = bound.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject?.counters).toMatchObject({ echoes: 3, echoReferences: 3, records: 3 });
    // The imported thread adopted the workstream, and with it this worktree.
    expect(open(other, e).bootstrap().scope).toMatchObject({ workstreamId, resolvedBy: "worktree_binding" });
    const excerpts = allItems(open(other, e)).map((item) => item.excerpt);
    expect(excerpts).toContain("Continue the double-charge fix.");
    expect(excerpts.join("\n")).not.toContain("Earlier decision");
  });

  test("a turn that moves the thread into another worktree quarantines the rollout from that line", () => {
    const e = env();
    const repo = initRepo();
    const elsewhere = addWorktree(repo, "elsewhere");
    installCodexRollout(e.codex, "0.142.5/cwd-change.jsonl", { cwd: repo, cwd2: elsewhere });
    const memory = open(repo, e);
    const imported = memory.bootstrap({ importChoice: "current_project" }).import;
    expect(imported.currentProject).toMatchObject({ quarantined: 1, counters: { records: 1 } });
    expect(imported.gaps).toEqual([expect.objectContaining({ reason: "scope_ambiguous", cwd: elsewhere })]);
  });
});
