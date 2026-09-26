import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initRepo, snapshotTree, tempDir } from "../helpers.js";
import {
  CLAUDE_PINNED_VERSION,
  claude,
  claudeAsync,
  claudeEnv,
  claudeSandbox,
  claudeSkipReason,
  MEMCHOR_COMMAND,
  mcpServerLog,
  memchorAddArgs,
  sessionToolTraffic,
  startStubMessages,
} from "./claude.js";

const SKIP = claudeSkipReason();
if (SKIP !== null) process.stderr.write(`claude code connection tests skipped: ${SKIP}\n`);

const TOOLS = ["memory_bootstrap", "memory_checkpoint", "memory_manage", "memory_read", "memory_recall", "memory_record", "memory_status"];

function setup(branch: string) {
  const sandbox = claudeSandbox();
  const memchorHome = tempDir();
  const networkLog = join(tempDir(), "network.log");
  const repo = initRepo({ branch });
  const before = snapshotTree(repo);
  const env = claudeEnv(sandbox);
  const added = claude(env, repo, ...memchorAddArgs({ memchorHome, networkLog }));
  expect(added.code, added.stderr).toBe(0);
  return { sandbox, memchorHome, networkLog, repo, before, env, added };
}

function networkAttempts(networkLog: string): string {
  return existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "";
}

describe.skipIf(SKIP !== null)(`real Claude Code ${CLAUDE_PINNED_VERSION} connection`, () => {
  test("claude mcp add -s user writes only the isolated user config; list and get connect to memchor, started in the project directory", () => {
    const { sandbox, memchorHome, networkLog, repo, before, env, added } = setup("feat/claude");
    const configFile = join(sandbox.configDir, ".claude.json");
    expect(added.stdout).toContain(`Added stdio MCP server memchor with command: ${MEMCHOR_COMMAND.join(" ")} to user config`);
    expect(added.stdout).toContain(`File modified: ${configFile}`);
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    expect(config.mcpServers).toEqual({
      memchor: { type: "stdio", command: process.execPath, args: MEMCHOR_COMMAND.slice(1), env: { MEMCHOR_HOME: memchorHome, MEMCHOR_NETWORK_LOG: networkLog } },
    });
    expect(config.projects?.[repo]?.mcpServers ?? {}).toEqual({});

    // A server that cannot start, so a ✔ is known to come from a real connection, not from the listing.
    const broken = claude(env, repo, "mcp", "add", "broken", "-s", "user", "--", process.execPath, join(tempDir(), "missing.mjs"));
    expect(broken.code, broken.stderr).toBe(0);

    const list = claude(env, repo, "mcp", "list");
    expect(list.stdout).toContain(`memchor: ${MEMCHOR_COMMAND.join(" ")} - ✔ Connected`);
    expect(list.stdout).toMatch(/broken: .* - ✘ Failed to connect/);
    const get = claude(env, repo, "mcp", "get", "memchor");
    expect(get.code).toBe(0);
    for (const line of ["Scope: User config (available in all your projects)", "Status: ✔ Connected", "Type: stdio", `Command: ${process.execPath}`, `MEMCHOR_HOME=${memchorHome}`])
      expect(get.stdout).toContain(line);
    const missing = claude(env, repo, "mcp", "get", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('No MCP server named "missing"');

    // Memchor's startup line, captured by Claude Code: a user-scope server runs in the project directory.
    expect(mcpServerLog(sandbox, "memchor")).toContain(`memchor: MCP server ready (cwd ${repo})`);
    // The health check only handshakes: Memchor touched no storage and the repository gained no .mcp.json.
    expect(readdirSync(memchorHome)).toEqual([]);
    expect(snapshotTree(repo)).toEqual(before);
    expect(networkAttempts(networkLog)).toBe("");
  });

  test("a claude -p session against a localhost stub model calls memchor's tools, and memchor resolves the session's repository", async () => {
    const { sandbox, memchorHome, networkLog, repo, before } = setup("feat/claude");
    const stub = await startStubMessages({
      calls: [
        { tool: "memory_bootstrap", input: {} },
        { tool: "memory_status", input: {} },
      ],
      reply: "Bootstrapped; nothing to continue yet.",
    });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" });
    const run = await claudeAsync(env, repo, "-p", "Continue the claude handoff work.", "--output-format", "json", "--allowedTools", "mcp__memchor__memory_bootstrap mcp__memchor__memory_status");
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { is_error: boolean; result: string; session_id: string };
    expect(result).toMatchObject({ is_error: false, result: "Bootstrapped; nothing to continue yet." });

    // Claude Code offered all seven tools, under its mcp__<server>__<tool> names.
    const offered = stub.offeredTools[0] ?? [];
    expect(offered.filter((name) => name.startsWith("mcp__memchor__")).sort()).toEqual(TOOLS.map((tool) => `mcp__memchor__${tool}`));

    const traffic = sessionToolTraffic(sandbox, result.session_id);
    expect(traffic.uses).toEqual(["mcp__memchor__memory_bootstrap", "mcp__memchor__memory_status"]);
    const boot = JSON.parse(traffic.results[0] ?? "{}") as { scope?: Record<string, unknown> };
    expect(boot.scope).toMatchObject({ worktree: repo, branch: "feat/claude", workstreamLabel: "feat/claude", host: "claude-code", ambiguity: null });
    const status = JSON.parse(traffic.results[1] ?? "{}") as { storage?: { home?: string }; client?: unknown };
    expect(status.storage?.home).toBe(memchorHome);
    // The pinned Claude Code advertises elicitation ({} = form mode), so preference questions can go to the user directly.
    expect(status.client).toMatchObject({ name: "claude-code", elicitation: { form: true, url: false } });
    const registry = JSON.parse(readFileSync(join(memchorHome, "registry.json"), "utf8")) as { repositories: Record<string, unknown> };
    expect(Object.keys(registry.repositories)).toEqual([join(repo, ".git")]);

    expect(snapshotTree(repo)).toEqual(before);
    expect(networkAttempts(networkLog)).toBe("");
  }, 60_000);

  test("headless claude -p and a preference question: the tool call returns within Memchor's bound, and what Claude Code did is recorded", async () => {
    const { sandbox, repo } = setup("feat/claude");
    const stub = await startStubMessages({
      calls: [
        { tool: "memory_bootstrap", input: {} },
        { tool: "memory_record", input: { kind: "preference", body: "Use bun instead of npm.", attribution: "user_direction" } },
      ],
      reply: "Asked.",
    });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000", MEMCHOR_ELICITATION_TIMEOUT_MS: "5000" });
    const started = Date.now();
    const run = await claudeAsync(env, repo, "-p", "From now on use bun, not npm.", "--output-format", "json", "--allowedTools", "mcp__memchor__memory_bootstrap mcp__memchor__memory_record");
    const elapsedMs = Date.now() - started;
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { session_id: string };
    const traffic = sessionToolTraffic(sandbox, result.session_id);
    const preference = (JSON.parse(traffic.results[1] ?? "{}") as { preference?: { state?: string; relay?: string | null } }).preference;
    // Claude Code logs the question it received ("Elicitation request received in print mode").
    const received = mcpServerLog(sandbox, "memchor").includes("Elicitation request received");
    // pending + refused: the host answered cancel (or never); pending + allowed: the request failed; declined: it answered decline.
    const outcome = preference?.state === "pending" ? (preference.relay === "refused" ? "cancelled" : "unavailable") : (preference?.state ?? null);
    // Evidence, not an assertion about Claude Code's choice: -p has no one to ask.
    const artifacts = join(import.meta.dirname, "__artifacts__");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "elicitation-headless-claude.json"), JSON.stringify({ claudeCode: CLAUDE_PINNED_VERSION, mode: "claude -p", questionReceived: received, outcome, state: preference?.state ?? null, relay: preference?.relay ?? null, elapsedMs }, null, 2));
    expect(received).toBe(true);
    expect(preference?.state).toMatch(/^(pending|declined|active)$/);
    expect(elapsedMs).toBeLessThan(45_000);
  }, 60_000);
});
