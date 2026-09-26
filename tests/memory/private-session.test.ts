import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ManageResult, type Memory, openMemory } from "../../src/memory.js";
import { catchMemchorError, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, codexHome, codexThreadId, installCodexRollout, installTranscript, renderFixture } from "../import/fixtures.js";

interface Env {
  home: string;
  config: string;
  codex: string;
}

function env(): Env {
  return { home: tempDir(), config: claudeConfigDir(), codex: codexHome() };
}

function open(repo: string, e: Env, options: { host?: string; hostSessionId?: string } = {}): Memory {
  const memory = openMemory({
    cwd: repo,
    home: e.home,
    host: options.host ?? "claude-code",
    claudeConfigDir: e.config,
    codexHome: e.codex,
    ...(options.hostSessionId === undefined ? {} : { hostSessionId: options.hostSessionId }),
  });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function markPrivate(memory: Memory): Extract<ManageResult, { action: "private_session" }> {
  const result = memory.manage({ action: "private_session" });
  if (result.action !== "private_session") throw new Error("unreachable");
  return result;
}

describe("don't remember this session", () => {
  test("marking forgets what the session wrote, refuses its later writes, and a second mark changes nothing", () => {
    const repo = initRepo();
    const e = env();
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "none" });
    const written = memory.record({ kind: "note", body: "Private musing about the queue.", attribution: "agent_inference" }).recordId;

    const first = markPrivate(memory);
    expect(first).toMatchObject({ v: 1, alreadyPrivate: false, forgotten: [written] });
    expect(first.notice).toMatch(/not be remembered/i);

    for (const write of [
      () => memory.record({ kind: "note", body: "x", attribution: "agent_inference" }),
      () => memory.record({ kind: "preference", body: "Use bun.", attribution: "user_direction" }),
      () => memory.checkpoint({ expectedRevision: 0, goal: "g", status: "s" }),
      () => memory.manage({ action: "retract", recordId: written, reason: "r", attribution: "user_direction" }),
    ]) {
      expect(catchMemchorError(write).code).toBe("session_private");
    }
    // Reads still work.
    expect(memory.recall().items).toEqual([]);
    expect(markPrivate(memory)).toMatchObject({ alreadyPrivate: true, forgotten: [] });

    const other = open(repo, e, { host: "codex" });
    expect(other.manage({ action: "inspect", recordId: written })).toMatchObject({ record: { lifecycle: "forgotten", body: "" } });
    expect(other.record({ kind: "note", body: "other sessions still write", attribution: "agent_inference" }).recordId).toMatch(/^rec_/);
  });

  test("a private Codex thread's rollout is never imported, and a resumed thread stays private", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const live = open(repo, e, { host: "codex", hostSessionId: threadId });
    live.bootstrap({ importChoice: "all" });
    markPrivate(live);
    installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo, threadId });

    const later = open(repo, e, { host: "codex" });
    later.bootstrap();
    expect(later.status().counts?.records).toBe(0);
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    expect(catchMemchorError(() => resumed.record({ kind: "note", body: "x", attribution: "agent_inference" })).code).toBe("session_private");
  });

  test("a Claude transcript whose Memchor output names a private session is never imported, not even what came before it", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    markPrivate(live);
    // basic.jsonl contains a memory_recall result; make it the private session's output, as it would be.
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000cc" }).replace('{\\"items\\":', `{\\"scope\\":{\\"headRevision\\":0,\\"sessionId\\":\\"${sessionId}\\"},\\"items\\":`);
    expect(content).toContain(sessionId);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000cc", content });

    const later = open(repo, e, { host: "claude-code" });
    later.bootstrap();
    expect(later.recall({ query: "checkout double charges gateway" }).items).toEqual([]);
  });

  test("a transcript that merely recalled records a private session wrote is not that session's transcript", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    markPrivate(live);
    // A recalled item names its writer's session, but not as the scope's session.
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000ee" }).replace('{\\"items\\":[{', `{\\"items\\":[{\\"host\\":\\"claude-code\\",\\"sessionId\\":\\"${sessionId}\\",`);
    expect(content).toContain(sessionId);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000ee", content });
    const later = open(repo, e, { host: "claude-code" });
    later.bootstrap();
    expect(later.recall({ query: "checkout double charges gateway" }).items.length).toBeGreaterThan(0);
  });

  test("marking forgets what was already imported from the session's own transcript", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000dd" }).replace('{\\"items\\":', `{\\"scope\\":{\\"headRevision\\":0,\\"sessionId\\":\\"${sessionId}\\"},\\"items\\":`);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000dd", content });
    live.bootstrap();
    expect(live.recall({ query: "checkout double charges gateway" }).items.length).toBeGreaterThan(0);

    const marked = markPrivate(live);
    expect(marked.forgotten.length).toBeGreaterThan(0);
    expect(open(repo, e, { host: "codex" }).recall({ query: "checkout double charges gateway" }).items).toEqual([]);
  });

  test("restoring an older database copy keeps the session private", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const live = open(repo, e, { host: "codex", hostSessionId: threadId });
    live.bootstrap({ importChoice: "all" });
    const dbPath = live.status().storage.dbPath ?? "";
    const backup = join(tempDir(), "backup.sqlite");
    live.close();
    copyFileSync(dbPath, backup);
    const again = open(repo, e, { host: "codex", hostSessionId: threadId });
    markPrivate(again);
    again.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    copyFileSync(backup, dbPath);

    installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo, threadId });
    const later = open(repo, e, { host: "codex" });
    later.bootstrap();
    expect(later.status().counts?.records).toBe(0);
  });
});
