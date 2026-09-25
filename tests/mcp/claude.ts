import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { onCleanup, tempDir } from "../helpers.js";
import { CLI, NO_NETWORK } from "./harness.js";

/**
 * Drives the real Claude Code CLI for connection tests: `claude mcp add|list|get` and a
 * `claude -p` session, with HOME and CLAUDE_CONFIG_DIR in temporary directories and a localhost
 * stub of the Messages API, so no account, model or internet is involved. Claude Code (a native
 * binary) is not covered by the Node no-network preload; only the Memchor processes it starts are.
 * On macOS every Claude process also runs under a sandbox profile that denies the developer's real
 * Claude config, caches and Memchor home, and every outbound connection except to localhost.
 */

/** The Claude Code release these tests pin (native install, 2026-09). */
export const CLAUDE_PINNED_VERSION = "2.1.282";
export const CLAUDE_BIN = process.env["MEMCHOR_TEST_CLAUDE_BIN"] ?? onPath("claude") ?? join(homedir(), ".local/bin/claude");

function onPath(name: string): string | undefined {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
}

export interface ClaudeSandbox {
  home: string;
  configDir: string;
}

export function claudeSandbox(): ClaudeSandbox {
  return { home: tempDir("memchor-claude-home-"), configDir: tempDir("memchor-claude-config-") };
}

/**
 * The environment Claude itself runs with. Claude Code passes its own environment on to the MCP
 * servers it starts, so this is also what Memchor inherits (plus the `-e` pairs).
 */
export function claudeEnv(sandbox: ClaudeSandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: sandbox.home,
    CLAUDE_CONFIG_DIR: sandbox.configDir,
    TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    LANG: "C.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  };
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Real paths a Claude process must neither read nor write, and no network beyond localhost. */
function guardProfile(): string {
  const home = homedir();
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = [join(home, ".claude"), join(home, "Library/Caches/claude-cli-nodejs"), join(home, ".cache/claude-cli-nodejs"), join(home, ".memchor")];
  return [
    "(version 1)(allow default)",
    `(deny file-read* file-write* (regex #"^${escaped}/\\.claude\\.json") ${paths.map((p) => `(subpath "${p}")`).join(" ")})`,
    '(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))',
  ].join("");
}

function command(args: string[]): [string, string[]] {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, ["-p", guardProfile(), CLAUDE_BIN, ...args]] : [CLAUDE_BIN, args];
}

/** Null when the pinned binary is available; otherwise why the Claude Code tests are skipped. */
export function claudeSkipReason(): string | null {
  if (!existsSync(CLAUDE_BIN)) return `no Claude Code binary at ${CLAUDE_BIN} (set MEMCHOR_TEST_CLAUDE_BIN)`;
  // Runs at collection time, outside any test, so it cleans up after itself.
  const scratch = mkdtempSync(join(tmpdir(), "memchor-claude-version-"));
  const run = spawnSync(CLAUDE_BIN, ["--version"], { env: claudeEnv({ home: scratch, configDir: scratch }), encoding: "utf8", timeout: 20_000 });
  rmSync(scratch, { recursive: true, force: true });
  const version = /^(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1];
  if (version !== CLAUDE_PINNED_VERSION) return `${CLAUDE_BIN} is Claude Code ${version ?? "unknown"}; these tests pin ${CLAUDE_PINNED_VERSION}`;
  return null;
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function claude(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Run {
  const [bin, argv] = command(args);
  const run = spawnSync(bin, argv, { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Asynchronous, so a stub server in this process can answer while Claude runs. */
export function claudeAsync(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<Run> {
  const [bin, argv] = command(args);
  const options: SpawnOptions = { cwd, env, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(bin, argv, options);
  onCleanup(() => {
    child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** The command `claude mcp add` registers: Memchor from this checkout's dist, with the no-network guard preloaded. */
export const MEMCHOR_COMMAND = [process.execPath, "--import", NO_NETWORK, CLI, "mcp", "--host", "claude-code"];

/**
 * `claude mcp add` for Memchor in user scope. Claude Code would pass its own environment on
 * anyway; `-e` pins MEMCHOR_HOME whatever the environment Claude is started from.
 */
export function memchorAddArgs(options: { memchorHome: string; networkLog: string }): string[] {
  return ["mcp", "add", "memchor", "-s", "user", "-e", `MEMCHOR_HOME=${options.memchorHome}`, "-e", `MEMCHOR_NETWORK_LOG=${options.networkLog}`, "--", ...MEMCHOR_COMMAND];
}

/** Every line Claude Code logged for one MCP server (its stderr included), from the sandbox's cache. */
export function mcpServerLog(sandbox: ClaudeSandbox, server: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === `mcp-logs-${server}`) for (const file of readdirSync(full)) found.push(readFileSync(join(full, file), "utf8"));
      else walk(full);
    }
  };
  walk(sandbox.home);
  return found.join("");
}

export interface StubToolUse {
  /** Tool name inside the Memchor namespace, e.g. "memory_bootstrap". */
  tool: string;
  input: Record<string, unknown>;
}

/**
 * A localhost Messages API: while Memchor calls remain queued, each request that offers Memchor's
 * tools is answered with the next one as a `tool_use` (Claude Code names them
 * `mcp__memchor__<tool>`); once the queue is empty, and for any request without them, with a
 * plain assistant message that ends the turn.
 */
export async function startStubMessages(script: { calls: StubToolUse[]; reply: string }): Promise<{ port: number; offeredTools: string[][] }> {
  const state = { port: 0, offeredTools: [] as string[][] };
  const queue = [...script.calls];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      n++;
      if (req.method !== "POST" || req.url?.startsWith("/v1/messages?") !== true) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const json = JSON.parse(body) as { model?: string; stream?: boolean; tools?: { name: string }[] };
      const tools = (json.tools ?? []).map((t) => t.name);
      state.offeredTools.push(tools);
      const next = queue[0] !== undefined && tools.includes(`mcp__memchor__${queue[0].tool}`) ? queue.shift() : undefined;
      const usage = { input_tokens: 1, output_tokens: 1 };
      const stop = next === undefined ? "end_turn" : "tool_use";
      const block =
        next === undefined
          ? { type: "text", text: script.reply }
          : { type: "tool_use", id: `toolu_stub_${n}`, name: `mcp__memchor__${next.tool}`, input: next.input };
      if (json.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_stub_${n}`, type: "message", role: "assistant", model: json.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>): boolean => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: `msg_stub_${n}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (next === undefined) {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: script.reply } });
      } else {
        send("content_block_start", { index: 0, content_block: { ...block, input: {} } });
        send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(next.input) } });
      }
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  state.port = typeof address === "object" && address !== null ? address.port : 0;
  onCleanup(() => {
    server.close();
  });
  return state;
}

/** Tool calls and results a Claude Code session transcript recorded, in order. */
export function sessionToolTraffic(sandbox: ClaudeSandbox, sessionId: string): { uses: string[]; results: string[] } {
  const projects = join(sandbox.configDir, "projects");
  const file = readdirSync(projects)
    .map((dir) => join(projects, dir, `${sessionId}.jsonl`))
    .find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`no transcript for session ${sessionId}`);
  const uses: string[] = [];
  const results: string[] = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type: string; name?: string; content?: unknown }[]) {
      if (block.type === "tool_use" && block.name !== undefined) uses.push(block.name);
      if (block.type === "tool_result") {
        const text = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join("") : String(block.content);
        results.push(text);
      }
    }
  }
  return { uses, results };
}
