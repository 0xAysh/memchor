import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { onCleanup } from "../helpers.js";
import { CLI, NO_NETWORK } from "./harness.js";

/**
 * Drives the real Codex CLI for connection tests: `codex mcp add|list|get` in a temporary
 * CODEX_HOME, `codex app-server` over stdio JSON-RPC, and a localhost stub of the Responses API
 * so a turn can run with no account, model or internet. Codex (a Rust binary) is not covered by
 * the Node no-network preload; only the Memchor processes it starts are.
 */

/** The Codex release these tests pin (bundled with the ChatGPT desktop app, 2026-08). */
export const CODEX_PINNED_VERSION = "0.148.0-alpha.21";
export const CODEX_BIN = process.env["MEMCHOR_TEST_CODEX_BIN"] ?? "/Applications/ChatGPT.app/Contents/Resources/codex";

/** Null when the pinned binary is available; otherwise why the Codex tests are skipped. */
export function codexSkipReason(): string | null {
  if (!existsSync(CODEX_BIN)) return `no Codex binary at ${CODEX_BIN} (set MEMCHOR_TEST_CODEX_BIN)`;
  const run = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf8", timeout: 20_000 });
  const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(run.stdout)?.[1];
  if (version !== CODEX_PINNED_VERSION) return `${CODEX_BIN} is codex-cli ${version ?? "unknown"}; these tests pin ${CODEX_PINNED_VERSION}`;
  return null;
}

/** The environment Codex itself runs with: an isolated CODEX_HOME (and HOME, so nothing of the developer's is read). */
export function codexEnv(codexHome: string, home: string): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: home, CODEX_HOME: codexHome, TMPDIR: process.env["TMPDIR"] ?? "/tmp", LANG: "C.UTF-8" };
}

export function codex(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(CODEX_BIN, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * The `codex mcp add` arguments that register Memchor. Codex starts MCP servers with a cleared
 * environment, so CODEX_HOME and MEMCHOR_HOME must be passed explicitly; the test also preloads
 * the no-network guard into the Memchor process.
 */
export function memchorAddArgs(options: { codexHome: string; memchorHome: string; networkLog: string }): string[] {
  return [
    "mcp",
    "add",
    "memchor",
    "--env",
    `CODEX_HOME=${options.codexHome}`,
    "--env",
    `MEMCHOR_HOME=${options.memchorHome}`,
    "--env",
    `MEMCHOR_NETWORK_LOG=${options.networkLog}`,
    "--",
    process.execPath,
    "--import",
    NO_NETWORK,
    CLI,
    "mcp",
    "--host",
    "codex",
  ];
}

/** Top-level keys must precede every table in TOML, so the stub provider is prepended to what `codex mcp add` wrote. */
export function useStubProvider(codexHome: string, port: number): void {
  const path = join(codexHome, "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(
    path,
    `model = "stub-model"\nmodel_provider = "stub"\n\n[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n\n${existing}`,
  );
}

export interface StubCall {
  /** Tool name inside the Memchor namespace, e.g. "memory_bootstrap". */
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * A localhost Responses API: for each turn, it first asks for the next queued Memchor call
 * (as a function_call in the `mcp__memchor` namespace Codex advertises), then answers with a
 * plain assistant message once the call's output is in the input.
 */
export async function startStubResponses(script: { calls: StubCall[]; reply: string }): Promise<{ port: number; requests: number }> {
  const state = { port: 0, requests: 0 };
  const queue = [...script.calls];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      state.requests++;
      if (req.method !== "POST" || req.url?.endsWith("/responses") !== true) {
        res.writeHead(404).end("{}");
        return;
      }
      const json = JSON.parse(body) as { input?: { type?: string }[]; tools?: { type?: string; name?: string }[] };
      const lastIsOutput = json.input?.at(-1)?.type === "function_call_output";
      const namespace = json.tools?.find((t) => t.type === "namespace" && t.name?.startsWith("mcp__memchor"))?.name;
      const next = !lastIsOutput && namespace !== undefined ? queue.shift() : undefined;
      const n = state.requests;
      const item =
        next === undefined
          ? { type: "message", id: `msg_stub_${n}`, role: "assistant", content: [{ type: "output_text", text: script.reply }] }
          : { type: "function_call", id: `fc_stub_${n}`, call_id: `call_stub_${n}`, namespace, name: next.tool, arguments: JSON.stringify(next.arguments) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>): boolean => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("response.created", { response: { id: `resp_${n}` } });
      send("response.output_item.done", { item });
      send("response.completed", { response: { id: `resp_${n}`, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
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

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** `codex app-server` over stdio JSON-RPC (one JSON object per line). */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private readonly waiters: { method: string; resolve: (message: RpcMessage) => void }[] = [];
  readonly stderr: string[] = [];

  constructor(env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(CODEX_BIN, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString()));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined && message.method === undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.id !== undefined) {
        // A request from Codex (an approval): the tests run with approvalPolicy "never", so this is unexpected; accept.
        this.child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "accept" } })}\n`);
      } else {
        const index = this.waiters.findIndex((w) => w.method === message.method);
        if (index >= 0) this.waiters.splice(index, 1)[0]?.resolve(message);
      }
    });
    onCleanup(() => {
      this.close();
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const reply = new Promise<RpcMessage>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const message = await reply;
    if (message.error !== undefined) throw new Error(`${method}: ${message.error.message}`);
    return message.result ?? {};
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  waitFor(method: string): Promise<RpcMessage> {
    return new Promise((resolve) => this.waiters.push({ method, resolve }));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "memchor-test", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }

  /** Starts a legacy-history thread in `cwd` and runs one turn to completion; returns the thread id and rollout path. */
  async runTurn(cwd: string, text: string): Promise<{ threadId: string; path: string }> {
    const started = await this.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
    const thread = started["thread"] as { id: string; path: string };
    const done = this.waitFor("turn/completed");
    await this.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
    await done;
    return { threadId: thread.id, path: thread.path };
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
