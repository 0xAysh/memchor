import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeAdapter } from "../../src/import/adapters/claude.js";
import type { NormalizedEvent, TranscriptFile } from "../../src/import/normalized-event.js";
import { claudeConfigDir, installTranscript } from "./fixtures.js";

const CWD = "/work/store";

function fileOf(path: string, transcriptId: string): TranscriptFile {
  const st = statSync(path);
  return { transcriptId, path, size: st.size, mtimeMs: st.mtimeMs };
}

function readAll(fixture: string, maxBytes = 1 << 20) {
  const config = claudeConfigDir();
  const { path, sessionId } = installTranscript(config, fixture, { cwd: CWD });
  const adapter = claudeCodeAdapter({ configDir: config });
  const file = fileOf(path, sessionId);
  return { adapter, file, chunk: adapter.read(file, 0, maxBytes) };
}

/** The content-bearing part of each event, for readable expectations. */
function shape(event: NormalizedEvent): unknown {
  switch (event.type) {
    case "message":
      return [event.role, event.text];
    case "host_summary":
      return ["summary", event.text.slice(0, 60)];
    case "tool_call":
      return ["call", event.tool, event.summary, event.output, event.paths];
    case "tool_result":
      return ["result", event.callId, event.text.slice(0, 40), event.isError];
  }
}

describe("Claude Code adapter", () => {
  test("normalises a 2.1.281 session into visible messages and tool calls, excluding reasoning, binaries, injected context and metadata", () => {
    const { chunk, file } = readAll("2.1.281/basic.jsonl");
    expect(chunk.stop).toBeNull();
    expect(chunk.end).toBe(file.size);
    expect(chunk.events.map(shape)).toEqual([
      ["user", "Checkout double-charges when the payment gateway times out. Find out why before changing anything."],
      ["assistant", "I'll run the gateway tests first, then read the retry logic in the gateway client."],
      ["call", "Bash", "$ npm test -- gateway", "passage", []],
      ["result", "toolu_0001", "FAIL src/gateway.test.ts\n  x retries a 5", true],
      ["call", "Read", `Read ${CWD}/src/gateway.ts (lines 40-87)`, "reference_only", [`${CWD}/src/gateway.ts`]],
      ["result", "toolu_0002", "    40\texport async function charge(orde", false],
      ["call", "mcp__memchor__memory_recall", 'memory_recall {"query":"gateway retries"}', "memchor_echo", []],
      ["result", "toolu_0003", '{"items":[{"recordId":"rec_0123456789abc', false],
      ["call", "Read", `Read ${CWD}/docs/screenshot.png`, "reference_only", [`${CWD}/docs/screenshot.png`]],
      ["result", "toolu_0004", "", false],
      ["user", "Use a server-side idempotency key per order; do not add client retries."],
      ["assistant", "Root cause: charge() retries a 504 up to three times without an idempotency key, so the gateway settles the first attempt and the retry charges again."],
    ]);
    expect(chunk.excluded).toEqual({ host_metadata: 5, injected_context: 3, hidden_reasoning: 1, binary: 1 });
    expect(JSON.stringify(chunk.events)).not.toMatch(/SYNTHETIC-(HIDDEN|INJECTED)|SYNTHETICBINARY/);
  });

  test("every event carries a stable origin: main branch, host uuid, timestamp, cwd, git branch, version and its line's byte range", () => {
    const { chunk } = readAll("2.1.281/basic.jsonl");
    const first = chunk.events[0];
    expect(first).toMatchObject({
      branch: "main",
      eventId: "00000000-0000-4000-8000-000000000001",
      observedAt: "2026-09-20T10:00:00.000Z",
      cwd: CWD,
      gitBranch: "fix/double-charge",
      hostVersion: "2.1.281",
    });
    const ids = chunk.events.map((e) => `${e.branch}/${e.eventId}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of chunk.events) expect(event.lineEnd).toBeGreaterThan(event.lineStart);
  });

  test("the oldest supported version (2.1.183) parses with its smaller key set", () => {
    const { chunk } = readAll("2.1.183/basic.jsonl");
    expect(chunk.stop).toBeNull();
    expect(chunk.events.map(shape)).toEqual([
      ["user", "The nightly export job skips the last page of results."],
      ["call", "Grep", `Grep "pageSize" in ${CWD}/src`, "passage", [`${CWD}/src`]],
      ["result", "toolu_0402", "src/export.ts:88:  const pages = Math.fl", false],
      ["assistant", "The export uses Math.floor for the page count, so a partial last page is dropped; it should be Math.ceil."],
    ]);
  });

  test("a rewind fork keeps both children, and a sidechain gets its own branch", () => {
    const { chunk } = readAll("2.1.281/branches.jsonl");
    expect(chunk.events.map((e) => [e.branch, e.eventId.slice(-3)])).toEqual([
      ["main", "101"],
      ["main", "102"],
      ["main", "103"],
      ["a0000001", "104"],
    ]);
  });

  test("host-written summaries (compaction, away summary) are kept as host summaries; the boundary marker is metadata", () => {
    const { chunk } = readAll("2.1.281/compaction.jsonl");
    expect(chunk.events.map(shape)).toEqual([
      ["user", "Keep going with the outbox migration."],
      ["summary", "This session is being continued from a previous conversation"],
      ["summary", "While you were away: the outbox table migration was written "],
    ]);
    expect(chunk.excluded).toEqual({ host_metadata: 1 });
  });

  test("malformed lines and unknown entry types are counted and skipped; a partial trailing line is left unconsumed", () => {
    const { chunk, file } = readAll("2.1.281/malformed.jsonl");
    expect(chunk.events.map(shape)).toEqual([
      ["user", "First well-formed message before the damage."],
      ["assistant", "Second well-formed message after the damage."],
    ]);
    expect(chunk.excluded).toEqual({ malformed: 2, unsupported_entry: 1 });
    expect(chunk.stop).toBeNull();
    expect(chunk.end).toBeLessThan(file.size);
    expect(chunk.end).toBe((chunk.events.at(-1)?.lineEnd ?? 0));
  });

  test("an entry from a version outside the compatibility table stops the read at that line", () => {
    const { chunk, adapter } = readAll("unknown-version.jsonl");
    expect(chunk.events.map(shape)).toEqual([["user", "Imported before the host upgrade."]]);
    expect(chunk.stop).toEqual({ reason: "unsupported_version", hostVersion: "3.0.0", offset: chunk.events[0]?.lineEnd });
    expect(chunk.end).toBe(chunk.stop?.offset);
    expect(adapter.compatibility).toEqual([expect.objectContaining({ from: "2.1.183", below: "2.2.0" })]);
  });

  test("reading in small slices yields exactly the events of one full read", () => {
    const { adapter, file, chunk: whole } = readAll("2.1.281/basic.jsonl");
    const events: NormalizedEvent[] = [];
    let offset = 0;
    for (let guard = 0; offset < file.size && guard < 100; guard++) {
      const part = adapter.read(file, offset, 1_500);
      events.push(...part.events);
      offset = part.end;
    }
    expect(offset).toBe(file.size);
    expect(events).toEqual(whole.events);
  });

  test("discovery lists only <config>/projects/<project>/<session>.jsonl and inspect reads the head", () => {
    const config = claudeConfigDir();
    const a = installTranscript(config, "2.1.281/basic.jsonl", { cwd: CWD });
    const projects = join(config, "projects");
    writeFileSync(join(projects, ".DS_Store"), "junk");
    mkdirSync(join(projects, "-work-store", a.sessionId, "subagents"), { recursive: true });
    writeFileSync(join(projects, "-work-store", a.sessionId, "subagents", "agent-1.jsonl"), "{}\n");
    mkdirSync(join(projects, "-work-store", "memory"), { recursive: true });
    writeFileSync(join(projects, "-work-store", "memory", "notes.jsonl"), "{}\n");
    writeFileSync(join(projects, "-work-store", "notes.txt"), "not a transcript");

    const adapter = claudeCodeAdapter({ configDir: config });
    expect(adapter.root).toBe(projects);
    const found = adapter.discover();
    expect(found.map((f) => [f.transcriptId, f.path])).toEqual([[a.sessionId, a.path]]);
    expect(adapter.inspect(found[0] as TranscriptFile)).toEqual({ cwd: CWD, hostVersion: "2.1.281", supported: true });
    expect(claudeCodeAdapter({ configDir: join(config, "missing") }).discover()).toEqual([]);
  });
});
