import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type BootstrapResult } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { CLI, NO_NETWORK } from "./harness.js";
import { CODEX_PINNED_VERSION, codex, CodexAppServer, codexEnv, codexSkipReason, memchorAddArgs, startStubResponses, useStubProvider } from "./codex.js";

const SKIP = codexSkipReason();
if (SKIP !== null) process.stderr.write(`codex connection tests skipped: ${SKIP}\n`);

const TOOLS = ["memory_bootstrap", "memory_checkpoint", "memory_manage", "memory_read", "memory_recall", "memory_record", "memory_status"];

function setup() {
  const codexHome = tempDir("memchor-codex-home-");
  const memchorHome = tempDir();
  const networkLog = join(tempDir(), "network.log");
  const env = codexEnv(codexHome, tempDir("memchor-codex-user-"));
  const added = codex(env, tempDir(), ...memchorAddArgs({ codexHome, memchorHome, networkLog }));
  expect(added.code, added.stderr).toBe(0);
  return { codexHome, memchorHome, networkLog, env, added };
}

describe.skipIf(SKIP !== null)(`real Codex ${CODEX_PINNED_VERSION} connection`, () => {
  test("codex mcp add registers memchor with its arguments and explicit env; list and get show it", () => {
    const { env, codexHome, memchorHome, added } = setup();
    expect(added.stdout).toContain("Added global MCP server 'memchor'.");

    const list = JSON.parse(codex(env, tempDir(), "mcp", "list", "--json").stdout) as Record<string, unknown>[];
    expect(list).toEqual([
      expect.objectContaining({
        name: "memchor",
        enabled: true,
        transport: expect.objectContaining({
          type: "stdio",
          command: process.execPath,
          args: ["--import", NO_NETWORK, CLI, "mcp", "--host", "codex"],
          env: expect.objectContaining({ CODEX_HOME: codexHome, MEMCHOR_HOME: memchorHome }) as unknown,
          cwd: null,
        }) as unknown,
      }),
    ]);
    const get = codex(env, tempDir(), "mcp", "get", "memchor", "--json");
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({ name: "memchor", transport: { type: "stdio", command: process.execPath } });
    expect(codex(env, tempDir(), "mcp", "get", "missing").code).not.toBe(0);
  });

  test("codex app-server starts memchor, completes the MCP handshake and lists all seven memory tools, with no network access from Memchor", async () => {
    const { env, networkLog } = setup();
    const repo = initRepo();
    // With no thread, Codex launches MCP servers in its own working directory.
    const server = new CodexAppServer(env, repo);
    await server.initialize();
    const status = await server.request("mcpServerStatus/list", {});
    const entries = status["data"] as { name: string; serverInfo?: { name?: string }; tools?: unknown }[];
    const memchor = entries.find((entry) => entry.name === "memchor");
    expect(memchor?.serverInfo?.name).toBe("memchor");
    const tools = memchor?.tools;
    const names = Array.isArray(tools) ? (tools as { name: string }[]).map((t) => t.name) : Object.keys(tools as object);
    expect(names.map((name) => name.replace(/^.*__/, "")).sort()).toEqual(TOOLS);
    server.close();
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  });

  test("a thread's memchor runs in the thread's cwd, and its legacy rollout imports into that workstream with the thread id as transcript id", async () => {
    const { env, codexHome, memchorHome, networkLog } = setup();
    const repo = initRepo({ branch: "feat/codex" });
    const stub = await startStubResponses({ calls: [
        { tool: "memory_bootstrap", arguments: {} },
        { tool: "memory_status", arguments: {} },
      ], reply: "Bootstrapped; nothing to continue yet." });
    useStubProvider(codexHome, stub.port);

    // app-server runs outside any repository: Memchor can only resolve scope from the thread's cwd.
    const server = new CodexAppServer(env, tempDir("memchor-not-a-repo-"));
    await server.initialize();
    const { threadId, path } = await server.runTurn(repo, "Continue the codex handoff work.");
    server.close();
    expect(path.startsWith(join(codexHome, "sessions"))).toBe(true);
    const rollout = readFileSync(path, "utf8");
    expect(rollout).toContain('"history_mode":"legacy"');
    // The bootstrap ran in the repository: a scope error would mean it ran in app-server's directory.
    expect(rollout.match(/"type":"mcp_tool_call_end"/g)).toHaveLength(2);
    expect(rollout).not.toContain("scope_unresolved");
    const live = /\\"workstreamId\\":\\"(wst_[0-9a-f]{32})\\",\\"workstreamLabel\\":\\"feat\/codex\\"/.exec(rollout)?.[1];
    expect(live).toBeDefined();

    const memory = openMemory({ cwd: repo, home: memchorHome, host: "codex", codexHome });
    onCleanup(() => {
      memory.close();
    });
    const boot: BootstrapResult = memory.bootstrap({ importChoice: "current_project" });
    expect(boot.scope).toMatchObject({ workstreamId: live, workstreamLabel: "feat/codex" });
    expect(boot.import).toMatchObject({ state: "complete", currentProject: { complete: 1, counters: { echoes: 2 } } });
    const items = memory.recall({ maxTokens: 8_000 }).items;
    const ask = items.find((item) => item.excerpt === "Continue the codex handoff work.");
    expect(ask).toMatchObject({ host: "codex", source: { transcriptId: threadId } });
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  }, 60_000);
});
