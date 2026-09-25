import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapResult, ContextPack } from "../../src/memory.js";
import { git, initRepo, tempDir } from "../helpers.js";
import { codexHome, codexThreadId, installCodexRollout } from "../import/fixtures.js";
import { spawnServer } from "./harness.js";

const USER_ASK = "Checkout double-charges when the payment gateway times out. Find out why before changing anything.";

/**
 * Codex names its thread on every tools/call (`_meta.threadId`, equal to the rollout's id), so the
 * live `memchor mcp --host codex` session and that thread's imported rollout are one session: the
 * rollout joins the live session's workstream by session binding, even from another worktree.
 */
describe("Codex live session binding", () => {
  async function run(withMeta: boolean): Promise<{ boot: BootstrapResult; pack: ContextPack }> {
    const repo = initRepo();
    const other = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "side", other);
    const codex = codexHome();
    const threadId = codexThreadId();
    installCodexRollout(codex, "0.142.5/basic.jsonl", { cwd: other, threadId });

    const server = await spawnServer({ cwd: repo, home: tempDir(), host: "codex", codexHome: codex, networkLog: join(tempDir(), "network.log") });
    const call = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await server.client.callTool({ name, arguments: args, ...(withMeta ? { _meta: { threadId, callId: "call-1", progressToken: 1 } } : {}) });
      if (result.isError === true) throw new Error(JSON.stringify(result.content));
      return result.structuredContent as T;
    };
    const boot = await call<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    const pack = await call<ContextPack>("memory_recall", { query: "double charges gateway", maxTokens: 8_000 });
    await server.close();
    return { boot, pack };
  }

  test("the thread id in _meta binds the imported rollout to the live session's workstream", async () => {
    const { boot, pack } = await run(true);
    expect(boot.import).toMatchObject({ host: "codex", state: "complete" });
    expect(pack.items.map((item) => item.excerpt)).toContain(USER_ASK);
  });

  test("without it, the rollout from another worktree lands in that worktree's own workstream", async () => {
    const { pack } = await run(false);
    expect(pack.items.map((item) => item.excerpt)).not.toContain(USER_ASK);
  });

  test("an over-long thread id is ignored, never cut into a different identity", async () => {
    // Two live sessions in two worktrees naming the same thread: an adopted id binds the
    // second to the first's workstream (session binding); an ignored one leaves it its own.
    async function secondResolution(threadId: string): Promise<BootstrapResult["scope"]> {
      const repo = initRepo();
      const home = tempDir();
      const other = join(tempDir("memchor-wt-"), "wt");
      git(repo, "worktree", "add", "--quiet", "-b", "side", other);
      const scopes: BootstrapResult["scope"][] = [];
      for (const cwd of [repo, other]) {
        const server = await spawnServer({ cwd, home, host: "codex", codexHome: codexHome() });
        const result = await server.client.callTool({ name: "memory_bootstrap", arguments: { importChoice: "none" }, _meta: { threadId } });
        scopes.push((result.structuredContent as BootstrapResult).scope);
        await server.close();
      }
      return scopes[1] as BootstrapResult["scope"];
    }
    expect(await secondResolution("t".repeat(200))).toMatchObject({ resolvedBy: "session_binding" });
    expect(await secondResolution("t".repeat(201))).toMatchObject({ resolvedBy: "new_workstream" });
  });
});
