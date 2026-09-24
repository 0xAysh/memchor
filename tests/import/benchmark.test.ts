import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/benchmark-synthetic-import.mjs");

describe("synthetic import benchmark command", () => {
  test("reports reproducible small and large scenarios as machine-readable JSON without timing thresholds", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--small-transcripts", "1", "--small-turns", "2", "--large-transcripts", "2", "--large-turns", "3"], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "" },
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { format: string; networkCalls: number; scenarios: { name: string; transcripts: number; events: number; records: number; elapsedMs: number; peakRssMB: number }[] };
    expect(report).toMatchObject({
      format: "memchor-synthetic-import-benchmark-v1",
      networkCalls: 0,
      scenarios: [
        { name: "small", transcripts: 1, events: 4, records: 4 },
        { name: "large", transcripts: 2, events: 12, records: 12 },
      ],
    });
    for (const scenario of report.scenarios) {
      expect(scenario.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(scenario.peakRssMB).toBeGreaterThan(0);
    }
  });
});
