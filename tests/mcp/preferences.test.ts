import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import type { BootstrapResult, ManageResult, PreferenceQuestion } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { type ServerHandle, spawnServer } from "./harness.js";

/** The two capability shapes the pinned hosts advertise (captured 2026-09-25). */
const HOSTS = [
  { name: "Claude Code (elicitation: {})", capability: {} },
  { name: "Codex (elicitation: {form, url})", capability: { form: {}, url: {} } },
] as const;

type Respond = (request: ElicitRequest["params"]) => Promise<ElicitResult>;

async function server(repo: string, home: string, options: { capability?: Record<string, unknown>; respond?: Respond; timeoutMs?: number } = {}): Promise<{ handle: ServerHandle; asked: ElicitRequest["params"][] }> {
  const asked: ElicitRequest["params"][] = [];
  const respond = options.respond ?? (() => Promise.resolve({ action: "cancel" }));
  const handle = await spawnServer({
    cwd: repo,
    home,
    host: "claude-code",
    ...(options.capability === undefined
      ? {}
      : {
          elicitation: {
            capability: options.capability,
            respond: (request) => {
              asked.push(request);
              return respond(request);
            },
          },
        }),
    ...(options.timeoutMs === undefined ? {} : { elicitationTimeoutMs: options.timeoutMs }),
  });
  onCleanup(() => void handle.close());
  return { handle, asked };
}

const answer = (label: string): Respond => () => Promise.resolve({ action: "accept", content: { answer: label } });

async function proposeOver(handle: ServerHandle, body = "Use bun instead of npm."): Promise<PreferenceQuestion> {
  await handle.ok("memory_bootstrap");
  const result = await handle.ok<{ recordId: null; preference: PreferenceQuestion }>("memory_record", { kind: "preference", body, attribution: "user_direction" });
  expect(result.recordId).toBeNull();
  return result.preference;
}

describe.each(HOSTS)("preference confirmation over MCP elicitation: $name", ({ capability }) => {
  test("the user is asked directly with exactly three answers, and Everywhere makes it a global preference", async () => {
    const home = tempDir();
    const { handle, asked } = await server(initRepo(), home, { capability, respond: answer("Everywhere") });
    expect(await proposeOver(handle)).toMatchObject({ state: "active", scope: "global", confirmedBy: "user" });
    expect(asked).toEqual([
      expect.objectContaining({
        message: 'Save "Use bun instead of npm." as a preference?',
        requestedSchema: { type: "object", properties: { answer: { type: "string", title: "Your answer", enum: ["Everywhere", "This repo only", "No, just now"] } }, required: ["answer"] },
      }),
    ]);
    const elsewhere = await server(initRepo(), home);
    expect((await elsewhere.handle.ok<BootstrapResult>("memory_bootstrap")).preferences.items).toEqual([expect.objectContaining({ text: "Use bun instead of npm.", scope: "global" })]);
  });

  test("This repo only, and No, just now", async () => {
    const repo = initRepo();
    const home = tempDir();
    expect(await proposeOver((await server(repo, home, { capability, respond: answer("This repo only") })).handle)).toMatchObject({ state: "active", scope: "repo" });
    expect(await proposeOver((await server(repo, home, { capability, respond: answer("No, just now") })).handle, "Prefer tabs.")).toMatchObject({ state: "declined" });
    const block = (await (await server(repo, home)).handle.ok<BootstrapResult>("memory_bootstrap")).preferences;
    expect(block.items.map((item) => item.text)).toEqual(["Use bun instead of npm."]);
    expect(block.pending).toEqual([]);
  });

  test("declining the form is not the user saying no: headless hosts decline on their own (codex exec), so it stays pending", async () => {
    const { handle } = await server(initRepo(), tempDir(), { capability, respond: () => Promise.resolve({ action: "decline" }) });
    expect(await proposeOver(handle)).toMatchObject({ state: "pending", relay: "refused" });
  });

  test("a dismissed question stays pending, and the agent cannot answer it for the user", async () => {
    const { handle } = await server(initRepo(), tempDir(), { capability, respond: () => Promise.resolve({ action: "cancel" }) });
    const question = await proposeOver(handle);
    expect(question).toMatchObject({ state: "pending", relay: "refused" });
    const relayed = await handle.call("memory_manage", { action: "answer_preference", candidateId: question.candidateId, answer: "everywhere" });
    expect(relayed.structured).toMatchObject({ error: { code: "lifecycle_conflict" } });
  });

  test("an unanswered question times out within the bound and stays pending", async () => {
    const { handle } = await server(initRepo(), tempDir(), { capability, respond: () => new Promise<never>(() => undefined), timeoutMs: 300 });
    const started = Date.now();
    expect(await proposeOver(handle)).toMatchObject({ state: "pending" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("an agent-inferred change is asked as a yes/no proposal, and yes applies it", async () => {
    const { handle, asked } = await server(initRepo(), tempDir(), { capability, respond: (request) => answer(request.message.startsWith("Save") ? "This repo only" : "Yes")(request) });
    const saved = await proposeOver(handle);
    const proposal = await handle.ok<ManageResult>("memory_manage", { action: "supersede", recordId: saved.recordId, body: "Use pnpm instead of npm.", reason: "The lockfile is pnpm's.", attribution: "agent_inference" });
    expect(proposal).toMatchObject({ action: "proposal", preference: { kind: "change", state: "applied", confirmedBy: "user" } });
    expect(asked.at(-1)).toMatchObject({ message: 'Change your preference "Use bun instead of npm." to "Use pnpm instead of npm."?' });
    expect((await handle.ok<BootstrapResult>("memory_bootstrap")).preferences.items.map((item) => item.text)).toEqual(["Use pnpm instead of npm."]);
  });
});

describe("without elicitation", () => {
  test("the question comes back to the agent, whose relayed answer counts and is marked agent-reported", async () => {
    const { handle } = await server(initRepo(), tempDir());
    const question = await proposeOver(handle);
    expect(question).toMatchObject({ state: "pending", relay: "allowed", question: 'Save "Use bun instead of npm." as a preference?' });
    expect(await handle.ok<ManageResult>("memory_manage", { action: "answer_preference", candidateId: question.candidateId, answer: "repo" })).toMatchObject({
      preference: { state: "active", scope: "repo", confirmedBy: "agent_reported" },
    });
  });

  test("a question left pending is asked once more at the next session start, directly", async () => {
    const repo = initRepo();
    const home = tempDir();
    const first = await server(repo, home, { capability: {}, respond: () => Promise.resolve({ action: "cancel" }) });
    await proposeOver(first.handle);
    const second = await server(repo, home, { capability: {}, respond: answer("This repo only") });
    const boot = await second.handle.ok<BootstrapResult>("memory_bootstrap");
    expect(boot.preferences.pending).toEqual([expect.objectContaining({ text: "Use bun instead of npm.", state: "active", scope: "repo" })]);
    expect(second.asked).toHaveLength(1);
  });
});
