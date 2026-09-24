import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeAdapter } from "../../src/import/adapters/claude.js";
import { codexAdapter } from "../../src/import/adapters/codex.js";
import type { TranscriptAdapter } from "../../src/import/normalized-event.js";
import { inCompatibility } from "../../src/import/versions.js";
import { openMemory } from "../../src/memory.js";
import { tempDir } from "../helpers.js";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

/**
 * Validates the importer against the developer's real, unmodified Claude Code history:
 * the git-ignored local snapshot `.real-transcripts/claude` (`npm run snapshot:transcripts`),
 * or any config dir named by MEMCHOR_REAL_CLAUDE_DIR (e.g. ~/.claude, read in place).
 * Skipped where neither exists (a fresh clone, CI). Imports go only to a temporary
 * MEMCHOR_HOME; nothing from the history is ever committed.
 */
const REPO = resolve(import.meta.dirname, "../..");
const SNAPSHOT = join(REPO, ".real-transcripts", "claude");
const REAL = process.env["MEMCHOR_REAL_CLAUDE_DIR"] ?? (existsSync(join(SNAPSHOT, "projects")) ? SNAPSHOT : undefined);
const CODEX_SNAPSHOT = join(REPO, ".real-transcripts", "codex");
const REAL_CODEX = process.env["MEMCHOR_REAL_CODEX_HOME"] ?? (existsSync(join(CODEX_SNAPSHOT, "sessions")) || existsSync(join(CODEX_SNAPSHOT, "archived_sessions")) ? CODEX_SNAPSHOT : undefined);

interface Run {
  elapsedMs: number;
  afterBootstrapMs: number;
  peakRssMB: number;
  import: { state: string; problem: unknown; transcripts: Record<string, number>; backfill: unknown; gaps: { reason: string }[] };
}

function run(home: string, networkLog: string, ...args: string[]): Run {
  const out = spawnSync(process.execPath, ["--import", NO_NETWORK, CLI, ...args], {
    cwd: REPO,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: REAL ?? "", CODEX_HOME: REAL_CODEX ?? "", MEMCHOR_NETWORK_LOG: networkLog },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (out.status !== 0) throw new Error(`memchor ${args.join(" ")} exited ${String(out.status)}: ${out.stderr}`);
  return JSON.parse(out.stdout) as Run;
}

describe.skipIf(REAL === undefined)("real local Claude Code history (local snapshot or MEMCHOR_REAL_CLAUDE_DIR)", () => {
  test("every real transcript parses within the compatibility table with no malformed lines", () => {
    const adapter = claudeCodeAdapter({ configDir: REAL ?? "" });
    const files = adapter.discover();
    const excluded: Record<string, number> = {};
    let events = 0;
    const stops: string[] = [];
    for (const file of files) {
      for (let offset = 0; offset < file.size; ) {
        const chunk = adapter.read(file, offset, 4 << 20);
        events += chunk.events.length;
        for (const [k, v] of Object.entries(chunk.excluded)) excluded[k] = (excluded[k] ?? 0) + v;
        if (chunk.stop !== null) stops.push(`${file.transcriptId}: ${chunk.stop.hostVersion}`);
        if (chunk.stop !== null || chunk.end === offset) break;
        offset = chunk.end;
      }
    }
    process.stderr.write(`real history: ${files.length} transcripts, ${events} events, excluded ${JSON.stringify(excluded)}\n`);
    expect(stops).toEqual([]);
    expect(excluded["malformed"] ?? 0).toBe(0);
    expect(events).toBeGreaterThan(0);
  });

  test("all-projects import completes offline, and a replay imports nothing new", () => {
    const home = tempDir();
    const networkLog = join(tempDir(), "network.log");
    const consent = run(home, networkLog, "diag", "consent", "--set", "all");
    expect(consent.import).toBeUndefined(); // consent prints the decision, not the import
    const first = run(home, networkLog, "diag", "import");
    expect(first.import).toMatchObject({ state: "complete", problem: null });
    expect(first.import.gaps.filter((g) => g.reason === "unsupported_version")).toEqual([]);

    // Per-workspace totals, through the memory interface of each imported repository.
    const adapter = claudeCodeAdapter({ configDir: REAL ?? "" });
    const repos = new Set(adapter.discover().map((f) => adapter.inspect(f).cwd).filter((cwd): cwd is string => cwd !== null && existsSync(cwd)));
    const totals = { workspaces: new Set<string>(), records: 0, quarantined: 0, redactions: 0, fileContents: 0, clipped: 0, withheld: 0 };
    for (const cwd of repos) {
      const memory = openMemory({ cwd, home, host: "claude-code", claudeConfigDir: REAL ?? "" });
      try {
        const status = memory.status();
        const p = status.import?.currentProject;
        if (status.scope === null || p === null || p === undefined || totals.workspaces.has(status.scope.workspaceId)) continue;
        totals.workspaces.add(status.scope.workspaceId);
        totals.records += p.counters.records;
        totals.quarantined += p.quarantined;
        totals.redactions += p.counters.redactions;
        totals.fileContents += p.counters.fileContents;
        totals.clipped += p.counters.clipped;
        totals.withheld += p.counters.withheld;
      } finally {
        memory.close();
      }
    }
    process.stderr.write(
      `real import: ${first.elapsedMs} ms total (${first.afterBootstrapMs} ms to first context), peak RSS ${first.peakRssMB} MB, ` +
        `${totals.workspaces.size} workspaces, ${totals.records} records, ${totals.quarantined} quarantined, ` +
        `${totals.redactions} redactions, ${totals.fileContents} file contents dropped, ${totals.clipped} clipped, ${totals.withheld} withheld\n`,
    );
    expect(totals.records).toBeGreaterThan(0);

    const replay = run(home, networkLog, "diag", "import");
    expect(replay.import).toMatchObject({ state: "complete", problem: null });
    process.stderr.write(`real replay: ${replay.elapsedMs} ms\n`);
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  });
});

/** Reads every discovered transcript to its end or its stop; returns counts only (never content). */
function readEverything(adapter: TranscriptAdapter) {
  const files = adapter.discover();
  const excluded: Record<string, number> = {};
  const versions: Record<string, number> = {};
  const stops: { transcriptId: string; hostVersion: string }[] = [];
  let events = 0;
  for (const file of files) {
    const version = adapter.inspect(file).hostVersion ?? "none";
    versions[version] = (versions[version] ?? 0) + 1;
    for (let offset = 0; offset < file.size; ) {
      const chunk = adapter.read(file, offset, 4 << 20);
      events += chunk.events.length;
      for (const [k, v] of Object.entries(chunk.excluded)) excluded[k] = (excluded[k] ?? 0) + v;
      if (chunk.stop !== null) stops.push({ transcriptId: file.transcriptId, hostVersion: chunk.stop.hostVersion });
      if (chunk.stop !== null || chunk.end === offset) break;
      offset = chunk.end;
    }
  }
  return { files, excluded, versions, stops, events };
}

/** Per-workspace import totals through the memory interface of each imported repository. */
function codexTotals(home: string, repos: Set<string>) {
  const totals = { workspaces: new Set<string>(), records: 0, stopped: 0, quarantined: 0, echoes: 0, redactions: 0, withheld: 0 };
  for (const cwd of repos) {
    const memory = openMemory({ cwd, home, host: "codex", codexHome: REAL_CODEX ?? "" });
    try {
      const status = memory.status();
      const p = status.import?.currentProject;
      if (status.scope === null || p === null || p === undefined || totals.workspaces.has(status.scope.workspaceId)) continue;
      totals.workspaces.add(status.scope.workspaceId);
      totals.records += p.counters.records;
      totals.stopped += p.stopped;
      totals.quarantined += p.quarantined;
      totals.echoes += p.counters.echoes;
      totals.redactions += p.counters.redactions;
      totals.withheld += p.counters.withheld;
    } finally {
      memory.close();
    }
  }
  return totals;
}

describe.skipIf(REAL_CODEX === undefined)("real local Codex history (local snapshot or MEMCHOR_REAL_CODEX_HOME)", () => {
  test("every real rollout parses; only rollouts created outside the compatibility table stop, and none has malformed lines", () => {
    const adapter = codexAdapter({ codexHome: REAL_CODEX ?? "" });
    const { files, excluded, versions, stops, events } = readEverything(adapter);
    process.stderr.write(
      `real Codex history: ${files.length} rollouts (subagents excluded) by creator version ${JSON.stringify(versions)}, ${events} events, ` +
        `${stops.length} stopped (${[...new Set(stops.map((s) => s.hostVersion))].join(", ") || "none"}), excluded ${JSON.stringify(excluded)}\n`,
    );
    expect(files.length).toBeGreaterThan(0);
    for (const stop of stops) expect(inCompatibility(stop.hostVersion, adapter.compatibility)).toBe(false);
    expect(excluded["malformed"] ?? 0).toBe(0);
    expect(events).toBeGreaterThan(0);
  });

  test("all-projects import with --host codex completes offline, reports only unsupported-version gaps, and a replay imports nothing new", () => {
    const home = tempDir();
    const networkLog = join(tempDir(), "network.log");
    run(home, networkLog, "diag", "consent", "--host", "codex", "--set", "all");
    const first = run(home, networkLog, "diag", "import", "--host", "codex");
    expect(first.import).toMatchObject({ state: "complete", problem: null });
    const adapter = codexAdapter({ codexHome: REAL_CODEX ?? "" });
    for (const gap of first.import.gaps as { reason: string; hostVersion?: string }[]) {
      if (gap.reason === "unsupported_version") expect(inCompatibility(gap.hostVersion ?? "", adapter.compatibility)).toBe(false);
    }

    const repos = new Set(adapter.discover().map((f) => adapter.inspect(f).cwd).filter((cwd): cwd is string => cwd !== null && existsSync(cwd)));
    const totals = codexTotals(home, repos);
    process.stderr.write(
      `real Codex import: ${first.elapsedMs} ms total, peak RSS ${first.peakRssMB} MB, ${totals.workspaces.size} workspaces, ${totals.records} records, ` +
        `${totals.stopped} stopped, ${totals.quarantined} quarantined, ${totals.echoes} Memchor echoes, ${totals.redactions} redactions, ${totals.withheld} withheld, ` +
        `gaps ${JSON.stringify(first.import.gaps.map((g) => g.reason))}\n`,
    );
    expect(totals.records).toBeGreaterThan(0);

    const replay = run(home, networkLog, "diag", "import", "--host", "codex");
    expect(replay.import).toMatchObject({ state: "complete", problem: null });
    expect(codexTotals(home, repos).records).toBe(totals.records);
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  });
});
