import { spawn, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { codexHome, installCodexRollout } from "../import/fixtures.js";
import { CLI, spawnServer } from "./harness.js";

function memchor(cwd: string, home: string, ...args: string[]) {
  return memchorWith({}, cwd, home, ...args);
}

function memchorWith(env: Record<string, string>, cwd: string, home: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "", CODEX_HOME: process.env["CODEX_HOME"] ?? "", ...env },
    encoding: "utf8",
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("memchor CLI", () => {
  test("diag commands inspect the same memory the MCP server wrote", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await spawnServer({ cwd: repo, home, host: "codex" });
    await server.ok("memory_record", { kind: "decision", title: "Use WAL", body: "Share one SQLite file across processes via WAL.", attribution: "user_direction" });
    await server.ok("memory_checkpoint", { expectedRevision: 0, goal: "storage", status: "decided" });
    await server.close();

    const status = memchor(repo, home, "diag", "status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ runtime: { supported: true }, counts: { records: 2, checkpoints: 1 } });

    const records = memchor(repo, home, "diag", "records");
    expect(records.code).toBe(0);
    expect(records.stdout).toMatch(/checkpoint r1/);
    expect(records.stdout).toMatch(/decision {2}user_direction {2}unreviewed {2}Use WAL/);

    expect(JSON.parse(memchor(repo, home, "diag", "reindex").stdout)).toEqual({ records: 2, chunks: 4 });
    const integrity = memchor(repo, home, "diag", "integrity");
    expect(integrity.code).toBe(0);
    expect(JSON.parse(integrity.stdout)).toMatchObject({ exists: true, schemaVersion: 4, ok: true, sqlite: ["ok"], searchIndex: "ok", foreignKeyViolations: 0 });
  });

  test("diag status is read-only: the first real bootstrap afterwards still creates the workstream", async () => {
    const repo = initRepo();
    const home = tempDir();
    const status = memchor(repo, home, "diag", "status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ scope: { workstreamId: null }, storage: { schemaVersion: null } });
    const integrity = memchor(repo, home, "diag", "integrity");
    expect(JSON.parse(integrity.stdout)).toMatchObject({ exists: false });

    const server = await spawnServer({ cwd: repo, home, host: "codex" });
    expect(await server.ok("memory_bootstrap")).toMatchObject({ created: { workspace: true, workstream: true } });
  });

  test("diag consent and diag import manage Codex history with --host codex, reading $CODEX_HOME", () => {
    const repo = initRepo();
    const home = tempDir();
    const codex = codexHome();
    installCodexRollout(codex, "0.142.5/basic.jsonl", { cwd: repo });
    const env = { CODEX_HOME: codex };

    const asked = memchorWith(env, repo, home, "diag", "consent", "--host", "codex");
    expect(asked.code).toBe(0);
    expect(JSON.parse(asked.stdout)).toMatchObject({ consent: null, state: "consent_required", transcripts: { found: 1, currentProject: 1 }, transcriptsRoot: codex });
    expect(JSON.parse(memchorWith(env, repo, home, "diag", "consent", "--host", "codex", "--set", "current_project").stdout)).toMatchObject({ consent: { choice: "current_project" } });
    // Codex's decision is its own: Claude Code's is still unanswered.
    expect(JSON.parse(memchor(repo, home, "diag", "consent").stdout)).toMatchObject({ consent: null });

    const imported = memchorWith(env, repo, home, "diag", "import", "--host", "codex");
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ import: { host: "codex", state: "complete", problem: null, currentProject: { complete: 1, counters: { records: 8 } } } });
  });

  test("diag demo runs the tracer flow against MEMCHOR_HOME and prints the recalled pack", () => {
    const repo = initRepo();
    const home = tempDir();
    const first = memchor(repo, home, "diag", "demo");
    expect(first.code).toBe(0);
    const pack = JSON.parse(first.stdout) as { checkpoint: { revision: number; citations: unknown[] }; items: { kind: string; citations: unknown[] }[]; empty: boolean };
    expect(pack.empty).toBe(false);
    expect(pack.checkpoint.revision).toBe(1);
    expect(pack.checkpoint.citations).toHaveLength(2);
    expect(pack.items.find((item) => item.kind === "decision")?.citations).toHaveLength(1);
    expect(first.stderr).toContain(home);

    // Re-running publishes the next revision rather than conflicting.
    expect((JSON.parse(memchor(repo, home, "diag", "demo").stdout) as { checkpoint: { revision: number } }).checkpoint.revision).toBe(2);
  });

  test("errors are envelopes on stderr with a non-zero exit; usage errors exit 64", () => {
    const outside = memchor(tempDir("memchor-plain-"), tempDir(), "diag", "records");
    expect(outside.code).toBe(2);
    const [headline = "", ...envelope] = outside.stderr.split("\n");
    expect(headline).toMatch(/^memchor: Memchor could not resolve a Git worktree/);
    expect(JSON.parse(envelope.join("\n"))).toMatchObject({ error: { code: "scope_unresolved" } });
    expect(memchor(initRepo(), tempDir(), "mcp", "--host", "not-a-host").code).toBe(64);
    expect(memchor(initRepo(), tempDir(), "bogus").code).toBe(64);
  });

  test("transcript commands accept only a host whose transcripts Memchor can import", () => {
    const repo = initRepo();
    const home = tempDir();
    for (const host of ["bogus", "pi", "unknown"]) {
      for (const subcommand of ["consent", "import"]) {
        const run = memchor(repo, home, "diag", subcommand, "--host", host);
        expect(run.code).toBe(64);
        expect(run.stderr).toContain(`memchor: --host must be one of claude-code, codex (got ${host})`);
      }
    }
    const codex = memchor(repo, home, "diag", "consent", "--host", "codex");
    expect(codex.code).toBe(0);
    expect(JSON.parse(codex.stdout)).toMatchObject({ consent: null });
  });

  test("the MCP server closes and exits cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: tempDir(), CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "", CODEX_HOME: process.env["CODEX_HOME"] ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve) => child.stderr.on("data", (chunk: Buffer) => {
        if (/ready/.test(chunk.toString())) resolve();
      }));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });
});
