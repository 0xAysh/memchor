import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repository with `src/gateway.ts` committed. */
function repoWithGateway(): string {
  const repo = initRepo();
  writeFile(repo, "src/gateway.ts", "export function charge() {\n  return retry(3);\n}\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "gateway");
  return repo;
}

function recallItem(memory: Memory, recordId: string): PackItem {
  const item = memory.recall({ maxTokens: 8_000 }).items.find((i) => i.recordId === recordId);
  if (item === undefined) throw new Error(`record ${recordId} not in the pack`);
  return item;
}

function recordGatewayObservation(memory: Memory): string {
  return memory.record({
    kind: "evidence",
    body: "charge() retries three times without an idempotency key",
    attribution: "direct_observation",
    externalRefs: [{ kind: "code", locator: "src/gateway.ts", path: "src/gateway.ts" }],
  }).recordId;
}

describe("local code freshness", () => {
  test("an unchanged referenced file is current", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const recordId = recordGatewayObservation(open(repo, home));

    const item = recallItem(open(repo, home, "codex"), recordId);
    expect(item.freshness).toBe("current");
    expect(item.warning).toBeNull();
    expect(item.externalRefs).toEqual([{ kind: "code", locator: "src/gateway.ts", path: "src/gateway.ts", commit: git(repo, "rev-parse", "HEAD"), observedAt: item.externalRefs[0]?.observedAt, freshness: "current", reason: "unchanged" }]);
    expect(Date.parse(item.externalRefs[0]?.observedAt ?? "")).not.toBeNaN();
  });

  test("an edited file makes the memory stale and tells the agent to read the live file", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const recordId = recordGatewayObservation(open(repo, home));
    writeFile(repo, "src/gateway.ts", "export function charge(key) {\n  return once(key);\n}\n");

    const item = recallItem(open(repo, home, "codex"), recordId);
    expect(item.freshness).toBe("stale");
    expect(item.externalRefs[0]).toMatchObject({ freshness: "stale", reason: "changed" });
    expect(item.warning).toMatch(/read the current file/i);
    // Memory is knowledge about the file, never its content.
    expect(JSON.stringify(item)).not.toContain("retry(3)");
  });

  test("a committed change is stale too, and a change reverted to the observed bytes is current again", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const memory = open(repo, home);
    const recordId = recordGatewayObservation(memory);
    const original = "export function charge() {\n  return retry(3);\n}\n";

    writeFile(repo, "src/gateway.ts", "export const charge = () => once();\n");
    git(repo, "commit", "--quiet", "-am", "rewrite");
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "stale", reason: "changed" });

    writeFile(repo, "src/gateway.ts", original);
    git(repo, "commit", "--quiet", "-am", "revert");
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "current", reason: "unchanged" });
  });

  test("a deleted file is stale", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const recordId = recordGatewayObservation(open(repo, home));
    git(repo, "rm", "--quiet", "src/gateway.ts");

    const item = recallItem(open(repo, home), recordId);
    expect(item.freshness).toBe("stale");
    expect(item.externalRefs[0]).toMatchObject({ freshness: "stale", reason: "missing" });
  });

  test("uncommitted state is part of the observation: a dirty file edited again is stale, restored is current", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const memory = open(repo, home);
    writeFile(repo, "src/gateway.ts", "export function charge() {\n  return retry(3, { key });\n}\n");
    const recordId = recordGatewayObservation(memory);
    expect(recallItem(memory, recordId).freshness).toBe("current");

    // Same commit, still dirty, different bytes: the commit alone must not vouch for it.
    writeFile(repo, "src/gateway.ts", "export function charge() {\n  return retry(3, { key, jitter });\n}\n");
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "stale", reason: "changed" });

    writeFile(repo, "src/gateway.ts", "export function charge() {\n  return retry(3, { key });\n}\n");
    expect(recallItem(memory, recordId).freshness).toBe("current");
  });

  test("a file observed clean becomes stale once it has uncommitted edits", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const memory = open(repo, home);
    const recordId = recordGatewayObservation(memory);
    writeFile(repo, "src/gateway.ts", "// wip\n");
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "stale", reason: "changed" });
  });

  test("references into another repository are never read and stay unknown", () => {
    const repo = repoWithGateway();
    const other = repoWithGateway();
    const memory = open(repo, tempDir());
    const { recordId } = memory.record({
      kind: "note",
      body: "the other service has the same retry bug",
      attribution: "agent_inference",
      externalRefs: [
        { kind: "code", locator: join(other, "src/gateway.ts") },
        { kind: "code", locator: "../../../../../../etc/hosts" },
      ],
    });
    const item = recallItem(memory, recordId);
    expect(item.freshness).toBe("unknown");
    expect(item.externalRefs.map((ref) => ref.reason)).toEqual(["outside_worktree", "outside_worktree"]);
    expect(item.warning).toMatch(/read the current file/i);
  });

  test("a caller-pinned commit this repository does not have is unknown", () => {
    const repo = repoWithGateway();
    const memory = open(repo, tempDir());
    const unknown = memory.record({
      kind: "note",
      body: "gateway as of a commit from a fork",
      attribution: "agent_inference",
      externalRefs: [{ kind: "code", locator: "src/gateway.ts", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }],
    });
    const known = memory.record({
      kind: "note",
      body: "gateway as of HEAD, pinned by the caller",
      attribution: "agent_inference",
      externalRefs: [{ kind: "code", locator: "src/gateway.ts", commit: git(repo, "rev-parse", "HEAD") }],
    });
    expect(recallItem(memory, unknown.recordId).externalRefs[0]).toMatchObject({ freshness: "unknown", reason: "unknown_commit" });
    // Pinned by the caller, so Memchor did not fingerprint it: honest unknown, not current.
    expect(recallItem(memory, known.recordId).externalRefs[0]).toMatchObject({ freshness: "unknown", reason: "not_observed" });
  });

  test("files over the hash cap are unknown once their Git state changes, never read in full", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    const memory = open(repo, home);
    writeFile(repo, "data/big.json", "x".repeat(1024 * 1024 + 1));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "big");
    const { recordId } = memory.record({
      kind: "note",
      body: "big.json holds the fixture catalogue",
      attribution: "direct_observation",
      externalRefs: [{ kind: "code", locator: "data/big.json" }],
    });
    // Clean at the observed commit: Git vouches for the bytes without reading them.
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "current", reason: "unchanged" });

    writeFile(repo, "data/big.json", "y".repeat(1024 * 1024 + 1));
    expect(recallItem(memory, recordId).externalRefs[0]).toMatchObject({ freshness: "unknown", reason: "too_large" });
  });

  test("issue, PR, URL and document references are historical until the agent verifies them", () => {
    const memory = open(repoWithGateway(), tempDir());
    const { recordId } = memory.record({
      kind: "reference",
      body: "the double-charge bug is tracked upstream",
      attribution: "direct_observation",
      externalRefs: [
        { kind: "issue", locator: "#412" },
        { kind: "pr", locator: "#415" },
        { kind: "url", locator: "https://status.example.invalid" },
        { kind: "document", locator: "docs/runbook.md" },
      ],
    });
    const item = recallItem(memory, recordId);
    expect(item.freshness).toBe("unknown");
    expect(item.externalRefs.map((ref) => [ref.freshness, ref.reason])).toEqual(Array(4).fill(["unknown", "remote_unverified"]));
    expect(item.warning).toMatch(/verify .* with your own tools/i);
    expect(item.warning).not.toMatch(/read the current file/i);
  });

  test("a reference to something that is not a regular file is unknown and never blocks recall", () => {
    const repo = repoWithGateway();
    const memory = open(repo, tempDir());
    execFileSync("mkfifo", [join(repo, "src/events.pipe")]);
    const { recordId } = memory.record({
      kind: "note",
      body: "the worker reads events from a named pipe",
      attribution: "direct_observation",
      externalRefs: [{ kind: "code", locator: "src/events.pipe" }, { kind: "code", locator: "src" }],
    });
    expect(recallItem(memory, recordId).externalRefs.map((ref) => ref.freshness)).toEqual(["unknown", "unknown"]);
  });

  test("files a transcript read or edited were never fingerprinted, so they are unknown and must be read live", () => {
    const repo = repoWithGateway();
    const config = claudeConfigDir();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = openMemory({ cwd: repo, host: "claude-code", home: tempDir(), claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });

    const read = memory.recall({ query: "gateway.ts", maxTokens: 8_000 }).items.find((item) => item.title?.startsWith("Read"));
    expect(read).toMatchObject({ freshness: "unknown", externalRefs: [{ kind: "code", path: "src/gateway.ts", freshness: "unknown", reason: "transcript_reference" }] });
    expect(read?.warning).toMatch(/read the current file/i);
    // Import never hashed the file: that would certify today's bytes, not what the transcript saw.
    expect(read?.externalRefs[0]).not.toHaveProperty("commit");
    expect(read?.externalRefs[0]).not.toHaveProperty("observedAt");
  });

  test("read reports the same live freshness as recall", () => {
    const repo = repoWithGateway();
    const memory = open(repo, tempDir());
    const recordId = recordGatewayObservation(memory);
    expect(memory.read({ recordId })).toMatchObject({ freshness: "current", warning: null, externalRefs: [{ freshness: "current", reason: "unchanged" }] });
    writeFile(repo, "src/gateway.ts", "changed\n");
    expect(memory.read({ recordId })).toMatchObject({ freshness: "stale", externalRefs: [{ freshness: "stale", reason: "changed" }] });
  });

  test("checkpoint references are observed and checked like records", () => {
    const repo = repoWithGateway();
    const home = tempDir();
    open(repo, home).checkpoint({
      expectedRevision: 0,
      goal: "stop double charges",
      status: "idempotency key drafted",
      externalRefs: [{ kind: "code", locator: "src/gateway.ts" }],
    });
    expect(open(repo, home, "codex").recall().checkpoint).toMatchObject({ freshness: "current", warning: null });
    writeFile(repo, "src/gateway.ts", "changed\n");
    expect(open(repo, home, "codex").recall().checkpoint).toMatchObject({ freshness: "stale", externalRefs: [{ reason: "changed" }] });
  });

  test("only records selected into the pack are validated, within a fixed reference budget", () => {
    const repo = repoWithGateway();
    const memory = open(repo, tempDir());
    for (let i = 0; i < 40; i++) {
      memory.record({
        kind: "note",
        body: `module ${i} notes`,
        attribution: "agent_inference",
        externalRefs: Array.from({ length: 10 }, (_, j) => ({ kind: "code" as const, locator: `src/m${i}/f${j}.ts` })),
      });
    }
    // A small pack validates only what it returns, so every returned reference is checked.
    const small = memory.recall({ maxBytes: 4_000 });
    expect(small.items.length).toBeGreaterThan(0);
    expect(small.items.length).toBeLessThan(7);
    expect(small.items.flatMap((item) => item.externalRefs.map((ref) => ref.reason)).every((reason) => reason === "not_observed")).toBe(true);
    const large = memory.recall({ maxTokens: 8_000 });
    const reasons = large.items.flatMap((item) => item.externalRefs.map((ref) => ref.reason));
    expect(reasons.length).toBeGreaterThan(64);
    // Beyond the per-recall budget, references are reported as unchecked rather than scanned.
    expect(reasons.filter((reason) => reason !== "check_limit")).toHaveLength(64);
    expect(reasons.slice(64).every((reason) => reason === "check_limit")).toBe(true);
  });
});
