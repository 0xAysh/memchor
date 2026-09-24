import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import type { TranscriptAdapter } from "../../src/import/normalized-event.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "./fixtures.js";

interface Env {
  home: string;
  config: string;
}

function env(): Env {
  return { home: tempDir(), config: claudeConfigDir() };
}

const CONSENT_WRITER = resolve(import.meta.dirname, "consent-writer.mjs");

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolveMessage, reject) => {
    child.once("message", resolveMessage);
    child.once("error", reject);
  });
}

function open(cwd: string, e: Env, options: { host?: string; importBudgetMs?: number } = {}): Memory {
  const memory = openMemory({
    cwd,
    home: e.home,
    host: options.host ?? "claude-code",
    claudeConfigDir: e.config,
    ...(options.importBudgetMs === undefined ? {} : { importBudgetMs: options.importBudgetMs }),
  });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** Every excerpt and title an agent can see in this workstream, joined for content assertions. */
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

describe("first-use consent", () => {
  test("first bootstrap returns transcript counts and the exact all/current/none choices, and imports nothing", () => {
    const e = env();
    const repo = initRepo();
    const other = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    installTranscript(e.config, "2.1.183/basic.jsonl", { cwd: other });
    installTranscript(e.config, "2.1.281/branches.jsonl", { cwd: "/nonexistent/memchor-test/project" });

    const memory = open(repo, e);
    const boot = memory.bootstrap();
    expect(boot.import).toMatchObject({
      host: "claude-code",
      state: "consent_required",
      consent: null,
      choices: ["all", "current_project", "none"],
      transcripts: { found: 3, currentProject: 1, otherProjects: 1, unassigned: 1 },
    });
    expect(boot.import.question).toMatch(/found 3 local Claude Code sessions/);
    expect(boot.import.question).toMatch(/does not send this data externally/);
    expect(boot.context.empty).toBe(true);
    expect(memory.status().counts?.records).toBe(0);
  });

  test("current project only imports this repository's transcripts with Claude provenance, and nothing else", () => {
    const e = env();
    const repo = initRepo({ branch: "fix/double-charge" });
    const other = initRepo();
    const mine = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    installTranscript(e.config, "2.1.183/basic.jsonl", { cwd: other });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import).toMatchObject({ state: "complete", consent: { choice: "current_project" } });
    expect(boot.import.currentProject).toMatchObject({ transcripts: 1, complete: 1, pending: 0 });
    expect(boot.context.empty).toBe(false);
    const item = boot.context.items.find((i) => i.excerpt.includes("Root cause: charge() retries a 504"));
    expect(item).toMatchObject({
      kind: "evidence",
      attribution: "agent_inference",
      host: "claude-code",
      createdAt: "2026-09-20T10:00:30.000Z",
      source: { kind: "transcript", host: "claude-code", transcriptId: mine.sessionId, branch: "main", eventId: "00000000-0000-4000-8000-000000000016" },
    });
    const direction = memory.recall({ query: "idempotency key per order" }).items[0];
    expect(direction).toMatchObject({ attribution: "user_direction", excerpt: "Use a server-side idempotency key per order; do not add client retries." });

    expect(visibleText(memory)).not.toMatch(/nightly export/);
    const elsewhere = open(other, e);
    expect(elsewhere.status().counts).toBeNull(); // no database was ever created for the other project
    expect(elsewhere.bootstrap().import.state).toBe("not_approved");
    expect(elsewhere.status().counts?.records).toBe(0);
  });

  test("none imports no transcript content, is remembered, and cooperative memory keeps working", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });

    const first = open(repo, e);
    expect(first.bootstrap({ importChoice: "none" }).import).toMatchObject({ state: "declined", consent: { choice: "none" } });
    const note = first.record({ kind: "note", body: "cooperative write still works", attribution: "agent_inference" });
    expect(first.recall({}).items.map((i) => i.recordId)).toEqual([note.recordId]);
    first.close();

    const second = open(repo, e);
    expect(second.bootstrap().import).toMatchObject({ state: "declined", question: null });
    expect(second.status().counts?.records).toBe(1);
  });

  test("bootstrap and status do not discover or inspect transcript heads after consent is none", () => {
    const repo = initRepo();
    const untouched = (): never => { throw new Error("declined transcript adapter was touched"); };
    const adapter: TranscriptAdapter = {
      host: "privacy-test",
      displayName: "Privacy Test",
      compatibility: [],
      root: "/must-not-be-read",
      discover: untouched,
      inspect: untouched,
      read: untouched,
    };
    const memory = openMemory({ cwd: repo, home: tempDir(), host: adapter.host, transcriptAdapter: adapter });
    onCleanup(() => { memory.close(); });

    expect(memory.bootstrap({ importChoice: "none" }).import).toMatchObject({ state: "declined", transcripts: null });
    expect(memory.bootstrap().import).toMatchObject({ state: "declined", transcripts: null });
    expect(memory.status().import).toMatchObject({ state: "declined", transcripts: null });
  });

  test("concurrent current-project choices in two processes preserve both repository approvals", async () => {
    const home = tempDir();
    const repositories = [initRepo(), initRepo()];
    const repositoryKeys = repositories.map((repo) => realpathSync(join(repo, ".git")));
    // A realistic lock test needs both processes inside the read-modify-write window at once.
    // A large existing approval set makes that overlap deterministic even on a single-core runner.
    const seededProjects = Array.from({ length: 100_000 }, (_, index) => `/seed/repository/${index.toString().padStart(6, "0")}`);
    writeFileSync(
      join(home, "consent.json"),
      JSON.stringify({
        version: 1,
        hosts: {
          "claude-code": {
            choice: "current_project",
            projects: seededProjects,
            decidedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const children = repositories.map(() => fork(CONSENT_WRITER, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    for (const child of children) onCleanup(() => child.kill());
    await Promise.all(children.map(nextMessage));
    const outcomes = children.map(nextMessage);
    children.forEach((child, index) => child.send({ home, repositoryKey: repositoryKeys[index] }));
    expect(await Promise.all(outcomes)).toEqual([{ ok: true }, { ok: true }]);

    const stored = JSON.parse(readFileSync(join(home, "consent.json"), "utf8")) as { hosts: { "claude-code": { projects: string[] } } };
    expect(stored.hosts["claude-code"].projects).toEqual(expect.arrayContaining(repositoryKeys));
    expect(stored.hosts["claude-code"].projects).toHaveLength(seededProjects.length + 2);
  });

  test("the consent decision is per host, inspectable in status and changeable through bootstrap", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });

    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "none" });
    expect(memory.status().import?.consent).toMatchObject({ choice: "none" });
    const changed = memory.bootstrap({ importChoice: "current_project" });
    expect(changed.import).toMatchObject({ state: "complete", consent: { choice: "current_project" } });
    expect(memory.status().import?.consent?.choice).toBe("current_project");
    expect(memory.status().counts?.records).toBeGreaterThan(0);

    const codex = open(repo, e, { host: "codex" });
    expect(codex.bootstrap().import).toMatchObject({ host: "codex", state: "unsupported_host", consent: null });
  });
});

describe("all projects and ordering", () => {
  test("all projects imports the current repository first, then backfills others into their own workspaces", () => {
    const e = env();
    const repo = initRepo();
    const other = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    installTranscript(e.config, "2.1.183/basic.jsonl", { cwd: other });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "all" });
    expect(boot.import).toMatchObject({ state: "in_progress", currentProject: { complete: 1, pending: 0 }, backfill: { projects: 1, transcripts: 1, reconciled: false } });
    expect(boot.context.items.some((i) => i.excerpt.includes("Root cause"))).toBe(true);

    const more = memory.continueImport({ maxMs: 5_000 });
    expect(more).toMatchObject({ done: true, state: "complete", backfill: { reconciled: true } });
    // Separate workspaces: neither sees the other's history in normal retrieval.
    expect(visibleText(memory)).not.toMatch(/nightly export/);
    const elsewhere = open(other, e);
    const otherBoot = elsewhere.bootstrap();
    expect(otherBoot.scope.workspaceId).not.toBe(boot.scope.workspaceId);
    // This process has not reconciled the first repository (another approved project) yet.
    expect(otherBoot.import).toMatchObject({ state: "in_progress", currentProject: { complete: 1, pending: 0, counters: { records: 3, replayed: 0 } }, backfill: { reconciled: false } });
    expect(visibleText(elsewhere)).toMatch(/Math\.floor for the page count/);
    expect(visibleText(elsewhere)).not.toMatch(/Root cause/);
  });

  test("a bootstrap budget smaller than the history returns early with useful context, and the rest resumes", () => {
    const e = env();
    const repo = initRepo();
    const newest = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    for (let i = 0; i < 4; i++) installTranscript(e.config, "2.1.281/branches.jsonl", { cwd: repo });
    installTranscript(e.config, "2.1.281/compaction.jsonl", { cwd: repo });
    const later = new Date(Date.now() + 60_000);
    utimesSync(newest.path, later, later); // newest transcript first

    const memory = open(repo, e, { importBudgetMs: 0 });
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import).toMatchObject({ state: "in_progress", currentProject: { transcripts: 6, complete: 1, pending: 5 } });
    expect(boot.context.items.some((i) => i.source?.transcriptId === newest.sessionId)).toBe(true);
    memory.close();

    const next = open(repo, e);
    const resumed = next.bootstrap();
    expect(resumed.import).toMatchObject({ state: "complete", currentProject: { transcripts: 6, complete: 6, pending: 0, counters: { replayed: 0 } } });
  });
});

describe("reconciliation", () => {
  function recordCount(memory: Memory): number {
    return memory.status().counts?.records ?? -1;
  }

  test("replaying unchanged transcripts is a no-op", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "current_project" });
    const before = recordCount(first);
    expect(before).toBe(7); // 4 messages + 3 tool results; the Memchor echo is not a record
    first.close();

    const second = open(repo, e);
    const again = second.bootstrap();
    expect(recordCount(second)).toBe(before);
    expect(again.import.currentProject?.counters).toMatchObject({ records: before, replayed: 0 });
  });

  test("appended events are imported exactly once", () => {
    const e = env();
    const repo = initRepo();
    const t = installTranscript(e.config, "2.1.281/branches.jsonl", { cwd: repo });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "current_project" });
    expect(recordCount(first)).toBe(4);
    first.close();

    appendFileSync(t.path, renderFixture("2.1.281/compaction.jsonl", { cwd: repo, sessionId: t.sessionId }));
    const second = open(repo, e);
    const boot = second.bootstrap();
    expect(recordCount(second)).toBe(7);
    expect(boot.import.currentProject?.counters).toMatchObject({ records: 7, replayed: 0, conflicts: 0 });
    expect(second.recall({ query: "outbox migration tests pass" }).items[0]?.excerpt).toMatch(/While you were away/);
  });

  test("a rewritten transcript is reconciled by event identity: edits become linked versions, removals are counted, nothing is deleted", () => {
    const e = env();
    const repo = initRepo();
    const t = installTranscript(e.config, "2.1.281/branches.jsonl", { cwd: repo });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "current_project" });
    const original = first.recall({ query: "Redis dependency" }).items[0];
    first.close();

    // Edit one event, drop the last one, keep the rest byte-identical.
    const lines = readFileSync(t.path, "utf8").trimEnd().split("\n");
    lines[1] = (lines[1] ?? "").replace("avoids a new dependency", "avoids a new dependency and an extra failure mode");
    writeFileSync(t.path, lines.slice(0, 3).join("\n") + "\n");

    const second = open(repo, e);
    const boot = second.bootstrap();
    expect(boot.import.currentProject?.counters).toMatchObject({ rewrites: 1, conflicts: 1, missing: 1, replayed: 2 });
    expect(recordCount(second)).toBe(5); // 4 originals kept + 1 new version
    const edited = second.recall({ query: "extra failure mode" }).items[0];
    expect(edited?.citations).toEqual([{ recordId: original?.recordId, relation: "related_to" }]);
    expect(second.read({ recordId: original?.recordId ?? "" }).body).toMatch(/avoids a new dependency\.$/);
  });

  test("a truncated transcript is reconciled rather than silently losing its cursor", () => {
    const e = env();
    const repo = initRepo();
    const t = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "current_project" });
    first.close();

    writeFileSync(t.path, readFileSync(t.path, "utf8").split("\n").slice(0, 3).join("\n") + "\n");
    const second = open(repo, e);
    const boot = second.bootstrap();
    expect(boot.import.currentProject).toMatchObject({ complete: 1, counters: { rewrites: 1, missing: 6, replayed: 1 } });
    expect(recordCount(second)).toBe(7);
  });

  test("a same-length early edit before the trailing anchor forces an explicit reconciliation pass", () => {
    const e = env();
    const repo = initRepo();
    const t = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "current_project" });
    first.close();

    const before = readFileSync(t.path, "utf8");
    const after = before.replace("Checkout double-charges", "Checkout triple-charges");
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    expect(before.indexOf("Checkout double-charges")).toBeLessThan(before.length - 4_096);
    writeFileSync(t.path, after);
    const later = new Date(Date.now() + 60_000);
    utimesSync(t.path, later, later);

    const second = open(repo, e);
    const boot = second.bootstrap();
    expect(boot.import.currentProject).toMatchObject({
      complete: 1,
      counters: { rewrites: 1, conflicts: 1, missing: 0, replayed: 11 },
    });
    expect(second.recall({ query: "triple charges" }).items[0]?.citations).toHaveLength(1);
  });
});

describe("capture safety", () => {
  /** Every stored record body and title, straight from the interface (read each visible record in full). */
  function storedText(memory: Memory): string {
    const parts: string[] = [];
    let pack = memory.recall({ maxTokens: 8_000 });
    for (;;) {
      for (const item of pack.items) {
        const read = memory.read({ recordId: item.recordId, maxBytes: 32_000 });
        parts.push(read.title ?? "", read.body);
      }
      if (pack.continuation === null) break;
      pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
    }
    return parts.join("\n");
  }

  test("hidden reasoning, injected context, binaries, file contents, Memchor echoes and secrets are not stored", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });

    const text = storedText(memory);
    expect(text).not.toMatch(/SYNTHETIC-(HIDDEN|INJECTED|FILE-CONTENT|ECHO)|SYNTHETICBINARY|AKIAIOSFODNN7EXAMPLE/);
    expect(text).toMatch(/AWS_ACCESS_KEY_ID=\[redacted:aws_access_key\]/);
    expect(boot.import.currentProject?.counters).toMatchObject({
      redactions: 1,
      fileContents: 1,
      echoes: 1,
      excluded: { hidden_reasoning: 1, binary: 1, injected_context: 3, host_metadata: 5 },
    });
    const read = memory.recall({ query: "gateway.ts" }).items.find((i) => i.title?.startsWith("Read"));
    expect(read).toMatchObject({ attribution: "direct_observation", externalRefs: [{ kind: "code", locator: "src/gateway.ts", path: "src/gateway.ts" }] });
    expect(read?.excerpt).toMatch(/file content not stored/);
  });

  test("oversized content is bounded with an explicit omission marker, sensitive-path output is withheld, and credentials in prose are redacted", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/large-and-sensitive.jsonl", { cwd: repo });
    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });

    const text = storedText(memory);
    expect(text).not.toMatch(/SYNTHETIC-DOTENV|SYNTHETICSECRET123456|b3BlbnNzaC1rZXktdjEAAAAA/);
    expect(text).toMatch(/\[output withheld by Memchor: the call touched a sensitive path\]/);
    expect(text).toMatch(/api_key: \[redacted:secret\]/);
    expect(text).toMatch(/\[redacted:private_key\]/);
    const build = memory.recall({ query: "BUILD-HEAD" }).items[0];
    const body = memory.read({ recordId: build?.recordId ?? "", maxBytes: 32_000 }).body;
    expect(body).toMatch(/^\$ npm run build --verbose\n\nBUILD-HEAD compiling/);
    expect(body).toMatch(/\[… [\d,]+ bytes omitted by Memchor …\]\n.*BUILD-TAIL$/s);
    expect(Buffer.byteLength(body)).toBeLessThan(2_000);
    expect(boot.import.currentProject?.counters).toMatchObject({ clipped: 2, withheld: 1, redactions: 2 });
  });

  test("tool-call bookkeeping never persists raw secrets, oversized inputs, credential URLs or sensitive paths", () => {
    const e = env();
    const repo = initRepo();
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const bashSecret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const unknownSecret = "password=UNKNOWN-TOOL-PASSWORD-123456";
    const unknownHead = "UNKNOWN-RAW-HEAD-MUST-NOT-PERSIST";
    const oversizedSecret = "OVERSIZED-INTERIOR-PAYLOAD-MUST-NOT-PERSIST";
    const unknownTail = "UNKNOWN-RAW-TAIL-MUST-NOT-PERSIST";
    const commandPrefix = "SENSITIVE-COMMAND-PREFIX-MUST-NOT-PERSIST";
    const commandSuffix = "SENSITIVE-COMMAND-SUFFIX-MUST-NOT-PERSIST";
    const credentialUrl = "https://alice:URL-PASSWORD-123456@example.invalid/private?token=URL-TOKEN-123456";
    const sensitivePath = "/home/alice/.ssh/id_ed25519";
    const huge = `${unknownHead}${"x".repeat(2_000)}${oversizedSecret}${"y".repeat(2_000)}${unknownTail}`;
    const base = { timestamp: "2026-09-23T09:00:00.000Z", cwd: repo, sessionId, version: "2.1.281", gitBranch: "main" };
    const assistant = (uuid: string, id: string, name: string, input: object): string => JSON.stringify({ ...base, type: "assistant", uuid, message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (uuid: string, id: string, content: string): string => JSON.stringify({ ...base, type: "user", uuid, origin: { kind: "human" }, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
    const content = [
      assistant("call-1", "toolu-private-1", "Bash", { command: `${commandPrefix}; export API_KEY=${bashSecret}; ${commandSuffix}` }),
      result("result-1", "toolu-private-1", "command completed usefully without echoing its arguments"),
      assistant("call-2", "toolu-private-2", "UnknownTool", { payload: unknownSecret, huge }),
      result("result-2", "toolu-private-2", "unknown tool completed usefully"),
      assistant("call-3", "toolu-private-3", "WebFetch", { url: credentialUrl }),
      result("result-3", "toolu-private-3", "web fetch completed usefully"),
      assistant("call-4", "toolu-private-4", "Read", { file_path: sensitivePath }),
      result("result-4", "toolu-private-4", "SENSITIVE-FILE-DUMP-MUST-NOT-PERSIST"),
    ].join("\n") + "\n";
    installTranscript(e.config, "", { cwd: repo, sessionId, content });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject?.counters).toMatchObject({ records: 4, withheld: 1 });
    const visible = visibleText(memory);
    expect(visible).toMatch(/command completed usefully|unknown tool completed usefully|web fetch completed usefully/);
    expect(visible).toContain("Bash [sensitive arguments withheld]");
    expect(visible).toContain("UnknownTool [arguments omitted]");
    const dbPath = memory.status().storage.dbPath ?? "";
    memory.close();

    const forbidden = [
      bashSecret,
      commandPrefix,
      commandSuffix,
      unknownSecret,
      unknownHead,
      oversizedSecret,
      unknownTail,
      credentialUrl,
      sensitivePath,
      "SENSITIVE-FILE-DUMP-MUST-NOT-PERSIST",
    ];
    const db = new Database(dbPath, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
    const canonical = tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join("\n");
    db.close();
    for (const value of forbidden) expect(canonical).not.toContain(value);
    expect(Buffer.byteLength(canonical)).toBeLessThan(100_000);
  });

  test("Memchor output echoed in a transcript keeps its references to existing records and is never new evidence", () => {
    const e = env();
    const repo = initRepo();
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "none" });
    const decision = memory.record({ kind: "decision", body: "Use an outbox table for retries.", attribution: "user_direction" });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    installTranscript(e.config, "2.1.281/basic.jsonl", {
      cwd: repo,
      sessionId,
      content: renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replace("rec_0123456789abcdef0123456789abcdef", decision.recordId)
        .replace("SYNTHETIC-ECHO previously recalled memory", "Use an outbox table for retries."),
    });
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject?.counters).toMatchObject({ echoes: 1, echoReferences: 1 });
    expect(storedText(memory)).not.toMatch(/SYNTHETIC-ECHO/);
    // The recalled text reappears in the transcript, but only the original record carries it.
    expect(memory.recall({ query: "outbox" }).items.map((i) => i.recordId)).toEqual([decision.recordId]);
  });

  test("a transcript that moves to another repository is quarantined from that point, with a scope_ambiguous gap", () => {
    const e = env();
    const repo = initRepo();
    const other = initRepo();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const content = renderFixture("2.1.281/branches.jsonl", { cwd: repo, sessionId }) + renderFixture("2.1.281/compaction.jsonl", { cwd: other, sessionId });
    installTranscript(e.config, "", { cwd: repo, sessionId, content });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "all" });
    expect(boot.import.currentProject).toMatchObject({ quarantined: 1, counters: { records: 4 } });
    expect(boot.import.gaps).toEqual([expect.objectContaining({ transcriptId: sessionId, reason: "scope_ambiguous", cwd: other })]);
    expect(visibleText(memory)).not.toMatch(/outbox migration/);
    expect(memory.status().import?.gaps).toHaveLength(1);
    memory.continueImport({ maxMs: 5_000 });
    expect(open(other, e).status().counts).toBeNull(); // nothing leaked into the other workspace
  });

  test("Memchor output naming another workstream of the workspace binds the transcript there: session metadata outranks the worktree binding", () => {
    const e = env();
    const repo = initRepo();
    const sibling = tempDir("memchor-worktree-");
    git(repo, "worktree", "add", "--quiet", "-b", "feature/other", sibling + "/wt");
    const siblingMemory = open(sibling + "/wt", e);
    const siblingWs = siblingMemory.bootstrap({ importChoice: "none" }).scope.workstreamId;
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replace(
      '{\\"items\\":[',
      `{\\"scope\\":{\\"workstreamId\\":\\"${siblingWs}\\"},\\"items\\":[`,
    );
    installTranscript(e.config, "", { cwd: repo, sessionId, content });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.gaps).toEqual([]);
    expect(boot.import.currentProject).toMatchObject({ quarantined: 0, complete: 1, counters: { records: 7, echoes: 1 } });
    expect(visibleText(memory)).not.toMatch(/double-charges/);
    expect(visibleText(siblingMemory)).toMatch(/double-charges/);
  });

  test("an unsupported Claude Code version stops only that transcript, preserves its cursor and shows as a gap", () => {
    const e = env();
    const repo = initRepo();
    const bad = installTranscript(e.config, "unknown-version.jsonl", { cwd: repo });
    installTranscript(e.config, "2.1.281/branches.jsonl", { cwd: repo });
    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject).toMatchObject({ transcripts: 2, complete: 1, stopped: 1, counters: { records: 5 } });
    expect(boot.import.gaps).toEqual([expect.objectContaining({ transcriptId: bad.sessionId, reason: "unsupported_version", hostVersion: "3.0.0" })]);
    expect(boot.import.gaps[0]?.message).toMatch(/compatibility table/);
    expect(memory.status().import?.gaps).toEqual(boot.import.gaps);
    memory.close();

    const again = open(repo, e);
    expect(again.bootstrap().import.currentProject).toMatchObject({ stopped: 1, counters: { records: 5, replayed: 0 } });
  });

  test("a versionless content entry stops import at that line and reports a compatibility gap", () => {
    const e = env();
    const repo = initRepo();
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const before = JSON.stringify({ type: "user", uuid: "before", timestamp: "2026-09-23T10:00:00.000Z", cwd: repo, sessionId, version: "2.1.281", origin: { kind: "human" }, message: { content: "Imported before the format gap." } });
    const gap = JSON.stringify({ type: "user", uuid: "gap", timestamp: "2026-09-23T10:00:01.000Z", cwd: repo, sessionId, origin: { kind: "human" }, message: { content: "Must remain beyond the cursor." } });
    installTranscript(e.config, "", { cwd: repo, sessionId, content: `${before}\n${gap}\n` });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.currentProject).toMatchObject({ stopped: 1, counters: { records: 1, excluded: {} } });
    expect(boot.import.gaps).toEqual([expect.objectContaining({ reason: "unsupported_version", hostVersion: "missing" })]);
    expect(visibleText(memory)).toContain("Imported before the format gap.");
    expect(visibleText(memory)).not.toContain("Must remain beyond the cursor.");
    memory.close();

    const again = open(repo, e).bootstrap();
    expect(again.import.currentProject).toMatchObject({ stopped: 1, counters: { records: 1, replayed: 0 } });
  });

  test("malformed lines are skipped and counted; a line still being written is imported once it is complete", () => {
    const e = env();
    const repo = initRepo();
    const t = installTranscript(e.config, "2.1.281/malformed.jsonl", { cwd: repo });
    const memory = open(repo, e);
    expect(memory.bootstrap({ importChoice: "current_project" }).import.currentProject).toMatchObject({
      complete: 1,
      counters: { records: 2, excluded: { malformed: 2, unsupported_entry: 1 } },
    });
    memory.close();

    // Complete the partial object with a supported version; it is still malformed because
    // timestamp/cwd are absent, so it is skipped rather than becoming a format gap.
    appendFileSync(t.path, 'ten"},"uuid":"00000000-0000-4000-8000-000000000305","version":"2.1.281"}\n');
    appendFileSync(t.path, JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-000000000306", timestamp: "2026-09-23T08:00:04.000Z", cwd: repo, sessionId: t.sessionId, version: "2.1.281", message: { role: "user", content: "A complete zebracorn message after the partial one." } }) + "\n");
    const again = open(repo, e);
    const boot = again.bootstrap();
    expect(boot.import.currentProject?.counters).toMatchObject({ records: 3, excluded: { malformed: 3 } });
    expect(again.recall({ query: "zebracorn" }).items).toHaveLength(1);
  });

  test("a batch that fails before its cursor update commits nothing; the next bootstrap imports it exactly once", () => {
    // (Expected failures such as storage_busy are reported as import.problem instead; see the unreadable-consent test.)
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "none" });
    const dbPath = memory.status().storage.dbPath ?? "";
    const raw = new Database(dbPath);
    raw.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON import_cursors BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");

    // A failure that is not an expected storage condition is a bug: it propagates, after rolling back.
    expect(() => memory.bootstrap({ importChoice: "current_project" })).toThrow(/injected failure/);
    expect(memory.status().import?.currentProject).toMatchObject({ pending: 1, complete: 0 });
    expect(memory.status().counts?.records).toBe(0);
    expect(raw.prepare("SELECT count(*) AS n FROM import_cursors").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 0 });

    raw.exec("DROP TRIGGER fail_cursor");
    raw.close();
    expect(memory.bootstrap().import).toMatchObject({ problem: null, currentProject: { complete: 1, counters: { records: 7 } } });
    expect(memory.status().counts?.records).toBe(7);
  });
});

describe("review regressions", () => {
  test("a transcript that moves into a worktree nested inside its own is quarantined, not filed under the outer workstream", () => {
    const e = env();
    const repo = initRepo();
    const nested = `${repo}/.claude/worktrees/side`;
    git(repo, "worktree", "add", "--quiet", "-b", "side", nested);
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const content = renderFixture("2.1.281/branches.jsonl", { cwd: repo, sessionId }) + renderFixture("2.1.281/compaction.jsonl", { cwd: nested, sessionId });
    installTranscript(e.config, "", { cwd: repo, sessionId, content });

    const memory = open(repo, e);
    const boot = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.import.gaps).toEqual([expect.objectContaining({ reason: "scope_ambiguous", cwd: nested })]);
    expect(visibleText(memory)).not.toMatch(/outbox migration/);
  });

  test("the output of a tool call that could not be read is withheld (privacy fails closed)", () => {
    const e = env();
    const repo = initRepo();
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const lines = renderFixture("2.1.281/large-and-sensitive.jsonl", { cwd: repo, sessionId }).split("\n");
    lines[3] = '{"broken tool_use line'; // the `cat .env` call is unreadable
    installTranscript(e.config, "", { cwd: repo, sessionId, content: lines.join("\n") });

    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "current_project" });
    const result = memory.recall({ query: "withheld" }).items.find((i) => i.title?.startsWith("Tool"));
    expect(result?.excerpt).toMatch(/output withheld by Memchor/);
    expect(visibleText(memory)).not.toMatch(/SYNTHETIC-DOTENV/);
  });

  test("consent counts separate transcripts written by versions Memchor cannot read", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const sessionId = "66666666-6666-4666-8666-666666666666";
    installTranscript(e.config, "", { cwd: repo, sessionId, content: renderFixture("unknown-version.jsonl", { cwd: repo, sessionId }).replace('"version":"2.1.281"', '"version":"3.0.0"') });
    const boot = open(repo, e).bootstrap();
    expect(boot.import.transcripts).toMatchObject({ found: 2, currentProject: 2, unsupportedVersion: 1 });
    expect(boot.import.question).toMatch(/1 written by a Claude Code version Memchor cannot read yet/);
  });
});

describe("backfill gaps", () => {
  test("gaps met while backfilling another project are reported in this session's status", () => {
    const e = env();
    const repo = initRepo();
    const other = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    const bad = installTranscript(e.config, "unknown-version.jsonl", { cwd: other });
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "all" });
    expect(memory.status().import?.gaps).toEqual([]);
    memory.continueImport({ maxMs: 5_000 });
    expect(memory.status().import?.gaps).toEqual([expect.objectContaining({ transcriptId: bad.sessionId, reason: "unsupported_version", workspace: expect.any(String) as string })]);
  });
});

describe("expected import failures", () => {
  test("an unreadable consent file is reported as a problem; bootstrap, recall and status keep working and nothing is imported", () => {
    const e = env();
    const repo = initRepo();
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo });
    mkdirSync(e.home, { recursive: true });
    writeFileSync(`${e.home}/consent.json`, "{ not json");
    const memory = open(repo, e);
    const boot = memory.bootstrap();
    expect(boot.import).toMatchObject({ state: "unavailable", problem: { code: "storage_unavailable" } });
    expect(boot.context.empty).toBe(true);
    const status = memory.status();
    expect(status.counts?.records).toBe(0);
    expect(status.import?.problem?.code).toBe("storage_unavailable");
    expect(memory.bootstrap({ importChoice: "all" }).import.problem?.code).toBe("storage_unavailable");
    expect(memory.status().counts?.records).toBe(0);
    expect(readFileSync(`${e.home}/consent.json`, "utf8")).toBe("{ not json"); // left untouched
  });
});
