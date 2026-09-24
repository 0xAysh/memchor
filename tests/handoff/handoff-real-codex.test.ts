import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapResult, CheckpointResult, ContextPack, RecordResult } from "../../src/memory.js";
import { git, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";
import { CODEX_PINNED_VERSION, codex, CodexAppServer, codexEnv, codexSkipReason, memchorAddArgs, startStubResponses, useStubProvider } from "../mcp/codex.js";
import { spawnServer } from "../mcp/harness.js";
import { writeArtifact } from "./artifacts.js";

const SKIP = codexSkipReason();
if (SKIP !== null) process.stderr.write(`real-Codex handoff test skipped: ${SKIP}\n`);

const DECISION = "Charge with a server-side idempotency key per order; remove client retries.";
const RETRY_FACT = "src/retry.ts: backoff() retries every 5xx, including 504, with no idempotency key.";

/** What Memchor answered to each of the thread's calls, as Codex persisted it in the rollout (`mcp_tool_call_end`). */
function memchorResults(rolloutPath: string): { tool: string; result: Record<string, unknown>; isError: boolean }[] {
  const out: { tool: string; result: Record<string, unknown>; isError: boolean }[] = [];
  for (const line of readFileSync(rolloutPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { type?: string; payload?: { type?: string; invocation?: { server?: string; tool?: string }; result?: { Ok?: { structuredContent?: Record<string, unknown>; isError?: boolean } } } };
    const payload = entry.payload;
    if (entry.type !== "event_msg" || payload?.type !== "mcp_tool_call_end" || payload.invocation?.server !== "memchor") continue;
    out.push({ tool: payload.invocation.tool ?? "", result: payload.result?.Ok?.structuredContent ?? {}, isError: payload.result?.Ok?.isError === true });
  }
  return out;
}

/**
 * The handoff with the Codex step driven by the pinned real Codex CLI (`codex app-server`, a
 * legacy-history thread, a localhost stub of the Responses API scripting the model's Memchor
 * calls). Claude's steps are `memchor mcp --host claude-code` processes, as in handoff.test.ts.
 */
describe.skipIf(SKIP !== null)(`handoff through the real Codex ${CODEX_PINNED_VERSION}`, () => {
  test("Claude checkpoints → a real Codex thread bootstraps, sees Claude's memory with live freshness and publishes revision 2 → a fresh Claude session receives it", async () => {
    const home = tempDir("memchor-home-");
    const repo = join(tempDir("memchor-handoff-"), "store");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=fix/double-charge");
    writeFileSync(join(repo, "src/gateway.ts"), "export async function charge(order) {\n  return retry(() => post(order), { retries: 3 });\n}\n");
    writeFileSync(join(repo, "src/retry.ts"), "export function backoff(status) {\n  return status >= 500;\n}\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "checkout");
    const claudeDir = claudeConfigDir();
    installTranscript(claudeDir, "2.1.281/basic.jsonl", { cwd: repo });
    const logs = ["claude", "codex", "resumed", "import"].map((name) => join(tempDir("memchor-net-"), `${name}.log`));
    const [claudeLog = "", codexLog = "", resumedLog = "", importLog = ""] = logs;

    // Claude: consent, import, decision, a fact about the file that will change, checkpoint 1.
    const claude = await spawnServer({ cwd: repo, home, host: "claude-code", claudeConfigDir: claudeDir, networkLog: claudeLog });
    const claudeBoot = await claude.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    const decision = await claude.ok<RecordResult>("memory_record", { kind: "decision", body: DECISION, attribution: "user_direction", externalRefs: [{ kind: "code", locator: "src/gateway.ts" }] });
    const retryFact = await claude.ok<RecordResult>("memory_record", { kind: "evidence", body: RETRY_FACT, attribution: "direct_observation", externalRefs: [{ kind: "code", locator: "src/retry.ts" }] });
    const first = await claude.ok<CheckpointResult>("memory_checkpoint", { expectedRevision: 0, goal: "Stop checkout double-charging", status: "Root cause found; fix not started.", decisions: [DECISION], supportedBy: [decision.recordId] });
    await claude.close();
    writeFileSync(join(repo, "src/retry.ts"), "export function backoff(status) {\n  return status >= 500 && status !== 504;\n}\n");

    // Codex, registered exactly as the README says, in a new thread in the same worktree.
    const codexHome = tempDir("memchor-codex-home-");
    const env = codexEnv(codexHome, tempDir("memchor-codex-user-"));
    const added = codex(env, tempDir(), ...memchorAddArgs({ codexHome, memchorHome: home, networkLog: codexLog }));
    expect(added.code, added.stderr).toBe(0);
    const stub = await startStubResponses({
      calls: [
        { tool: "memory_bootstrap", arguments: {} },
        { tool: "memory_bootstrap", arguments: { importChoice: "current_project" } },
        { tool: "memory_recall", arguments: { query: "backoff retries 504 idempotency key", maxTokens: 8_000 } },
        {
          tool: "memory_checkpoint",
          arguments: { expectedRevision: 1, goal: "Stop checkout double-charging", status: "Codex: backoff() no longer retries 504; idempotency key still missing.", nextSteps: ["Add an idempotency key to charge()"] },
        },
      ],
      reply: "Continued from Claude's checkpoint and published revision 2.",
    });
    useStubProvider(codexHome, stub.port);
    const server = new CodexAppServer(env, tempDir("memchor-not-a-repo-"));
    await server.initialize();
    const { threadId, path } = await server.runTurn(repo, "Continue the checkout double-charge fix from the Claude handoff.");
    server.close();

    const results = memchorResults(path);
    expect(results.map((r) => r.tool)).toEqual(["memory_bootstrap", "memory_bootstrap", "memory_recall", "memory_checkpoint"]);
    expect(results.every((r) => !r.isError)).toBe(true);
    const [asked, boot, recall, checkpoint] = results.map((r) => r.result) as unknown as [BootstrapResult, BootstrapResult, ContextPack, CheckpointResult];
    expect(asked.import).toMatchObject({ host: "codex", state: "consent_required" });
    expect(boot.scope).toMatchObject({ workspaceId: claudeBoot.scope.workspaceId, workstreamId: claudeBoot.scope.workstreamId, resolvedBy: "worktree_binding", headRevision: 1, host: "codex" });
    expect(boot.context.checkpoint).toMatchObject({ recordId: first.recordId, revision: 1, host: "claude-code" });
    expect(recall.items.find((i) => i.recordId === decision.recordId)).toMatchObject({ host: "claude-code", freshness: "current", warning: null });
    const stale = recall.items.find((i) => i.recordId === retryFact.recordId);
    expect(stale).toMatchObject({ host: "claude-code", freshness: "stale", externalRefs: [expect.objectContaining({ reason: "changed" })] });
    expect(stale?.warning).toMatch(/Read the current file/);
    expect(checkpoint).toMatchObject({ revision: 2, previousRevision: 1 });

    // A fresh Claude session continues from Codex's checkpoint, with the freshness warning.
    const resumed = await spawnServer({ cwd: repo, home, host: "claude-code", claudeConfigDir: claudeDir, networkLog: resumedLog });
    const resumedBoot = await resumed.ok<BootstrapResult>("memory_bootstrap");
    expect(resumedBoot.scope).toMatchObject({ workstreamId: claudeBoot.scope.workstreamId, headRevision: 2 });
    expect(resumedBoot.context.checkpoint).toMatchObject({ recordId: checkpoint.recordId, revision: 2, host: "codex" });
    expect(resumedBoot.context.checkpoint?.excerpt).toContain("no longer retries 504");
    expect(resumedBoot.context.items.find((i) => i.recordId === retryFact.recordId)?.warning).toMatch(/Read the current file/);
    await resumed.close();

    // The thread's own rollout, imported later, joins the same workstream by the session Codex's
    // Memchor bound to its thread id; Memchor's four answers in it are echoes, never records.
    const importer = await spawnServer({ cwd: repo, home, host: "codex", codexHome, networkLog: importLog });
    const imported = await importer.ok<BootstrapResult>("memory_bootstrap");
    expect(imported.import).toMatchObject({ state: "complete", currentProject: { complete: 1, counters: { echoes: 4 } } });
    const ask = (await importer.ok<ContextPack>("memory_recall", { query: "Continue the checkout double-charge fix", maxTokens: 8_000 })).items.find((i) => i.source?.transcriptId === threadId);
    expect(ask).toMatchObject({ host: "codex", attribution: "user_direction", excerpt: "Continue the checkout double-charge fix from the Claude handoff." });
    expect(imported.scope.workstreamId).toBe(claudeBoot.scope.workstreamId);
    await importer.close();

    for (const log of logs) expect(existsSync(log) ? readFileSync(log, "utf8") : "", log).toBe("");
    writeArtifact("real-codex-thread", { codex: CODEX_PINNED_VERSION, memchorCalls: results, resumedClaudeBootstrap: resumedBoot }, [
      [repo, "<repo>"],
      [home, "<memchor-home>"],
      [codexHome, "<codex-home>"],
    ]);
  }, 120_000);
});
