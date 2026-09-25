import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { RecordResult, StatusResult } from "../../src/memory.js";
import { initRepo, tempDir } from "../helpers.js";
import { CLI, spawnServer } from "./harness.js";

describe("MCP protocol surface", () => {
  test("lists the seven memory tools with strict JSON Schemas and agent instructions", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_bootstrap",
      "memory_checkpoint",
      "memory_manage",
      "memory_read",
      "memory_recall",
      "memory_record",
      "memory_status",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description?.length).toBeGreaterThan(20);
    }
    const record = tools.find((t) => t.name === "memory_record");
    expect(record?.inputSchema.required).toEqual(["kind", "body", "attribution"]);
    // One flat object (a top-level union is not a valid tool schema for every host); fields are checked per action.
    const manage = tools.find((t) => t.name === "memory_manage");
    expect(manage?.inputSchema.required).toEqual(["action"]);
    expect(Object.keys(manage?.inputSchema.properties ?? {})).toEqual(["v", "action", "recordId", "body", "reason", "attribution", "operationKey"]);
    expect(server.client.getInstructions()).toMatch(/memory_bootstrap first/);
  });

  test("the instructions fit Claude Code's 2048-character limit and keep every rule", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const instructions = server.client.getInstructions() ?? "";
    // Claude Code truncates server instructions beyond 2048 characters, dropping whatever comes last.
    expect(instructions.length).toBeLessThanOrEqual(2048);
    for (const rule of [
      /memory_bootstrap first/,
      /scope\.ambiguity/,
      /import\.question/,
      /historical observations/i,
      /stale.*unknown.*read the current file/is,
      /independentRoots/,
      /attribution/,
      /memory_manage/,
      /never re-record/i,
      /memory_checkpoint.*expectedRevision/s,
      /checkpoint_conflict.*never overwrite/is,
      /honest miss/i,
    ]) {
      expect(instructions).toMatch(rule);
    }
    await server.close();
  });

  test("a payload carrying workspaceId or cwd is an invalid_input envelope", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    await server.ok("memory_bootstrap");
    for (const [tool, args] of [
      ["memory_record", { kind: "note", body: "x", attribution: "agent_inference", workspaceId: "ws_0000000000000000" }],
      ["memory_recall", { cwd: "/" }],
      ["memory_bootstrap", { workstreamId: "wst_1" }],
    ] as const) {
      const outcome = await server.call(tool, args);
      expect(outcome.isError).toBe(true);
      expect(outcome.structured).toMatchObject({ error: { code: "invalid_input", retryable: false } });
      expect(JSON.parse(outcome.text)).toEqual(outcome.structured);
    }
    expect((await server.ok<StatusResult>("memory_status")).counts?.records).toBe(0);
  });

  test("replaying an operationKey through MCP returns the stored result", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const input = { kind: "note", body: "replay me", attribution: "agent_inference", operationKey: "mcp-op-1" };
    const first = await server.ok<RecordResult>("memory_record", input);
    const again = await server.ok<RecordResult>("memory_record", input);
    expect(again).toEqual({ ...first, replayed: true });
    const conflict = await server.call("memory_record", { ...input, body: "different" });
    expect(conflict.structured).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  test("an operationKey replays across a real server restart", async () => {
    const repo = initRepo();
    const home = tempDir();
    const input = { kind: "evidence", body: "survives restart", attribution: "direct_observation", operationKey: "restart-op" };
    const first = await spawnServer({ cwd: repo, home, host: "claude-code" });
    const original = await first.ok<RecordResult>("memory_record", input);
    process.kill(first.pid, "SIGKILL");

    const second = await spawnServer({ cwd: repo, home, host: "codex" });
    expect(await second.ok<RecordResult>("memory_record", input)).toEqual({ ...original, replayed: true });
    expect((await second.ok<StatusResult>("memory_status")).counts?.records).toBe(1);
    expect((await second.call("memory_record", { ...input, body: "changed" })).structured).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  test("host comes from --host, else the MCP client name", async () => {
    const repo = initRepo();
    const home = tempDir();
    const flagged = await spawnServer({ cwd: repo, home, host: "codex", clientName: "something-else" });
    expect((await flagged.ok<StatusResult>("memory_status")).scope?.host).toBe("codex");
    const unflagged = await spawnServer({ cwd: repo, home, clientName: "claude-code" });
    expect((await unflagged.ok<StatusResult>("memory_status")).scope?.host).toBe("claude-code");
  });

  test("outside a Git repository tools fail closed with scope_unresolved", async () => {
    const server = await spawnServer({ cwd: tempDir("memchor-plain-"), home: tempDir() });
    expect((await server.call("memory_bootstrap")).structured).toMatchObject({ error: { code: "scope_unresolved" } });
    expect((await server.ok<StatusResult>("memory_status")).problem?.code).toBe("scope_unresolved");
  });

  test("stdout carries only JSON-RPC, logs go to stderr, and the process exits cleanly when stdin ends", async () => {
    const child = spawn(process.execPath, [CLI, "mcp", "--host", "pi"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MEMCHOR_HOME: tempDir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

    const send = (message: object): void => {
      child.stdin.write(JSON.stringify(message) + "\n");
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_bootstrap", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_record", arguments: { kind: "note" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
    for (let i = 0; i < 400 && stdout.split("\n").filter(Boolean).length < 4; i++) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();

    expect(await exited).toBe(0);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const messages = lines.map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result?: { isError?: boolean }; error?: unknown });
    for (const message of messages) expect(message.jsonrpc).toBe("2.0");
    expect(messages.find((m) => m.id === 2)?.result?.isError).toBeUndefined();
    expect(messages.find((m) => m.id === 3)?.result?.isError).toBe(true);
    expect(messages.find((m) => m.id === 4)?.error).toBeDefined();
    expect(stderr).toMatch(/memchor: MCP server ready/);
  });
});
