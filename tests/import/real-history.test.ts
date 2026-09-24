import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeAdapter } from "../../src/import/adapters/claude.js";
import { openMemory } from "../../src/memory.js";
import { tempDir } from "../helpers.js";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

/**
 * Opt-in: validates the importer against the developer's real, unmodified Claude Code
 * history, read in place. Nothing from it is written anywhere but a temporary MEMCHOR_HOME,
 * and nothing is committed.
 *
 *   MEMCHOR_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts
 */
const REAL = process.env["MEMCHOR_REAL_CLAUDE_DIR"];
const REPO = resolve(import.meta.dirname, "../..");

interface Run {
  elapsedMs: number;
  afterBootstrapMs: number;
  peakRssMB: number;
  import: { state: string; problem: unknown; transcripts: Record<string, number>; backfill: unknown; gaps: { reason: string }[] };
}

function run(home: string, networkLog: string, ...args: string[]): Run {
  const out = spawnSync(process.execPath, ["--import", NO_NETWORK, CLI, ...args], {
    cwd: REPO,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: REAL ?? "", MEMCHOR_NETWORK_LOG: networkLog },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (out.status !== 0) throw new Error(`memchor ${args.join(" ")} exited ${String(out.status)}: ${out.stderr}`);
  return JSON.parse(out.stdout) as Run;
}

describe.skipIf(REAL === undefined)("real local Claude Code history (opt-in)", () => {
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
