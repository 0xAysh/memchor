import { spawn, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { CLI, spawnServer } from "./harness.js";

function memchor(cwd: string, home: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: home },
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
    expect(JSON.parse(integrity.stdout)).toEqual({ ok: true, sqlite: ["ok"], searchIndex: "ok", foreignKeyViolations: 0 });
  });

  test("errors are envelopes on stderr with a non-zero exit; usage errors exit 64", () => {
    const outside = memchor(tempDir("memchor-plain-"), tempDir(), "diag", "records");
    expect(outside.code).toBe(2);
    expect(JSON.parse(outside.stderr)).toMatchObject({ error: { code: "scope_unresolved" } });
    expect(memchor(initRepo(), tempDir(), "mcp", "--host", "not-a-host").code).toBe(64);
    expect(memchor(initRepo(), tempDir(), "bogus").code).toBe(64);
  });

  test("the MCP server closes and exits cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: tempDir() },
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
