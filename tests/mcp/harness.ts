import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { onCleanup } from "../helpers.js";

export const CLI = resolve(import.meta.dirname, "../../dist/cli.js");

export interface ToolOutcome {
  isError: boolean;
  structured: Record<string, unknown>;
  text: string;
}

export interface ServerHandle {
  client: Client;
  pid: number;
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Result of a call that must succeed. */
  ok<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export const NO_NETWORK = resolve(import.meta.dirname, "no-network.mjs");

/**
 * Spawns `node dist/cli.js mcp` in `cwd` with an isolated MEMCHOR_HOME (and, if given, an
 * isolated Claude config dir) and connects an SDK client. `networkLog` preloads a guard that
 * records and refuses every network attempt.
 */
export async function spawnServer(options: {
  cwd: string;
  home: string;
  host?: string;
  clientName?: string;
  claudeConfigDir?: string;
  networkLog?: string;
}): Promise<ServerHandle> {
  const args = [...(options.networkLog === undefined ? [] : ["--import", NO_NETWORK]), CLI, "mcp", ...(options.host === undefined ? [] : ["--host", options.host])];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: options.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MEMCHOR_HOME: options.home,
      // Never let a spawned server read the developer's real transcripts.
      CLAUDE_CONFIG_DIR: options.claudeConfigDir ?? resolve(options.home, "no-claude-config"),
      ...(options.networkLog === undefined ? {} : { MEMCHOR_NETWORK_LOG: options.networkLog }),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: options.clientName ?? "memchor-test", version: "0.0.0" });
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error("server did not start");

  const call = async (name: string, callArgs: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const result = await client.callTool({ name, arguments: callArgs });
    const content = result.content as { type: string; text?: string }[];
    return {
      isError: result.isError === true,
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
      text: content.find((c) => c.type === "text")?.text ?? "",
    };
  };
  const handle: ServerHandle = {
    client,
    pid,
    call,
    ok: async <T,>(name: string, callArgs: Record<string, unknown> = {}): Promise<T> => {
      const outcome = await call(name, callArgs);
      if (outcome.isError) throw new Error(`${name} failed: ${outcome.text}`);
      return outcome.structured as T;
    },
    close: () => client.close(),
  };
  onCleanup(() => {
    void client.close();
  });
  return handle;
}
