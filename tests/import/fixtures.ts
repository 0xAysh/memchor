import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/claude-code");

/** A fresh stand-in for `$CLAUDE_CONFIG_DIR` (transcripts live under its `projects/`). */
export function claudeConfigDir(): string {
  return tempDir("memchor-claude-");
}

/** Claude Code's project directory name: the cwd with every non-alphanumeric character replaced by "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface InstalledTranscript {
  sessionId: string;
  path: string;
}

/** Generated content for `large-and-sensitive.jsonl` (kept out of the file so the fixture stays small). */
const GENERATED: Record<string, string> = {
  "{{LARGE_MESSAGE}}": "log line with detail ".repeat(1_000),
  "{{LARGE_OUTPUT}}": "compiling module ".repeat(12_000),
};

/** The fixture's text with its placeholders filled in. */
export function renderFixture(fixture: string, vars: { cwd: string; sessionId: string }): string {
  let text = readFileSync(join(FIXTURES, fixture), "utf8").replaceAll("{{CWD}}", vars.cwd).replaceAll("{{SESSION}}", vars.sessionId);
  for (const [placeholder, value] of Object.entries(GENERATED)) text = text.replaceAll(placeholder, value);
  return text;
}

/** Writes a rendered fixture where Claude Code would keep the transcript of a session started in `cwd`. */
export function installTranscript(configDir: string, fixture: string, options: { cwd: string; sessionId?: string; content?: string }): InstalledTranscript {
  const sessionId = options.sessionId ?? randomUUID();
  const dir = join(configDir, "projects", projectDirName(options.cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, options.content ?? renderFixture(fixture, { cwd: options.cwd, sessionId }));
  return { sessionId, path };
}

/**
 * A synthetic history for load and interruption tests: `transcripts` sessions, each the
 * `basic.jsonl` conversation repeated `turns` times with unique event and tool ids (7 records
 * per turn).
 */
export function installSyntheticHistory(configDir: string, cwd: string, options: { transcripts: number; turns: number }): InstalledTranscript[] {
  const installed: InstalledTranscript[] = [];
  for (let t = 0; t < options.transcripts; t++) {
    const sessionId = randomUUID();
    const base = renderFixture("2.1.281/basic.jsonl", { cwd, sessionId });
    const turns: string[] = [];
    for (let turn = 0; turn < options.turns; turn++) {
      const prefix = (turn + 1).toString(16).padStart(8, "0");
      turns.push(base.replace(/00000000-0000-4000-8000-(\d{12})/g, `${prefix}-0000-4000-8000-$1`).replace(/toolu_(\d{4})/g, `toolu_${turn}_$1`));
    }
    installed.push(installTranscript(configDir, "", { cwd, sessionId, content: turns.join("") }));
  }
  return installed;
}

// ── Codex ──

const CODEX_FIXTURES = resolve(import.meta.dirname, "fixtures/codex");

/** A fresh stand-in for `$CODEX_HOME` (rollouts live under its `sessions/` and `archived_sessions/`). */
export function codexHome(): string {
  return tempDir("memchor-codex-");
}

/** A UUIDv7-shaped thread id, like the ones Codex generates. */
export function codexThreadId(): string {
  const hex = randomUUID().replaceAll("-", "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CodexVars {
  cwd: string;
  threadId: string;
  cwd2?: string;
  parentId?: string;
  workstreamId?: string;
  recordId?: string;
}

/** The Codex fixture's text with its placeholders filled in. */
export function renderCodexFixture(fixture: string, vars: CodexVars): string {
  let text = readFileSync(join(CODEX_FIXTURES, fixture), "utf8")
    .replaceAll("{{CWD2}}", vars.cwd2 ?? `${vars.cwd}-elsewhere`)
    .replaceAll("{{CWD}}", vars.cwd)
    .replaceAll("{{THREAD}}", vars.threadId)
    .replaceAll("{{PARENT}}", vars.parentId ?? "01900000-0000-7000-8000-00000000beef")
    .replaceAll("{{SHA}}", "0123456789abcdef0123456789abcdef01234567")
    .replaceAll("{{WORKSTREAM}}", vars.workstreamId ?? "wst_00000000000000000000000000000000")
    .replaceAll("{{RECORD}}", vars.recordId ?? "rec_00000000000000000000000000000000");
  for (const [placeholder, value] of Object.entries(GENERATED)) text = text.replaceAll(placeholder, value);
  return text;
}

/**
 * A synthetic Codex history for load and interruption tests: `transcripts` rollouts, each the
 * `0.142.5/basic.jsonl` thread (one session_meta) followed by its turn repeated `turns` times with
 * unique call and item ids (8 records per turn; event ids are byte offsets, so already unique).
 */
export function installSyntheticCodexHistory(home: string, cwd: string, options: { transcripts: number; turns: number }): InstalledTranscript[] {
  const installed: InstalledTranscript[] = [];
  for (let t = 0; t < options.transcripts; t++) {
    const threadId = codexThreadId();
    const [meta = "", ...body] = renderCodexFixture("0.142.5/basic.jsonl", { cwd, threadId }).split(/(?<=\n)/);
    const turns: string[] = [meta];
    for (let turn = 0; turn < options.turns; turn++) turns.push(body.join("").replace(/(call|ws|msg|rs)_(\d{4})/g, `$1_${turn}_$2`));
    installed.push(installCodexRollout(home, "", { cwd, threadId, content: turns.join("") }));
  }
  return installed;
}

/**
 * Writes a rendered fixture where Codex keeps a thread's rollout:
 * `sessions/2026/01/01/rollout-2026-01-01T00-00-00-<thread>.jsonl`, or flat under
 * `archived_sessions/` once archived.
 */
export function installCodexRollout(
  home: string,
  fixture: string,
  options: Omit<CodexVars, "threadId"> & { threadId?: string; archived?: boolean; content?: string },
): InstalledTranscript {
  const threadId = options.threadId ?? codexThreadId();
  const dir = options.archived === true ? join(home, "archived_sessions") : join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
  writeFileSync(path, options.content ?? renderCodexFixture(fixture, { ...options, threadId }));
  return { sessionId: threadId, path };
}
