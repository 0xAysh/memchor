#!/usr/bin/env node
/**
 * Deterministic, sanitized import workload for issue #19 performance evidence.
 * Generates local JSONL only, imports through the public Memory API, performs no
 * network/model calls, and prints one machine-readable JSON report. Timings are
 * observations, never pass/fail thresholds.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../dist/memory.js";

const defaults = {
  smallTranscripts: 2,
  smallTurns: 100,
  largeTranscripts: 20,
  largeTurns: 500,
};
const options = parseOptions(process.argv.slice(2), defaults);
const root = mkdtempSync(join(tmpdir(), "memchor-import-benchmark-"));
try {
  const scenarios = [
    runScenario("small", options.smallTranscripts, options.smallTurns),
    runScenario("large", options.largeTranscripts, options.largeTurns),
  ];
  process.stdout.write(JSON.stringify({ format: "memchor-synthetic-import-benchmark-v1", networkCalls: 0, scenarios }, null, 2) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runScenario(name, transcripts, turns) {
  const scenarioRoot = join(root, name);
  const repo = join(scenarioRoot, "repo");
  const config = join(scenarioRoot, "claude");
  const home = join(scenarioRoot, "memchor");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "benchmark@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Memchor Benchmark"]);
  writeFileSync(join(repo, "README.md"), "synthetic benchmark repository\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "benchmark fixture"]);

  const project = join(config, "projects", "synthetic");
  mkdirSync(project, { recursive: true });
  for (let transcript = 0; transcript < transcripts; transcript++) {
    const lines = [];
    for (let turn = 0; turn < turns; turn++) {
      const sequence = transcript * turns + turn;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60, Math.floor(sequence / 60) % 1000)).toISOString();
      const common = { timestamp, cwd: repo, sessionId: `synthetic-${transcript}`, version: "2.1.281", gitBranch: "main" };
      lines.push(JSON.stringify({ ...common, type: "user", uuid: `user-${transcript}-${turn}`, origin: { kind: "human" }, message: { content: `Sanitized request ${transcript}/${turn}: verify deterministic import behavior.` } }));
      lines.push(JSON.stringify({ ...common, type: "assistant", uuid: `assistant-${transcript}-${turn}`, message: { content: [{ type: "text", text: `Sanitized observation ${transcript}/${turn}: deterministic import completed.` }] } }));
    }
    writeFileSync(join(project, `synthetic-${transcript}.jsonl`), lines.join("\n") + "\n");
  }

  const beforeRss = process.memoryUsage().rss;
  const started = performance.now();
  const memory = openMemory({ cwd: repo, host: "claude-code", home, claudeConfigDir: config, importBudgetMs: 250 });
  let status;
  let dbPath;
  try {
    status = memory.bootstrap({ importChoice: "current_project" }).import;
    while (status.state === "in_progress" && status.problem === null) status = memory.continueImport({ maxMs: 1_000 });
    dbPath = memory.status().storage.dbPath ?? "";
  } finally {
    memory.close();
  }
  const elapsedMs = Math.round(performance.now() - started);
  // Node reports resourceUsage().maxRSS in KiB on every supported platform.
  const maxRss = process.resourceUsage().maxRSS * 1024;
  const counters = status.currentProject?.counters;
  if (status.problem !== null || status.state !== "complete" || counters === null || counters === undefined) {
    throw new Error(`synthetic ${name} import did not complete: ${JSON.stringify(status.problem ?? status.state)}`);
  }
  return {
    name,
    transcripts,
    turns,
    events: counters.events,
    records: counters.records,
    elapsedMs,
    rssDeltaMB: roundMB(Math.max(0, process.memoryUsage().rss - beforeRss)),
    peakRssMB: roundMB(maxRss),
    databaseBytes: statSync(dbPath).size,
  };
}

function roundMB(bytes) {
  return Math.round((bytes / 1_000_000) * 10) / 10;
}

function parseOptions(args, initial) {
  const map = {
    "--small-transcripts": "smallTranscripts",
    "--small-turns": "smallTurns",
    "--large-transcripts": "largeTranscripts",
    "--large-turns": "largeTurns",
  };
  const out = { ...initial };
  for (let index = 0; index < args.length; index += 2) {
    const key = map[args[index]];
    const value = Number(args[index + 1]);
    if (key === undefined || !Number.isSafeInteger(value) || value < 1) {
      process.stderr.write("usage: benchmark-synthetic-import.mjs [--small-transcripts N] [--small-turns N] [--large-transcripts N] [--large-turns N]\n");
      process.exit(64);
    }
    out[key] = value;
  }
  return out;
}
