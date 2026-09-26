import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { type ContextPack, openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** Every record id a workstream's recall can reach for `query`, across all pages. */
function recalled(memory: Memory, query?: string): string[] {
  const ids: string[] = [];
  let pack: ContextPack = memory.recall({ maxTokens: 8_000, ...(query === undefined ? {} : { query }) });
  for (;;) {
    ids.push(...pack.items.flatMap((item) => [item.recordId, ...item.copies.map((copy) => copy.recordId)]));
    if (pack.continuation === null) return ids;
    pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
  }
}

const REDIS = "Redis is required for the job queue; every retry must go through it.";

/**
 * The mistaken "Redis is required" memory and everything built on it: a decision resting on
 * it, a verbatim restatement, a loose related note, and a checkpoint that cites it.
 */
function redisScenario(memory: Memory): { claim: string; decision: string; restatement: string; related: string; checkpoint: string } {
  const claim = memory.record({ kind: "evidence", body: REDIS, attribution: "user_direction" }).recordId;
  const decision = memory.record({ kind: "decision", body: "Use a Redis-backed queue for payment retries.", attribution: "agent_inference", supportedBy: [claim] }).recordId;
  const restatement = memory.record({
    kind: "note",
    body: "Codex notes: Redis is required for the job queue.",
    attribution: "agent_inference",
    links: [{ to: claim, relation: "derived_from" }],
  }).recordId;
  const related = memory.record({ kind: "note", body: "Queue latency budget is 50 ms.", attribution: "agent_inference", links: [{ to: claim, relation: "related_to" }] }).recordId;
  const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "Harden payment retries", status: "Queue chosen", decisions: ["Use Redis for the queue"], supportedBy: [claim] }).recordId;
  return { claim, decision, restatement, related, checkpoint };
}

describe("correction", () => {
  test("the Redis scenario: correcting a claim hides it and its derivations from every read path, in one step", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const ids = redisScenario(memory);
    expect(recalled(memory, "redis")).toEqual(expect.arrayContaining([ids.claim, ids.decision, ids.restatement]));

    const corrected = memory.manage({
      action: "correct",
      recordId: ids.claim,
      body: "Redis was only one option for the job queue, not a requirement.",
      reason: "The user said Redis was only an option.",
      attribution: "user_direction",
    });
    expect(corrected).toMatchObject({ v: 1, action: "correct", recordId: ids.claim, replayed: false });
    if (corrected.action !== "correct") throw new Error("unreachable");
    expect(corrected.affected).toMatchObject({ records: [ids.claim], invalidated: [ids.restatement] });
    expect(corrected.affected.quarantined).toEqual(expect.arrayContaining([ids.decision, ids.checkpoint]));

    // Keyword retrieval: only the correction (and the unrelated note) remain.
    const afterRecall = recalled(memory, "redis queue");
    expect(afterRecall).toContain(corrected.replacementId);
    expect(afterRecall).toContain(ids.related);
    for (const gone of [ids.claim, ids.decision, ids.restatement]) expect(afterRecall).not.toContain(gone);

    // Direct read: refused, pointing at the replacement.
    const refused = catchMemchorError(() => memory.read({ recordId: ids.claim }));
    expect(refused.code).toBe("not_found");
    expect(refused.details).toMatchObject({ lifecycle: "corrected", replacementId: corrected.replacementId });
    expect(catchMemchorError(() => memory.read({ recordId: ids.decision })).details).toMatchObject({ taint: "quarantined" });

    // Link expansion: the related note no longer leads to the corrected claim.
    expect(memory.read({ recordId: ids.related }).links).toEqual([]);

    // Checkpoints: the quarantined head is withheld, and the pack says why.
    const pack = memory.recall();
    expect(pack.checkpoint).toBeNull();
    expect(pack.scope.headRevision).toBe(1);
    expect(pack.notice).toMatch(/checkpoint r1 .*quarantined/i);

    // New writes cannot cite what is no longer eligible.
    expect(catchMemchorError(() => memory.record({ kind: "note", body: "x", attribution: "agent_inference", supportedBy: [ids.claim] })).code).toBe("not_found");

    // A fresh session receives the corrected guidance.
    const fresh = open(repo, home, "codex");
    const context = fresh.bootstrap().context;
    const texts = context.items.map((item) => item.excerpt).join("\n");
    expect(texts).toContain("Redis was only one option");
    expect(texts).not.toContain(REDIS);
    expect(context.items.find((item) => item.recordId === corrected.replacementId)).toMatchObject({ kind: "correction", attribution: "user_direction" });
  });

  test("the correction record supersedes the old claim and carries the reason", () => {
    const memory = open(initRepo(), tempDir());
    const { claim } = redisScenario(memory);
    const corrected = memory.manage({ action: "correct", recordId: claim, body: "Redis is optional.", reason: "User clarified.", attribution: "user_direction" });
    if (corrected.action !== "correct") throw new Error("unreachable");
    const read = memory.read({ recordId: corrected.replacementId });
    expect(read).toMatchObject({ kind: "correction", attribution: "user_direction" });
    expect(read.body).toBe("Redis is optional.\n\nReason: User clarified.");
    // The supersedes link names a record the reader cannot see, so it is not listed as a link.
    expect(read.links).toEqual([]);
  });

  test("an already-running session is told once that memory it may hold changed (correction watermark)", () => {
    const repo = initRepo();
    const home = tempDir();
    const running = open(repo, home);
    const { claim } = redisScenario(running);
    expect(running.recall().corrections).toBeNull();

    const other = open(repo, home, "codex");
    const corrected = other.manage({ action: "correct", recordId: claim, body: "Redis is optional.", reason: "User clarified.", attribution: "user_direction" });
    if (corrected.action !== "correct") throw new Error("unreachable");

    const first = running.recall({ query: "anything unrelated" });
    expect(first.corrections).toMatchObject({
      changes: [{ recordId: claim, action: "correct", replacementId: corrected.replacementId, reason: "User clarified." }],
      omitted: 0,
    });
    expect(first.corrections?.watermark).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(first))).toBe(first.budget.usedBytes);
    expect(running.recall().corrections).toBeNull();
  });

  test("a direct read tells a running session about changes too, once", () => {
    const repo = initRepo();
    const home = tempDir();
    const running = open(repo, home);
    const { claim, related } = redisScenario(running);
    open(repo, home, "codex").manage({ action: "retract", recordId: claim, reason: "Never said.", attribution: "user_direction" });
    expect(running.read({ recordId: related }).corrections?.changes).toEqual([expect.objectContaining({ recordId: claim, action: "retract" })]);
    expect(running.read({ recordId: related }).corrections).toBeNull();
    expect(running.recall().corrections).toBeNull();
  });

  test("correcting twice is a lifecycle_conflict naming the replacement; an operationKey replays", () => {
    const memory = open(initRepo(), tempDir());
    const { claim } = redisScenario(memory);
    const input = { action: "correct", recordId: claim, body: "Redis is optional.", reason: "r", attribution: "user_direction", operationKey: "fix-redis" } as const;
    const first = memory.manage(input);
    expect(memory.manage(input)).toEqual({ ...first, replayed: true });
    const again = catchMemchorError(() => memory.manage({ ...input, operationKey: "fix-redis-2" }));
    expect(again.code).toBe("lifecycle_conflict");
    if (first.action !== "correct") throw new Error("unreachable");
    expect(again.details).toMatchObject({ lifecycle: "corrected", replacementId: first.replacementId });
  });

  test("another workstream's record cannot be corrected, and a refused correction changes nothing", () => {
    const repo = initRepo();
    const home = tempDir();
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const mine = open(repo, home);
    const theirs = open(worktree, home).record({ kind: "note", body: "their claim", attribution: "agent_inference" });
    const before = recalled(mine);
    expect(catchMemchorError(() => mine.manage({ action: "retract", recordId: theirs.recordId, reason: "r", attribution: "user_direction" })).code).toBe("scope_denied");
    expect(recalled(mine)).toEqual(before);
  });
});

describe("retraction, restore and supersession", () => {
  test("retracting hides the claim and its dependents; restoring brings back exactly what the retraction hid", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    const alreadyQuarantined = memory.record({ kind: "note", body: "unrelated base", attribution: "agent_inference" }).recordId;
    const onBoth = memory.record({ kind: "decision", body: "Depends on both.", attribution: "agent_inference", supportedBy: [ids.claim, alreadyQuarantined] }).recordId;
    memory.manage({ action: "retract", recordId: alreadyQuarantined, reason: "wrong too", attribution: "user_direction" });

    const retracted = memory.manage({ action: "retract", recordId: ids.claim, reason: "Never said.", attribution: "user_direction" });
    expect(retracted).toMatchObject({ action: "retract", recordId: ids.claim });
    for (const hidden of [ids.claim, ids.decision, ids.restatement, onBoth]) expect(recalled(memory)).not.toContain(hidden);

    const restored = memory.manage({ action: "restore", recordId: ids.claim, reason: "It was right after all.", attribution: "user_direction" });
    expect(restored).toMatchObject({ action: "restore", recordId: ids.claim });
    const visible = recalled(memory);
    for (const back of [ids.claim, ids.decision, ids.restatement]) expect(visible).toContain(back);
    // Still resting on another retracted record: it stays quarantined.
    expect(visible).not.toContain(onBoth);
    expect(memory.recall().checkpoint?.recordId).toBe(ids.checkpoint);
  });

  test("only a retraction can be restored", () => {
    const memory = open(initRepo(), tempDir());
    const { claim, related } = redisScenario(memory);
    memory.manage({ action: "correct", recordId: claim, body: "Redis is optional.", reason: "r", attribution: "user_direction" });
    expect(catchMemchorError(() => memory.manage({ action: "restore", recordId: claim, reason: "r", attribution: "user_direction" })).code).toBe("lifecycle_conflict");
    expect(catchMemchorError(() => memory.manage({ action: "restore", recordId: related, reason: "r", attribution: "user_direction" })).code).toBe("lifecycle_conflict");
  });

  test("superseding replaces an outdated claim: copies of it go, conclusions that rested on it stay", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    const superseded = memory.manage({ action: "supersede", recordId: ids.decision, body: "Use the Postgres-backed queue for payment retries.", reason: "Moved off Redis.", attribution: "user_direction" });
    if (superseded.action !== "supersede") throw new Error("unreachable");
    const copy = memory.record({ kind: "note", body: "x", attribution: "agent_inference", links: [{ to: superseded.replacementId, relation: "derived_from" }] });
    expect(memory.read({ recordId: superseded.replacementId })).toMatchObject({ kind: "decision", body: "Use the Postgres-backed queue for payment retries." });
    const visible = recalled(memory);
    expect(visible).not.toContain(ids.decision);
    expect(visible).toEqual(expect.arrayContaining([ids.claim, ids.restatement, copy.recordId, superseded.replacementId]));
    expect(memory.recall().checkpoint?.recordId).toBe(ids.checkpoint);
  });

  test("a restatement derived from a restatement is invalidated transitively", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    const second = memory.record({ kind: "note", body: "Pi repeats Codex.", attribution: "agent_inference", links: [{ to: ids.restatement, relation: "derived_from" }] }).recordId;
    const corrected = memory.manage({ action: "retract", recordId: ids.claim, reason: "r", attribution: "user_direction" });
    if (corrected.action !== "retract") throw new Error("unreachable");
    expect(corrected.affected.invalidated).toEqual(expect.arrayContaining([ids.restatement, second]));
    expect(recalled(memory)).not.toContain(second);
  });

  test("a record first reached as resting on the claim, then as restating it, ends invalidated, and so do its restatements", () => {
    const memory = open(initRepo(), tempDir());
    const claim = memory.record({ kind: "evidence", body: "Redis is required.", attribution: "user_direction" }).recordId;
    const copy = memory.record({ kind: "note", body: "copy", attribution: "agent_inference", links: [{ to: claim, relation: "derived_from" }] }).recordId;
    const both = memory.record({ kind: "note", body: "both", attribution: "agent_inference", supportedBy: [claim], links: [{ to: copy, relation: "derived_from" }] }).recordId;
    const echo = memory.record({ kind: "note", body: "echo", attribution: "agent_inference", links: [{ to: both, relation: "derived_from" }] }).recordId;
    const result = memory.manage({ action: "retract", recordId: claim, reason: "r", attribution: "user_direction" });
    if (result.action !== "retract") throw new Error("unreachable");
    expect(result.affected.invalidated).toEqual(expect.arrayContaining([copy, both, echo]));
    expect(result.affected.quarantined).toEqual([]);
  });

  test("a checkpoint that restates the claim verbatim without citing it is quarantined (no fine-grained lineage)", () => {
    const memory = open(initRepo(), tempDir());
    const claim = memory.record({ kind: "evidence", body: REDIS, attribution: "user_direction" }).recordId;
    const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "Retries", status: `Agreed with the user: ${REDIS}` }).recordId;
    const unrelated = memory.checkpoint({ expectedRevision: 1, goal: "Retries", status: "Queue work paused." }).recordId;
    const result = memory.manage({ action: "retract", recordId: claim, reason: "r", attribution: "user_direction" });
    if (result.action !== "retract") throw new Error("unreachable");
    expect(result.affected.quarantined).toEqual([checkpoint]);
    expect(memory.recall().checkpoint?.recordId).toBe(unrelated);
  });
});

describe("inspection", () => {
  test("inspect shows state, history, attribution, evidence, derivations and replacement, even for ineligible records", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    const evidence = memory.record({ kind: "evidence", body: "User message in chat.", attribution: "direct_observation" }).recordId;
    const claimed = memory.record({ kind: "constraint", body: "Queue must be durable.", attribution: "user_direction", supportedBy: [evidence] }).recordId;

    const before = memory.manage({ action: "inspect", recordId: ids.claim });
    expect(before).toMatchObject({
      v: 1,
      action: "inspect",
      record: { recordId: ids.claim, kind: "evidence", body: REDIS, attribution: "user_direction", lifecycle: "active", eligible: true, taints: [] },
      history: [],
      replacement: null,
    });
    if (before.action !== "inspect") throw new Error("unreachable");
    expect(before.derivations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: ids.decision, relation: "supported_by", eligible: true }),
        expect.objectContaining({ recordId: ids.restatement, relation: "derived_from" }),
        expect.objectContaining({ recordId: ids.checkpoint, relation: "supported_by" }),
      ]),
    );
    expect(before.derivations.map((d) => d.recordId)).not.toContain(ids.related);
    expect(memory.manage({ action: "inspect", recordId: claimed })).toMatchObject({ evidence: [{ recordId: evidence, relation: "supported_by", eligible: true }] });

    const corrected = memory.manage({ action: "correct", recordId: ids.claim, body: "Redis is optional.", reason: "User clarified.", attribution: "user_direction" });
    if (corrected.action !== "correct") throw new Error("unreachable");
    const after = memory.manage({ action: "inspect", recordId: ids.claim });
    expect(after).toMatchObject({
      record: { lifecycle: "corrected", eligible: false },
      history: [{ action: "correct", reason: "User clarified.", attribution: "user_direction", replacementId: corrected.replacementId, host: "claude-code" }],
      replacement: { recordId: corrected.replacementId, kind: "correction" },
    });
    expect(memory.manage({ action: "inspect", recordId: ids.decision })).toMatchObject({
      record: { lifecycle: "active", eligible: false, taints: [{ causeId: ids.claim, taint: "quarantined" }] },
    });
  });

  test("manage payloads are strict and validated per action", () => {
    const memory = open(initRepo(), tempDir());
    const { claim } = redisScenario(memory);
    for (const bad of [
      { action: "correct", recordId: claim, reason: "r", attribution: "user_direction" },
      { action: "retract", recordId: claim, attribution: "user_direction" },
      { action: "inspect", recordId: claim, body: "extra" },
      { action: "inspect", recordId: claim, workstreamId: "wst_x" },
      { action: "explode", recordId: claim },
      { action: "inspect", recordId: claim, v: 2 },
    ]) {
      expect(catchMemchorError(() => memory.manage(bad as never)).code).toBe("invalid_input");
    }
  });
});

describe("derived state stays consistent", () => {
  test("rebuilding the search index does not resurrect corrected or retracted memory", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    memory.manage({ action: "correct", recordId: ids.claim, body: "Redis is optional.", reason: "r", attribution: "user_direction" });
    const before = recalled(memory, "redis");
    memory.rebuildSearchIndex();
    expect(recalled(memory, "redis")).toEqual(before);
    expect(before).not.toContain(ids.claim);
  });

  test("a change that fails midway rolls back entirely: nothing corrected, tainted, audited or appended", () => {
    const memory = open(initRepo(), tempDir());
    const ids = redisScenario(memory);
    const dbPath = memory.status().storage.dbPath ?? "";
    // The ledger append is the last step before COMMIT; a directory in its place makes it fail.
    mkdirSync(join(dirname(dbPath), "lifecycle.jsonl"));
    const before = recalled(memory);
    const error = catchMemchorError(() => memory.manage({ action: "correct", recordId: ids.claim, body: "Redis is optional.", reason: "r", attribution: "user_direction" }));
    expect(error.code).toBe("storage_unavailable");
    expect(recalled(memory)).toEqual(before);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT lifecycle FROM records WHERE id = ?").get(ids.claim)).toEqual({ lifecycle: "active" });
      for (const table of ["taints", "lifecycle_events", "suppressions"]) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM records WHERE kind = 'correction'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("a correction commits the new version, the old claim's state, the taints and the audit row together", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const { claim } = redisScenario(memory);
    const dbPath = memory.status().storage.dbPath ?? "";
    memory.manage({ action: "correct", recordId: claim, body: "Redis is optional.", reason: "r", attribution: "user_direction" });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT lifecycle, superseded_by IS NOT NULL AS replaced FROM records WHERE id = ?").get(claim)).toEqual({ lifecycle: "corrected", replaced: 1 });
      expect((db.prepare("SELECT count(*) AS n FROM taints WHERE cause_id = ?").get(claim) as { n: number }).n).toBe(3);
      expect((db.prepare("SELECT count(*) AS n FROM lifecycle_events WHERE record_id = ?").get(claim) as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});
