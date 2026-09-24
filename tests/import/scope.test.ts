import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "./fixtures.js";

interface Env {
  home: string;
  config: string;
}

function open(cwd: string, e: Env): Memory {
  const memory = openMemory({ cwd, home: e.home, host: "claude-code", claudeConfigDir: e.config });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function addWorktree(repo: string, branch: string, create = false): string {
  const path = join(tempDir("memchor-wt-"), "wt");
  git(repo, "worktree", "add", "--quiet", ...(create ? ["-b", branch, path] : [path, branch]));
  return path;
}

/** Every excerpt and title an agent can see from this session, joined for content assertions. */
function visibleText(memory: Memory): string {
  const parts: string[] = [];
  let pack = memory.recall({ maxTokens: 8_000 });
  for (;;) {
    for (const item of pack.items) parts.push(item.title ?? "", item.excerpt);
    if (pack.continuation === null) break;
    pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
  }
  return parts.join("\n");
}

/** basic.jsonl, whose Memchor recall output reports `first` as the bound workstream, plus a second Memchor call reporting `second`. */
function transcriptNaming(cwd: string, sessionId: string, first: string, second: string): string {
  const lines = renderFixture("2.1.281/basic.jsonl", { cwd, sessionId })
    .replace('{\\"items\\":[', `{\\"scope\\":{\\"workstreamId\\":\\"${first}\\"},\\"items\\":[`)
    .split("\n");
  const call = (lines[9] ?? "").replaceAll("toolu_0003", "toolu_0099").replaceAll("000000000009", "000000000099");
  const result = (lines[10] ?? "")
    .replaceAll("toolu_0003", "toolu_0099")
    .replaceAll("000000000010", "000000000098")
    .replaceAll("000000000009", "000000000099")
    .replace(first, second);
  lines.splice(11, 0, call, result);
  return lines.join("\n");
}

describe("imported history scope", () => {
  test("a transcript whose Memchor output names two different workstreams is held: nothing enters any workstream or the workspace level", () => {
    const e = { home: tempDir(), config: claudeConfigDir() };
    const repo = initRepo();
    const a = open(addWorktree(repo, "a", true), e);
    const b = open(addWorktree(repo, "b", true), e);
    const x = a.bootstrap({ importChoice: "none" }).scope.workstreamId ?? "";
    const y = b.bootstrap().scope.workstreamId ?? "";
    const sessionId = "77777777-7777-4777-8777-777777777777";
    installTranscript(e.config, "", { cwd: repo, sessionId, content: transcriptNaming(repo, sessionId, x, y) });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.gaps).toEqual([expect.objectContaining({ transcriptId: sessionId, reason: "scope_ambiguous", cwd: repo })]);
    expect(boot.import.currentProject).toMatchObject({ transcripts: 1, quarantined: 1, pending: 0, counters: { records: 0 } });
    expect(boot.import.state).toBe("complete");
    for (const session of [memory, a, b]) expect(visibleText(session)).not.toMatch(/double-charges/);
    expect(memory.status().counts?.records).toBe(0);
    // Still held on the next bootstrap: conflicting session metadata never resolves by itself.
    expect(open(repo, e).bootstrap().import.currentProject).toMatchObject({ quarantined: 1, counters: { records: 0 } });
  });

  test("history of an ambiguous worktree waits for the user's choice, then imports into the chosen workstream", () => {
    const e = { home: tempDir(), config: claudeConfigDir() };
    const repo = initRepo();
    const first = addWorktree(repo, "fix/double-charge", true);
    const orphan = open(first, e).bootstrap({ importChoice: "none" }).scope.workstreamId ?? "";
    git(repo, "worktree", "remove", "--force", first);
    const second = addWorktree(repo, "fix/double-charge");
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: second });

    const live = open(second, e);
    const asked = live.bootstrap({ importChoice: "current_project" });
    expect(asked.scope.ambiguity?.candidates.map((c) => c.workstreamId)).toEqual([orphan]);
    expect(asked.import.gaps).toEqual([expect.objectContaining({ reason: "scope_ambiguous", cwd: second })]);
    expect(asked.import.currentProject).toMatchObject({ quarantined: 1, counters: { records: 0 } });
    expect(live.continueImport({ maxMs: 1_000 })).toMatchObject({ done: true, currentProject: { quarantined: 1 } });
    expect(visibleText(live)).not.toMatch(/double-charges/);

    const chosen = live.bootstrap({ workstream: orphan });
    expect(chosen.scope.workstreamId).toBe(orphan);
    expect(chosen.import.gaps).toEqual([]);
    expect(chosen.import.currentProject).toMatchObject({ complete: 1, quarantined: 0, counters: { records: 7 } });
    expect(visibleText(live)).toMatch(/double-charges/);
  });

  test("a live host session that already chose a workstream carries its transcript there", () => {
    const e = { home: tempDir(), config: claudeConfigDir() };
    const repo = initRepo();
    const other = addWorktree(repo, "other", true);
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const elsewhere = openMemory({ cwd: other, home: e.home, host: "claude-code", claudeConfigDir: e.config, hostSessionId: sessionId });
    onCleanup(() => {
      elsewhere.close();
    });
    const target = elsewhere.bootstrap({ importChoice: "none" }).scope.workstreamId;
    // The transcript's events happened in the main worktree, which is bound to another workstream.
    const main = open(repo, e);
    const mainWorkstream = main.bootstrap().scope.workstreamId;
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo, sessionId });

    const boot = main.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject).toMatchObject({ complete: 1, counters: { records: 7 } });
    expect(target).not.toBe(mainWorkstream);
    expect(visibleText(main)).not.toMatch(/double-charges/);
    expect(visibleText(elsewhere)).toMatch(/double-charges/);
  });
});
