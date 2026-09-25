import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "./fixtures.js";

const CLAIM = "Redis is required for the job queue; every retry must go through it.";

function setup(): { repo: string; home: string; config: string; memory: Memory; claim: string; summary: string } {
  const repo = initRepo({ branch: "feat/queue" });
  const home = tempDir();
  const config = claudeConfigDir();
  installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo });
  const memory = open(repo, home, config);
  const boot = memory.bootstrap({ importChoice: "current_project" });
  expect(boot.import.state).toBe("complete");
  const claim = memory.recall({ query: "redis required" }).items.find((item) => item.excerpt === CLAIM);
  const summary = memory.recall({ query: "continued previous conversation summary" }).items.find((item) => item.kind === "note");
  if (claim === undefined || summary === undefined) throw new Error("fixture did not import the claim and the summary");
  return { repo, home, config, memory, claim: claim.recordId, summary: summary.recordId };
}

function open(repo: string, home: string, config: string): Memory {
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function claimVisible(memory: Memory): boolean {
  return memory.recall({ query: "redis required retry", maxTokens: 8_000 }).items.some((item) => item.excerpt.includes("Redis is required"));
}

describe("corrections survive transcript reconciliation", () => {
  test("a host summary written after the corrected event in the same transcript is quarantined", () => {
    const { memory, claim, summary } = setup();
    const result = memory.manage({ action: "correct", recordId: claim, body: "Redis is one option for the queue.", reason: "User clarified.", attribution: "user_direction" });
    if (result.action !== "correct") throw new Error("unreachable");
    expect(result.affected.quarantined).toEqual([summary]);
    expect(result.affected.suppressedEvents).toBe(1);
  });

  test("a summary the host writes after the correction is imported quarantined, not as current guidance", () => {
    const repo = initRepo({ branch: "feat/queue" });
    const home = tempDir();
    const config = claudeConfigDir();
    const full = renderFixture("2.1.281/redis-claim.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-000000000001" });
    const lines = full.split(/(?<=\n)/);
    const transcript = installTranscript(config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-000000000001", content: lines.slice(0, 2).join("") });
    const memory = open(repo, home, config);
    memory.bootstrap({ importChoice: "current_project" });
    const claim = memory.recall({ query: "redis required" }).items.find((item) => item.excerpt === CLAIM);
    if (claim === undefined) throw new Error("claim not imported");
    memory.manage({ action: "correct", recordId: claim.recordId, body: "Redis is one option.", reason: "r", attribution: "user_direction" });

    appendFileSync(transcript.path, lines.slice(2).join(""));
    memory.bootstrap();
    expect(memory.recall({ query: "continued previous conversation summary" }).items.filter((item) => item.kind === "note")).toEqual([]);
    const dbPath = memory.status().storage.dbPath ?? "";
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT t.taint, t.cause_id FROM taints t JOIN records r ON r.id = t.record_id WHERE r.kind = 'note'").all()).toEqual([{ taint: "quarantined", cause_id: claim.recordId }]);
    } finally {
      db.close();
    }
  });

  test("a cursor reset replays the transcript without resurrecting the corrected claim", () => {
    const { repo, home, config, memory, claim } = setup();
    memory.manage({ action: "correct", recordId: claim, body: "Redis is one option for the queue.", reason: "r", attribution: "user_direction" });
    const dbPath = memory.status().storage.dbPath ?? "";
    memory.close();
    const db = new Database(dbPath);
    db.exec("DELETE FROM import_cursors");
    db.close();

    const again = open(repo, home, config);
    again.bootstrap();
    expect(claimVisible(again)).toBe(false);
  });

  test("a /branch copy and an edited version of the retracted event are suppressed, and counted", () => {
    const { repo, config, memory, claim } = setup();
    memory.manage({ action: "retract", recordId: claim, reason: "Never said.", attribution: "user_direction" });

    // Claude Code's /branch re-stores the same entries (same uuids) under a new session id.
    const original = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo });
    // An outside edit of the claim's line in the original transcript is a new version of the same event.
    writeFileSync(original.path, readFileSync(original.path, "utf8").replace(CLAIM, "Redis is required for the job queue, full stop, for every retry path."));
    const boot = memory.bootstrap();
    expect(boot.import.currentProject?.counters.suppressed).toBeGreaterThanOrEqual(1);
    expect(claimVisible(memory)).toBe(false);
  });

  test("restoring a retraction lets later copies of the event import again", () => {
    const { repo, config, memory, claim } = setup();
    memory.manage({ action: "retract", recordId: claim, reason: "r", attribution: "user_direction" });
    memory.manage({ action: "restore", recordId: claim, reason: "It was right.", attribution: "user_direction" });
    installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo });
    memory.bootstrap();
    const item = memory.recall({ query: "redis required retry" }).items.find((i) => i.excerpt === CLAIM);
    // The copy shares the original's root, so it is folded into one item, not a second observation.
    expect(item?.corroboration.independentRoots).toBe(1);
    expect(item?.copies.length).toBe(1);
  });
});
