import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { claudeConfigDir, installSyntheticHistory } from "../import/fixtures.js";
import { CLI } from "./harness.js";

interface ImportRun {
  import: { state: string; problem: unknown; currentProject: { complete: number; pending: number; counters: { records: number; replayed: number; conflicts: number } } };
}

function env(home: string, config: string): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: config };
}

function memchor(cwd: string, home: string, config: string, ...args: string[]): ImportRun {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(home, config), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`memchor ${args.join(" ")} exited ${String(run.status)}: ${run.stderr}`);
  return JSON.parse(run.stdout) as ImportRun;
}

function workspaceDb(home: string): string | null {
  const root = join(home, "workspaces");
  if (!existsSync(root)) return null;
  const [id] = (spawnSync("ls", [root], { encoding: "utf8" }).stdout.trim().split("\n"));
  return id === undefined || id === "" ? null : join(root, id, "memory.sqlite");
}

describe("interrupted import", () => {
  test("SIGKILL mid-import leaves no partial batch or advanced cursor; the resumed import equals a clean one", async () => {
    const repo = initRepo();
    const config = claudeConfigDir();
    installSyntheticHistory(config, repo, { transcripts: 8, turns: 150 }); // 8,400 records
    const expected = 8 * 150 * 7;

    // Killed run: consent triggers the bootstrap import; SIGKILL it once batches are committing.
    const killedHome = tempDir();
    const child = spawn(process.execPath, [CLI, "diag", "consent", "--set", "current_project"], { cwd: repo, env: env(killedHome, config), stdio: "ignore" });
    let atKill = 0;
    for (let tries = 0; tries < 400 && atKill === 0; tries++) {
      await new Promise((r) => setTimeout(r, 10));
      // Timing only: peek at the committed record count to kill while batches are landing.
      const path = workspaceDb(killedHome);
      if (path === null || !existsSync(path)) continue;
      try {
        const peek = new Database(path, { readonly: true, fileMustExist: true });
        atKill = (peek.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n;
        peek.close();
      } catch {
        // Not migrated yet.
      }
    }
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(atKill).toBeGreaterThan(0);
    expect(atKill).toBeLessThan(expected);

    const resumed = memchor(repo, killedHome, config, "diag", "import");
    const clean = (() => {
      const home = tempDir();
      memchor(repo, home, config, "diag", "consent", "--set", "current_project");
      return memchor(repo, home, config, "diag", "import");
    })();

    for (const run of [resumed, clean]) {
      expect(run.import).toMatchObject({ state: "complete", problem: null, currentProject: { complete: 8, pending: 0 } });
      // No committed event was read twice (replayed = 0) and none was skipped (records = total).
      expect(run.import.currentProject.counters).toMatchObject({ records: expected, replayed: 0, conflicts: 0 });
    }
  });
});
