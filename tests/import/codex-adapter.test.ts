import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexAdapter } from "../../src/import/adapters/codex.js";
import type { NormalizedEvent, TranscriptFile } from "../../src/import/normalized-event.js";
import { codexHome, codexThreadId, installCodexRollout, type CodexVars } from "./fixtures.js";

const CWD = "/work/store";

function fileOf(path: string, transcriptId: string): TranscriptFile {
  const st = statSync(path);
  return { transcriptId, path, size: st.size, mtimeMs: st.mtimeMs };
}

function readAll(fixture: string, vars: Partial<CodexVars> = {}, maxBytes = 1 << 20) {
  const home = codexHome();
  const { path, sessionId } = installCodexRollout(home, fixture, { cwd: CWD, ...vars });
  const adapter = codexAdapter({ codexHome: home });
  const file = fileOf(path, sessionId);
  return { adapter, file, home, chunk: adapter.read(file, 0, maxBytes) };
}

/** The content-bearing part of each event, for readable expectations. */
function shape(event: NormalizedEvent): unknown {
  switch (event.type) {
    case "message":
      return [event.role, event.text];
    case "host_summary":
      return ["summary", event.text.slice(0, 60)];
    case "tool_call":
      return ["call", event.tool, event.summary, event.toolKind, event.paths, event.urls];
    case "tool_result":
      return ["result", event.callId, event.text.slice(0, 40), event.isError];
  }
}

describe("Codex adapter", () => {
  test("normalises a 0.142.5 rollout into visible messages and tool calls, excluding reasoning, binaries, injected context, duplicates and metadata", () => {
    const { chunk, file } = readAll("0.142.5/basic.jsonl");
    expect(chunk.stop).toBeNull();
    expect(chunk.end).toBe(file.size);
    expect(chunk.events.map(shape)).toEqual([
      ["user", "Checkout double-charges when the payment gateway times out. Find out why before changing anything."],
      ["assistant", "I'll run the gateway tests first, then read the retry logic in the gateway client."],
      ["call", "exec_command", "$ npm test -- gateway", "other", [], []],
      ["result", "call_0001", "FAIL src/gateway.test.ts\n  x retries a 5", true],
      ["call", "exec_command", "$ sed -n 40,87p src/gateway.ts", "artifact_access", [`${CWD}/src/gateway.ts`], []],
      ["result", "call_0002", "export async function charge(order) {\n  ", false],
      ["call", "apply_patch", "apply_patch src/gateway.ts, docs/idempotency.md", "artifact_access", [`${CWD}/src/gateway.ts`, `${CWD}/docs/idempotency.md`], []],
      ["result", "call_0003", "Success. Updated the following files:\nM ", false],
      ["call", "view_image", `view_image ${CWD}/docs/screenshot.png`, "artifact_access", [`${CWD}/docs/screenshot.png`], []],
      ["result", "call_0004", "", false],
      ["call", "web_search", 'web_search "gateway idempotency key"', "other", [], []],
      ["call", "web_search", "web_search open https://docs.example.invalid/payments/idempotency?session=abc", "other", [], ["https://docs.example.invalid/payments/idempotency?session=abc"]],
      ["user", "Use a server-side idempotency key per order; do not add client retries."],
      ["assistant", "Root cause: charge() retries a 504 up to three times without an idempotency key, so the gateway settles the first attempt and the retry charges again."],
    ]);
    // 1 session_meta, 4 task_started/complete, 2 turn_context, 2 user + 2 assistant response_item copies, 1 patch_apply_end, 1 web_search_end, 2 token_count
    expect(chunk.excluded).toEqual({ host_metadata: 15, injected_context: 2, hidden_reasoning: 1, binary: 1 });
    expect(JSON.stringify(chunk.events)).not.toMatch(/SYNTHETIC-(HIDDEN|INJECTED)|SYNTHETICBINARY/);
  });

  test("every event carries a globally unique identity (<thread>@<byte offset>), its timestamp, cwd, git branch, creator version and byte range", () => {
    const threadId = codexThreadId();
    const { chunk } = readAll("0.142.5/basic.jsonl", { threadId });
    const first = chunk.events[0];
    expect(first).toMatchObject({ branch: "main", observedAt: "2026-01-01T00:00:07.000Z", cwd: CWD, gitBranch: "fix/double-charge", hostVersion: "0.142.5" });
    expect(first?.eventId).toBe(`${threadId}@${first?.lineStart}`);
    const ids = chunk.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of chunk.events) {
      expect(event.eventId.startsWith(`${threadId}@`)).toBe(true);
      expect(event.lineEnd).toBeGreaterThan(event.lineStart);
    }
  });

  test("the oldest supported version (0.125.0-alpha.3) parses with its smaller key set; an encrypted compaction imports nothing", () => {
    const { chunk } = readAll("0.125.0-alpha.3/basic.jsonl");
    expect(chunk.stop).toBeNull();
    expect(chunk.events.map(shape)).toEqual([
      ["user", "The nightly export job skips the last page of results."],
      ["call", "exec_command", "$ rg pageSize src", "other", [], []],
      ["result", "call_0501", "src/export.ts:88:  const pages = Math.fl", false],
      ["assistant", "The export uses Math.floor for the page count, so a partial last page is dropped; it should be Math.ceil."],
    ]);
    // session_meta, task_started, turn_context, the user and assistant copies, compacted, context_compacted
    expect(chunk.excluded).toEqual({ host_metadata: 7, hidden_reasoning: 1 });
  });

  test("Memchor's own calls are kind memchor under every name form Codex writes, and their results carry the bare MCP JSON", () => {
    const { chunk } = readAll("0.142.5/memchor-echo.jsonl", { workstreamId: "wst_11111111111111111111111111111111", recordId: "rec_22222222222222222222222222222222" });
    const calls = chunk.events.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => [c.tool, c.toolKind, c.summary])).toEqual([
      ["mcp__memchor__memory_bootstrap", "memchor", "memory_bootstrap {}"],
      ["mcp__memchor__memory_recall", "memchor", 'memory_recall {"query":"gateway retries"}'],
      ["mcp__memchor__memory_record", "memchor", 'memory_record {"kind":"note","body":"placeholder","attribution":"agent_inference"}'],
      ["mcp__node_repl__js", "other", "mcp__node_repl__js [arguments omitted]"],
    ]);
    const results = chunk.events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(4);
    const boot = JSON.parse(results[0]?.text ?? "") as { scope: { workstreamId: string } };
    expect(boot.scope.workstreamId).toBe("wst_11111111111111111111111111111111");
    expect(results[1]?.text).toContain("rec_22222222222222222222222222222222");
    // mcp_tool_call_end repeats the result: metadata, so the call has exactly one result event.
    expect(chunk.excluded["host_metadata"]).toBeGreaterThanOrEqual(1);
  });

  test("context Codex injects into user turns is excluded; only what the user typed is imported", () => {
    const { chunk } = readAll("0.142.5/injected.jsonl");
    expect(chunk.events.map(shape)).toEqual([["user", "Only this sentence was typed by the user."]]);
    expect(chunk.excluded["injected_context"]).toBe(5);
    expect(JSON.stringify(chunk.events)).not.toContain("SYNTHETIC-INJECTED");
  });

  test("a metadata update moves the git branch label of later events; rollback, abort and encrypted compaction import nothing", () => {
    const { chunk } = readAll("0.142.5/metadata-updates.jsonl");
    expect(chunk.events.map((e) => [shape(e), e.gitBranch])).toEqual([
      [["user", "Message on the first branch."], "fix/double-charge"],
      [["assistant", "Reply after the branch moved."], "fix/renamed-branch"],
    ]);
    expect(chunk.excluded).toEqual({ host_metadata: 10 });
  });

  test("cwd is per turn: a later turn_context moves later events, also when a read starts after it", () => {
    const { chunk, adapter, file } = readAll("0.142.5/cwd-change.jsonl", { cwd2: "/work/other" });
    expect(chunk.events.map((e) => [shape(e), e.cwd])).toEqual([
      [["user", "First turn in the main worktree."], CWD],
      [["user", "Second turn in the other worktree."], "/work/other"],
    ]);
    const second = chunk.events[1];
    // Resume exactly at the second user message's response_item copy (the line before the event).
    const resumed = adapter.read(file, second?.lineStart ?? 0, 1 << 20);
    expect(resumed.events.map((e) => [shape(e), e.cwd])).toEqual([[["user", "Second turn in the other worktree."], "/work/other"]]);
  });

  test("malformed lines and unknown entry or payload types are counted and skipped; a partial trailing line is left unconsumed", () => {
    const { chunk, file } = readAll("0.142.5/malformed.jsonl");
    expect(chunk.events.map(shape)).toEqual([
      ["user", "First well-formed message before the damage."],
      ["call", "exec_command", "exec_command [arguments omitted]", "other", [], []],
      ["result", "call_0301", "README.md\n", false],
      ["assistant", "Second well-formed message after the damage."],
    ]);
    expect(chunk.excluded).toMatchObject({ malformed: 1, unsupported_entry: 2 });
    expect(JSON.stringify(chunk.events)).not.toContain("SYNTHETIC-UNKNOWN");
    expect(chunk.stop).toBeNull();
    expect(chunk.end).toBeLessThan(file.size);
    expect(readFileSync(file.path, "utf8").slice(chunk.end)).not.toContain("\n");
  });

  test("keystrokes sent to a running process never reach a summary", () => {
    const { chunk } = readAll("0.142.5/large-and-sensitive.jsonl");
    const stdin = chunk.events.find((e) => e.type === "tool_call" && e.tool === "write_stdin");
    expect(stdin).toMatchObject({ summary: "write_stdin → session 7", toolKind: "other" });
    const summaries = chunk.events.filter((e) => e.type === "tool_call").map((e) => e.summary);
    expect(summaries.join("\n")).not.toContain("SYNTHETIC-SECRET-VALUE-0003");
    expect(summaries).toContain("apply_patch .env");
  });

  test("a shell command that only reads files is artifact access with the files' absolute paths; anything else stays other", () => {
    const { chunk } = readAll("0.142.5/shell-reads.jsonl");
    const calls = chunk.events.filter((e) => e.type === "tool_call").map((e) => [e.tool, e.toolKind, e.paths]);
    expect(calls).toEqual([
      ["exec_command", "artifact_access", [`${CWD}/src/gateway.ts`]],
      ["exec_command", "artifact_access", [`${CWD}/src/retry.ts`]],
      ["exec_command", "artifact_access", [`${CWD}/README.md`, `${CWD}/docs/idempotency.md`]],
      ["exec_command", "artifact_access", [`${CWD}/package.json`]],
      // `cd` moves the directory later reads resolve against; `echo` separators print only their own words.
      ["exec_command", "artifact_access", [`${CWD}/src/gateway.ts`, `${CWD}/src/retry.ts`]],
      // Relative to the call's own workdir, not the turn's cwd.
      ["exec_command", "artifact_access", [`${CWD}/docs/notes.md`]],
      ["exec_command", "artifact_access", [`${CWD}/logs/app.log`]],
      // `bash -lc` / `zsh -lc` wrappers are unwrapped, in argv and in string form.
      ["shell", "artifact_access", [`${CWD}/src/gateway.ts`]],
      ["shell_command", "artifact_access", [`${CWD}/src/retry.ts`]],
      ["exec_command", "artifact_access", [`${CWD}/src/missing.ts`]],
      // A test run, a search, an in-place edit, a sed write command, a redirect, an expansion, a substitution,
      // an `||` alternative and positional shell arguments are not pure reads.
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["exec_command", "other", []],
      ["shell", "other", []],
    ]);
  });

  test("every letter of a reader's flags is checked: a flag that writes, runs a command or is unknown makes the command not a pure read", () => {
    const { chunk } = readAll("0.142.5/shell-flags.jsonl");
    const calls = chunk.events.filter((e) => e.type === "tool_call").map((e) => [e.summary, e.toolKind, e.paths]);
    const gateway = [`${CWD}/src/gateway.ts`];
    const retry = [`${CWD}/src/retry.ts`];
    expect(calls).toEqual([
      ["$ cat -ns src/gateway.ts", "artifact_access", gateway],
      ["$ head -c 200 src/gateway.ts", "artifact_access", gateway],
      ["$ head -n40 src/gateway.ts", "artifact_access", gateway],
      ["$ tail -n +20 src/retry.ts", "artifact_access", retry],
      ["$ nl -ba -w4 src/retry.ts", "artifact_access", retry],
      ["$ less -SN src/gateway.ts", "artifact_access", gateway],
      ["$ bat --paging=never -n src/retry.ts", "artifact_access", retry],
      ["$ sed -ne '1,5p' src/gateway.ts", "artifact_access", gateway],
      // `-o`/`-O` inside a cluster still write a log file; `-k` loads key bindings from a file.
      ["$ cat src/gateway.ts | less -So log.txt", "other", []],
      ["$ less -O log.txt src/gateway.ts", "other", []],
      ["$ less -k keys.bin src/gateway.ts", "other", []],
      // A `+` operand is a pager command, and bat's pager is a command line.
      ["$ less '+!echo hi' src/gateway.ts", "other", []],
      ["$ more +/charge src/gateway.ts", "other", []],
      ["$ bat --pager 'sh -c true' src/retry.ts", "other", []],
      ["$ bat --paging=always src/retry.ts", "other", []],
      // A count that is not a number, and letters the reader does not know, fail closed.
      ["$ head -n x src/gateway.ts", "other", []],
      ["$ cat -z src/gateway.ts", "other", []],
      ["$ nl -ba -Q src/retry.ts", "other", []],
      // `-f` loads a script from a file; in `-en` the `n` is the script (not -n), so every line prints.
      ["$ sed -nf print.sed src/gateway.ts", "other", []],
      ["$ sed -en '1p' src/gateway.ts", "other", []],
    ]);
  });

  test("a shell read is a file read only when every path it reads is inside the turn's working tree", () => {
    const { chunk } = readAll("0.142.5/shell-outside.jsonl");
    const calls = chunk.events.filter((e) => e.type === "tool_call").map((e) => [e.summary, e.toolKind, e.paths]);
    expect(calls).toEqual([
      // Outside the tree the output is not a file Memchor can reference, so it stays bounded command output.
      ["$ cat /tmp/memchor-example/test.log", "other", []],
      ["$ tail -n 5 ../sibling/notes.md", "other", []],
      ["$ cd /tmp/memchor-example && cat test.log", "other", []],
      ["$ cat ~/.aws/credentials", "other", []],
      ["$ cat /home/placeholder/.aws/credentials", "other", []],
      ["$ head -3 /home/placeholder/other/.env", "other", []],
      ["$ cat .env", "artifact_access", [`${CWD}/.env`]],
      ["$ echo '--- gateway'; cat src/gateway.ts", "artifact_access", [`${CWD}/src/gateway.ts`]],
    ]);
  });

  test("a 0.148.0-alpha.21 legacy rollout: audio is binary, new metadata types are skipped, and the MCP call triple yields one call and one result", () => {
    const { chunk } = readAll("0.148.0-alpha.21/basic.jsonl");
    expect(chunk.stop).toBeNull();
    expect(chunk.events.map(shape)).toEqual([
      ["user", "Pick up the handoff and check what memory says."],
      ["call", "mcp__memchor__memory_recall", 'memory_recall {"query":"handoff"}', "memchor", [], []],
      ["result", "call_0601", '{"items":[{"recordId":"rec_0000000000000', false],
      ["assistant", "Memory has one earlier decision; I will verify it against the code."],
    ]);
    expect(chunk.excluded).toMatchObject({ binary: 1, injected_context: 2 });
    expect(chunk.excluded["unsupported_entry"]).toBeUndefined();
  });

  test("a local compaction is kept once as a host summary without Codex's prompt prefix; its assistant copy is not a message", () => {
    const { chunk } = readAll("0.148.0-alpha.21/local-compaction.jsonl");
    expect(chunk.events.map(shape)).toEqual([
      ["user", "Keep going with the outbox migration."],
      ["summary", "The outbox migration is written; the backfill script still n"],
    ]);
  });

  test("a fork's copied parent prefix keeps the parent's event identity and time; the fork's own lines keep its own", () => {
    const home = codexHome();
    const parentId = codexThreadId();
    const childId = codexThreadId();
    const parent = installCodexRollout(home, "0.148.0-alpha.21/fork-parent.jsonl", { cwd: CWD, threadId: parentId });
    const child = installCodexRollout(home, "0.148.0-alpha.21/fork.jsonl", { cwd: CWD, threadId: childId, parentId });
    const adapter = codexAdapter({ codexHome: home });
    const parentEvents = adapter.read(fileOf(parent.path, parentId), 0, 1 << 20).events;
    const childEvents = adapter.read(fileOf(child.path, childId), 0, 1 << 20).events;
    expect(childEvents.map(shape)).toEqual([
      ["user", "The retry test is flaky on CI; find out why."],
      ["assistant", "The retry test depends on wall-clock time; it needs a fake clock."],
      ["user", "In this fork, try the fake clock instead."],
      ["assistant", "Switched the retry test to a fake clock; it passes 50 runs in a row."],
    ]);
    expect(childEvents.slice(0, 2).map((e) => [e.eventId, e.observedAt])).toEqual(parentEvents.map((e) => [e.eventId, e.observedAt]));
    for (const own of childEvents.slice(2)) expect(own.eventId.startsWith(`${childId}@`)).toBe(true);

    // The mapping stops at the first line that differs from the parent (here: the parent's assistant reply was edited).
    const edited = codexHome();
    installCodexRollout(edited, "", { cwd: CWD, threadId: parentId, content: readFileSync(parent.path, "utf8").replace("needs a fake clock", "needs a mocked clock") });
    const diverged = installCodexRollout(edited, "0.148.0-alpha.21/fork.jsonl", { cwd: CWD, threadId: childId, parentId });
    const partly = codexAdapter({ codexHome: edited }).read(fileOf(diverged.path, childId), 0, 1 << 20).events;
    expect(partly.map((e) => e.eventId.split("@")[0])).toEqual([parentId, childId, childId, childId]);

    // Without the parent on disk the fork keeps its own ids (the copy then over-counts: documented limit).
    const orphan = codexHome();
    const alone = installCodexRollout(orphan, "0.148.0-alpha.21/fork.jsonl", { cwd: CWD, threadId: childId, parentId });
    const own = codexAdapter({ codexHome: orphan }).read(fileOf(alone.path, childId), 0, 1 << 20).events;
    expect(own.map((e) => e.eventId.split("@")[0])).toEqual([childId, childId, childId, childId]);
  });

  test("a paginated rollout stops at its first line with <version>+paginated, as does a paginated line in a legacy file", () => {
    const { chunk, adapter, file } = readAll("0.148.0-alpha.21/paginated.jsonl");
    expect(chunk.events).toEqual([]);
    expect(chunk.stop).toEqual({ reason: "unsupported_version", hostVersion: "0.148.0-alpha.21+paginated", offset: 0 });
    expect(chunk.end).toBe(0);
    expect(adapter.inspect(file)).toEqual({ cwd: CWD, hostVersion: "0.148.0-alpha.21", supported: false });

    const legacy = readAll("0.148.0-alpha.21/basic.jsonl");
    const size = legacy.file.size;
    appendFileSync(legacy.file.path, JSON.stringify({ timestamp: "2026-01-01T02:00:00.000Z", ordinal: 40, type: "event_msg", payload: { type: "user_message", message: "SYNTHETIC after migration" } }) + "\n");
    const after = legacy.adapter.read(fileOf(legacy.file.path, legacy.file.transcriptId), size, 1 << 20);
    expect(after.events).toEqual([]);
    expect(after.stop).toEqual({ reason: "unsupported_version", hostVersion: "0.148.0-alpha.21+paginated", offset: size });
  });

  test("a rollout created by a version outside the compatibility table stops at its first line", () => {
    const { chunk, adapter, file } = readAll("unknown-version.jsonl");
    expect(chunk.events).toEqual([]);
    expect(chunk.stop).toEqual({ reason: "unsupported_version", hostVersion: "0.104.0-alpha.1", offset: 0 });
    expect(adapter.inspect(file)).toEqual({ cwd: CWD, hostVersion: "0.104.0-alpha.1", supported: false });
    expect(adapter.compatibility.map((row) => [row.from, row.below, row.format])).toEqual([
      ["0.125.0-alpha.3", "0.143.0", "codex-rollout-legacy-v1"],
      ["0.148.0-alpha.21", "0.148.0-alpha.22", "codex-rollout-legacy-v1"],
    ]);
  });

  test("pre-release versions are ordered by semver precedence at the table's edges", () => {
    const home = codexHome();
    const base = readFileSync(installCodexRollout(home, "0.142.5/injected.jsonl", { cwd: CWD }).path, "utf8");
    const adapter = codexAdapter({ codexHome: home });
    const supported = (version: string): boolean => {
      const installed = installCodexRollout(home, "", { cwd: CWD, content: base.replaceAll('"cli_version":"0.142.5"', `"cli_version":"${version}"`) });
      return adapter.inspect(fileOf(installed.path, installed.sessionId)).supported;
    };
    expect(
      Object.fromEntries(
        ["0.125.0-alpha.2", "0.125.0-alpha.3", "0.125.0-alpha.10", "0.125.0-beta.1", "0.125.0", "0.142.5", "0.143.0-alpha.1", "0.143.0", "0.148.0-alpha.3", "0.148.0-alpha.20", "0.148.0-alpha.21", "0.148.0-alpha.21.1", "0.148.0-alpha.22", "0.148.0-beta.21", "0.148.0", "0.142", "dev"].map((v) => [v, supported(v)]),
      ),
    ).toEqual({
      "0.125.0-alpha.2": false,
      "0.125.0-alpha.3": true,
      "0.125.0-alpha.10": true,
      "0.125.0-beta.1": true,
      "0.125.0": true,
      "0.142.5": true,
      "0.143.0-alpha.1": true,
      "0.143.0": false,
      "0.148.0-alpha.3": false,
      "0.148.0-alpha.20": false,
      "0.148.0-alpha.21": true,
      "0.148.0-alpha.21.1": true,
      "0.148.0-alpha.22": false,
      "0.148.0-beta.21": false,
      "0.148.0": false,
      "0.142": false,
      dev: false,
    });
  });

  test("reading in small slices yields exactly the events of one full read", () => {
    const { adapter, file, chunk: whole } = readAll("0.142.5/basic.jsonl");
    const events: NormalizedEvent[] = [];
    let offset = 0;
    for (let guard = 0; offset < file.size && guard < 200; guard++) {
      const part = adapter.read(file, offset, 700);
      events.push(...part.events);
      offset = part.end;
    }
    expect(offset).toBe(file.size);
    expect(events).toEqual(whole.events);
  });

  test("discovery lists live and archived rollouts once each, skips subagents and anything else, and inspect reads the head", () => {
    const home = codexHome();
    const live = installCodexRollout(home, "0.142.5/basic.jsonl", { cwd: CWD });
    const archived = installCodexRollout(home, "0.125.0-alpha.3/basic.jsonl", { cwd: CWD, archived: true });
    installCodexRollout(home, "0.133.0-alpha.1/subagent.jsonl", { cwd: CWD });
    // A transient copy of the live rollout in archived_sessions is the same transcript.
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    writeFileSync(join(home, "archived_sessions", `rollout-2026-01-01T00-00-00-${live.sessionId}.jsonl`), "");
    writeFileSync(join(home, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${codexThreadId()}.jsonl.zst`), "compressed");
    writeFileSync(join(home, "session_index.jsonl"), '{"id":"x","thread_name":"SYNTHETIC name"}\n');
    writeFileSync(join(home, "sessions", "2026", "01", "01", "notes.jsonl"), "{}\n");
    writeFileSync(join(home, "auth.json"), "SYNTHETIC-SECRET");

    const adapter = codexAdapter({ codexHome: home });
    expect(adapter.root).toBe(home);
    const found = adapter.discover();
    expect(found.map((f) => [f.transcriptId, f.path])).toEqual([
      [archived.sessionId, archived.path],
      [live.sessionId, live.path],
    ].sort((a, b) => ((a[1] ?? "") < (b[1] ?? "") ? -1 : 1)));
    const liveFile = found.find((f) => f.transcriptId === live.sessionId) as TranscriptFile;
    expect(adapter.inspect(liveFile)).toEqual({ cwd: CWD, hostVersion: "0.142.5", supported: true });
    expect(codexAdapter({ codexHome: join(home, "missing") }).discover()).toEqual([]);
  });

  test("the root is $CODEX_HOME when set and non-empty, else ~/.codex", () => {
    const previous = process.env["CODEX_HOME"];
    try {
      process.env["CODEX_HOME"] = "/somewhere/codex-home";
      expect(codexAdapter().root).toBe("/somewhere/codex-home");
      process.env["CODEX_HOME"] = "";
      expect(codexAdapter().root).toMatch(/\.codex$/);
    } finally {
      if (previous === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previous;
    }
  });
});
