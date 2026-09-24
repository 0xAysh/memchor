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
