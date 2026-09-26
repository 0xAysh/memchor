import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Memory, openMemory, type PreferenceQuestion } from "../../src/memory.js";
import { catchMemchorError, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** Proposes a preference the way an agent does; returns the question Memchor wants answered. */
function propose(memory: Memory, body: string): PreferenceQuestion & { candidateId: string } {
  const result = memory.record({ kind: "preference", body, attribution: "user_direction" });
  expect(result.recordId).toBeNull();
  return pending(result.preference);
}

function pending(question: PreferenceQuestion): PreferenceQuestion & { candidateId: string } {
  const { candidateId } = question;
  if (candidateId === null) throw new Error(`expected a pending question, got ${question.state}`);
  return { ...question, candidateId };
}

function texts(memory: Memory): string[] {
  return memory.bootstrap().preferences.items.map((item) => item.text);
}

describe("confirming a preference", () => {
  test("a proposed preference is only a question: never stored as memory, recalled, or injected until answered", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    const question = propose(memory, "Use bun instead of npm.");
    expect(question).toMatchObject({
      kind: "new",
      text: "Use bun instead of npm.",
      question: 'Save "Use bun instead of npm." as a preference?',
      choices: [
        { value: "everywhere", label: "Everywhere" },
        { value: "repo", label: "This repo only" },
        { value: "no", label: "No, just now" },
      ],
      state: "pending",
    });
    expect(memory.recall({ query: "bun npm" }).items).toEqual([]);
    expect(memory.status().counts?.records).toBe(0);
    expect(memory.bootstrap().preferences.items).toEqual([]);
  });

  test("Everywhere stores it once for every repository; This repo only stores it for this one", () => {
    const home = tempDir();
    const repo = initRepo();
    const other = initRepo();
    const memory = open(repo, home);
    memory.bootstrap();
    const global = memory.settlePreference({ candidateId: propose(memory, "Use bun instead of npm.").candidateId, outcome: { answer: "everywhere" } });
    expect(global).toMatchObject({ state: "active", scope: "global", confirmedBy: "user" });
    const local = memory.settlePreference({ candidateId: propose(memory, "Run the gateway suite before pushing.").candidateId, outcome: { answer: "repo" } });
    expect(local).toMatchObject({ state: "active", scope: "repo", confirmedBy: "user" });

    expect(open(repo, home, "codex").bootstrap().preferences).toMatchObject({
      items: [
        { text: "Run the gateway suite before pushing.", scope: "repo", confirmedBy: "user" },
        { text: "Use bun instead of npm.", scope: "global", confirmedBy: "user" },
      ],
      omitted: 0,
    });
    expect(texts(open(other, home))).toEqual(["Use bun instead of npm."]);
  });

  test("No stores nothing, and the same preference is not asked again in this session", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    const question = propose(memory, "Use bun instead of npm.");
    expect(memory.settlePreference({ candidateId: question.candidateId, outcome: { answer: "no" } })).toMatchObject({ state: "declined" });
    const again = memory.record({ kind: "preference", body: "use  bun instead of NPM.", attribution: "user_direction" });
    expect(again.preference).toMatchObject({ state: "declined" });
    expect(memory.status().counts?.records).toBe(0);
    expect(texts(memory)).toEqual([]);
  });

  test("an unanswered question stays pending, is asked once more at the next session start, then dropped", () => {
    const repo = initRepo();
    const home = tempDir();
    const first = open(repo, home);
    first.bootstrap();
    const question = propose(first, "Use bun instead of npm.");
    first.settlePreference({ candidateId: question.candidateId, outcome: "cancelled" });
    // Still this session: not asked again, and not injected.
    expect(first.bootstrap().preferences).toMatchObject({ items: [], pending: [] });

    const second = open(repo, home, "codex").bootstrap().preferences;
    expect(second.items).toEqual([]);
    expect(second.pending).toEqual([expect.objectContaining({ candidateId: question.candidateId, text: "Use bun instead of npm." })]);

    const third = open(repo, home).bootstrap().preferences;
    expect(third.pending).toEqual([]);
    expect(catchMemchorError(() => open(repo, home).settlePreference({ candidateId: question.candidateId, outcome: { answer: "repo" } })).code).toBe("not_found");
  });

  test("an answer relayed by the agent counts only when the question could not be asked directly, and is marked as agent-reported", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    const relayed = propose(memory, "Use bun instead of npm.");
    memory.settlePreference({ candidateId: relayed.candidateId, outcome: "unavailable" });
    expect(memory.manage({ action: "answer_preference", candidateId: relayed.candidateId, answer: "repo" })).toMatchObject({
      action: "answer_preference",
      preference: { state: "active", scope: "repo", confirmedBy: "agent_reported" },
    });

    // The user dismissed the question: the agent cannot answer in their place.
    const dismissed = propose(memory, "Prefer small commits.");
    memory.settlePreference({ candidateId: dismissed.candidateId, outcome: "cancelled" });
    const refused = catchMemchorError(() => memory.manage({ action: "answer_preference", candidateId: dismissed.candidateId, answer: "everywhere" }));
    expect(refused.code).toBe("lifecycle_conflict");
    expect(texts(memory)).toEqual(["Use bun instead of npm."]);
  });

  test("an already-active preference is not asked again", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    memory.settlePreference({ candidateId: propose(memory, "Use bun instead of npm.").candidateId, outcome: { answer: "everywhere" } });
    expect(memory.record({ kind: "preference", body: "Use bun instead of npm.", attribution: "user_direction" }).preference).toMatchObject({ state: "active", scope: "global" });
  });
});

describe("changing a preference", () => {
  function active(memory: Memory, body: string, answer: "everywhere" | "repo"): string {
    const settled = memory.settlePreference({ candidateId: propose(memory, body).candidateId, outcome: { answer } });
    if (settled.recordId === null) throw new Error("not stored");
    return settled.recordId;
  }

  test("the user's explicit change applies at once, to a global preference too, and a removal can be undone", () => {
    const home = tempDir();
    const memory = open(initRepo(), home);
    memory.bootstrap();
    const bun = active(memory, "Use bun instead of npm.", "everywhere");
    const changed = memory.manage({ action: "supersede", recordId: bun, body: "Use pnpm instead of npm.", reason: "The user switched to pnpm.", attribution: "user_direction" });
    expect(changed).toMatchObject({ action: "supersede", recordId: bun });
    expect(texts(memory)).toEqual(["Use pnpm instead of npm."]);
    expect(texts(open(initRepo(), home))).toEqual(["Use pnpm instead of npm."]);

    if (changed.action !== "supersede") throw new Error("unreachable");
    memory.manage({ action: "retract", recordId: changed.replacementId, reason: "Forget the pnpm thing.", attribution: "user_direction" });
    expect(texts(memory)).toEqual([]);
    memory.manage({ action: "restore", recordId: changed.replacementId, reason: "Undo.", attribution: "user_direction" });
    expect(texts(memory)).toEqual(["Use pnpm instead of npm."]);
    expect(memory.manage({ action: "inspect", recordId: bun })).toMatchObject({ record: { lifecycle: "superseded" }, replacement: { recordId: changed.replacementId } });
  });

  test("a change or removal the agent inferred is only a proposal until the user says yes", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    const bun = active(memory, "Use bun instead of npm.", "repo");

    const proposal = memory.manage({ action: "supersede", recordId: bun, body: "Use pnpm instead of npm.", reason: "The lockfile is pnpm's.", attribution: "agent_inference" });
    expect(proposal).toMatchObject({
      action: "proposal",
      preference: { kind: "change", targetId: bun, text: "Use pnpm instead of npm.", question: 'Change your preference "Use bun instead of npm." to "Use pnpm instead of npm."?', state: "pending" },
    });
    expect(texts(memory)).toEqual(["Use bun instead of npm."]);
    if (proposal.action !== "proposal") throw new Error("unreachable");
    expect(memory.settlePreference({ candidateId: pending(proposal.preference).candidateId, outcome: { answer: "no" } })).toMatchObject({ state: "kept" });
    expect(texts(memory)).toEqual(["Use bun instead of npm."]);

    const removal = memory.manage({ action: "retract", recordId: bun, reason: "Seems unused.", attribution: "agent_inference" });
    if (removal.action !== "proposal") throw new Error("expected a proposal");
    expect(removal.preference).toMatchObject({ kind: "remove", question: 'Remove your preference "Use bun instead of npm."?' });
    expect(memory.settlePreference({ candidateId: pending(removal.preference).candidateId, outcome: { answer: "yes" } })).toMatchObject({ state: "applied" });
    expect(texts(memory)).toEqual([]);
  });
});

describe("the preference block at session start", () => {
  test("is capped near 4 KB, says how many were left out, and says the current request wins", () => {
    const memory = open(initRepo(), tempDir());
    memory.bootstrap();
    for (let i = 0; i < 40; i++) {
      memory.settlePreference({ candidateId: propose(memory, `Preference number ${i}: ${"always keep this convention in mind ".repeat(3)}`).candidateId, outcome: { answer: "repo" } });
    }
    const block = memory.bootstrap().preferences;
    expect(Buffer.byteLength(JSON.stringify(block.items))).toBeLessThanOrEqual(4_096);
    expect(block.items.length + block.omitted).toBe(40);
    expect(block.omitted).toBeGreaterThan(0);
    expect(block.note).toMatch(/defaults.*asks for something different.*do that/i);
  });

  test("global preferences live in $MEMCHOR_HOME/global.sqlite", () => {
    const home = tempDir();
    const memory = open(initRepo(), home);
    memory.bootstrap();
    memory.settlePreference({ candidateId: propose(memory, "Use bun instead of npm.").candidateId, outcome: { answer: "everywhere" } });
    expect(memory.status().storage.globalDbPath).toBe(join(home, "global.sqlite"));
  });
});
