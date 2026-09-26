import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";

function open(cwd: string, home: string, options: { host?: string; claudeConfigDir?: string } = {}): Memory {
  const memory = openMemory({ cwd, host: options.host ?? "claude-code", home, ...(options.claudeConfigDir === undefined ? {} : { claudeConfigDir: options.claudeConfigDir }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function item(memory: Memory, recordId: string): PackItem {
  const found = memory.recall({ maxTokens: 8_000 }).items.find((i) => i.recordId === recordId);
  if (found === undefined) throw new Error(`record ${recordId} not in the pack`);
  return found;
}

describe("document references", () => {
  test("a document in the worktree is fingerprinted like code: current until it changes", () => {
    const repo = initRepo();
    writeFile(repo, "docs/design.md", "# Queue design\nRetries go through the outbox.\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "design");
    const memory = open(repo, tempDir());
    const { recordId } = memory.record({
      kind: "decision",
      body: "Follow the outbox design.",
      attribution: "user_direction",
      externalRefs: [{ kind: "document", locator: "docs/design.md" }],
    });
    expect(item(memory, recordId)).toMatchObject({ freshness: "current", warning: null, externalRefs: [{ kind: "document", freshness: "current", reason: "unchanged" }] });

    writeFile(repo, "docs/design.md", "# Queue design\nRetries go through Redis.\n");
    const stale = item(memory, recordId);
    expect(stale).toMatchObject({ freshness: "stale", externalRefs: [{ freshness: "stale", reason: "changed" }] });
    expect(stale.warning).toMatch(/read the current file/i);
  });

  test("a document outside the worktree, or behind a URL, is never read", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir());
    const { recordId } = memory.record({
      kind: "reference",
      body: "Specs live elsewhere.",
      attribution: "direct_observation",
      externalRefs: [
        { kind: "document", locator: "../elsewhere/spec.md" },
        { kind: "document", locator: "https://docs.example.invalid/spec" },
      ],
    });
    expect(item(memory, recordId).externalRefs.map((ref) => [ref.freshness, ref.reason])).toEqual([
      ["unknown", "outside_worktree"],
      ["unknown", "remote_unverified"],
    ]);
  });
});

describe("test results", () => {
  test("an agent's own report of a test run is an assertion: never current, and the agent is told to rerun", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir());
    const { recordId } = memory.record({
      kind: "evidence",
      body: "All tests passed.",
      attribution: "direct_observation",
      testRun: { command: "npm test", outcome: "passed", exitCode: 0 },
    });
    const asserted = item(memory, recordId);
    expect(asserted.testRun).toMatchObject({ command: "npm test", outcome: "passed", exitCode: 0, evidence: "asserted", applies: "current", reason: "same_state" });
    expect(asserted.freshness).toBe("unknown");
    expect(asserted.warning).toMatch(/asserted.*rerun/i);
  });

  test("a test run citing the captured tool output applies only to the commit and working tree it ran against", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    writeFile(repo, "src/gateway.ts", "export const retries = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "gateway");
    const home = tempDir();
    const config = claudeConfigDir();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, home, { claudeConfigDir: config });
    memory.bootstrap({ importChoice: "current_project" });
    const output = memory.recall({ query: "retries 504 idempotency key charged twice" }).items.find((i) => i.attribution === "direct_observation" && i.source !== null);
    if (output === undefined) throw new Error("the fixture's test output was not imported");

    const { recordId } = memory.record({
      kind: "evidence",
      body: "The gateway suite fails: one test charges twice.",
      attribution: "direct_observation",
      supportedBy: [output.recordId],
      testRun: { command: "npm test -- gateway", outcome: "failed", exitCode: 1 },
    });
    expect(item(memory, recordId)).toMatchObject({ freshness: "current", warning: null, testRun: { evidence: "captured", applies: "current", reason: "same_state" } });

    // Captured output of another command, or with the other outcome, is not this run.
    for (const run of [{ command: "npm run lint", outcome: "failed" }, { command: "npm test -- gateway", outcome: "passed" }] as const) {
      const other = memory.record({ kind: "evidence", body: `claims ${run.command}`, attribution: "direct_observation", supportedBy: [output.recordId], testRun: run }).recordId;
      expect(item(memory, other).testRun).toMatchObject({ evidence: "asserted" });
    }

    writeFile(repo, "src/gateway.ts", "export const retries = 1;\n");
    const edited = item(memory, recordId);
    expect(edited).toMatchObject({ freshness: "stale", testRun: { applies: "stale", reason: "other_state" } });
    expect(edited.warning).toMatch(/rerun/i);

    writeFile(repo, "src/gateway.ts", "export const retries = 3;\n");
    expect(item(memory, recordId).testRun).toMatchObject({ applies: "current" });

    writeFile(repo, "NOTES.md", "new file\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "notes");
    expect(item(memory, recordId).testRun).toMatchObject({ applies: "stale", reason: "other_state" });
  });

  test("a record without a test run carries none, and read and inspect show the same test labels as recall", () => {
    const repo = initRepo();
    const memory = open(repo, tempDir());
    const plain = memory.record({ kind: "note", body: "no tests here", attribution: "agent_inference" }).recordId;
    expect(item(memory, plain).testRun).toBeNull();
    const { recordId } = memory.record({ kind: "evidence", body: "lint clean", attribution: "direct_observation", testRun: { command: "npm run lint", outcome: "passed" } });
    expect(memory.read({ recordId }).testRun).toMatchObject({ evidence: "asserted", applies: "current" });
    expect(memory.manage({ action: "inspect", recordId })).toMatchObject({ record: { testRun: { evidence: "asserted" } } });
  });
});
