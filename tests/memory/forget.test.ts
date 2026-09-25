import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { type ManageResult, openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string, host = "claude-code"): Memory {
  const memory = openMemory({ cwd, host, home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

const SECRET_PLAN = "Payment provider investigation: evaluated Stripe Connect payouts with account acct_SECRET42 for the old plan.";

function scenario(memory: Memory): { investigation: string; decision: string; copy: string; unrelated: string; checkpoint: string } {
  const investigation = memory.record({ kind: "evidence", title: "Old payment investigation", body: SECRET_PLAN, attribution: "direct_observation" }).recordId;
  const decision = memory.record({ kind: "decision", body: "Keep the current provider.", attribution: "agent_inference", supportedBy: [investigation] }).recordId;
  const copy = memory.record({ kind: "note", body: "Summary of the investigation.", attribution: "agent_inference", links: [{ to: investigation, relation: "derived_from" }] }).recordId;
  const unrelated = memory.record({ kind: "note", body: "Queue latency budget is 50 ms.", attribution: "agent_inference" }).recordId;
  const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "Payments", status: "Investigation archived", supportedBy: [investigation] }).recordId;
  return { investigation, decision, copy, unrelated, checkpoint };
}

function preview(memory: Memory, recordIds: string[]): Extract<ManageResult, { action: "forget_preview" }> {
  const result = memory.manage({ action: "forget_preview", recordIds });
  if (result.action !== "forget_preview") throw new Error("unreachable");
  return result;
}

function dump(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'chunks_fts%'").all() as { name: string }[]).map((t) => t.name);
    return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())).join("\n");
  } finally {
    db.close();
  }
}

describe("forget", () => {
  test("a preview lists the impact and removes nothing", () => {
    const memory = open(initRepo(), tempDir());
    const ids = scenario(memory);
    const result = preview(memory, [ids.investigation]);
    expect(result).toMatchObject({
      v: 1,
      targets: [{ recordId: ids.investigation, kind: "evidence", lifecycle: "active", title: "Old payment investigation" }],
      impact: { records: [ids.investigation], invalidated: [ids.copy], links: 3, headCheckpoint: false, suppressedEvents: 0 },
    });
    expect(result.impact.quarantined).toEqual(expect.arrayContaining([ids.decision, ids.checkpoint]));
    expect(result.impact.chunks).toBeGreaterThan(0);
    expect(result.confirmToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.notice).toMatch(/nothing has been removed/i);
    expect(memory.read({ recordId: ids.investigation }).body).toBe(SECRET_PLAN);
    expect(memory.recall({ query: "stripe payouts" }).items.map((item) => item.recordId)).toContain(ids.investigation);
  });

  test("confirming removes the payload, chunks and links, keeps a tombstone, and takes dependents out of recall", () => {
    const memory = open(initRepo(), tempDir());
    const ids = scenario(memory);
    const dbPath = memory.status().storage.dbPath ?? "";
    const { confirmToken } = preview(memory, [ids.investigation]);
    const forgotten = memory.manage({ action: "forget", confirmToken, reason: "The user asked to forget the old payment investigation.", attribution: "user_direction" });
    expect(forgotten).toMatchObject({ v: 1, action: "forget", forgotten: [ids.investigation], affected: { invalidated: [ids.copy] } });

    expect(dump(dbPath)).not.toContain("acct_SECRET42");
    expect(dump(dbPath)).not.toContain("Old payment investigation");
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"stripe"'`).get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM links WHERE from_id = ? OR to_id = ?").get(ids.investigation, ids.investigation)).toEqual({ n: 0 });
      expect(db.prepare("SELECT lifecycle, body, title FROM records WHERE id = ?").get(ids.investigation)).toEqual({ lifecycle: "forgotten", body: "", title: null });
    } finally {
      db.close();
    }
    expect(memory.recall({ query: "stripe payouts investigation" }).items).toEqual([]);
    expect(catchMemchorError(() => memory.read({ recordId: ids.investigation })).details).toMatchObject({ lifecycle: "forgotten" });
    expect(memory.manage({ action: "inspect", recordId: ids.investigation })).toMatchObject({
      record: { lifecycle: "forgotten", body: "", title: null, eligible: false },
      history: [{ action: "forget", attribution: "user_direction" }],
    });
    // Dependents keep their own content until the user forgets them too.
    expect(memory.manage({ action: "inspect", recordId: ids.copy })).toMatchObject({ record: { body: "Summary of the investigation.", eligible: false } });
    expect(memory.recall().checkpoint).toBeNull();
    expect(memory.recall({ query: "latency budget" }).items.map((item) => item.recordId)).toEqual([ids.unrelated]);

    memory.rebuildSearchIndex();
    expect(memory.recall({ query: "stripe payouts investigation" }).items).toEqual([]);
  });

  test("forgetting needs the preview's token: none, a tampered one, another workspace's, or one whose impact changed are refused", () => {
    const home = tempDir();
    const memory = open(initRepo(), home);
    const ids = scenario(memory);
    const elsewhere = open(initRepo(), home);
    const theirs = elsewhere.record({ kind: "note", body: "x", attribution: "agent_inference" }).recordId;
    const foreignToken = preview(elsewhere, [theirs]).confirmToken;

    expect(catchMemchorError(() => memory.manage({ action: "forget", reason: "r", attribution: "user_direction" } as never)).code).toBe("invalid_input");
    const { confirmToken } = preview(memory, [ids.investigation]);
    const [payload = "", signature = ""] = confirmToken.split(".");
    const tampered = `${payload}.${signature.slice(0, -2)}AA`;
    for (const token of [tampered, foreignToken]) {
      expect(catchMemchorError(() => memory.manage({ action: "forget", confirmToken: token, reason: "r", attribution: "user_direction" })).details).toMatchObject({ reason: "invalid_confirmation" });
    }

    memory.record({ kind: "note", body: "Rests on it too.", attribution: "agent_inference", supportedBy: [ids.investigation] });
    const outdated = catchMemchorError(() => memory.manage({ action: "forget", confirmToken, reason: "r", attribution: "user_direction" }));
    expect(outdated.code).toBe("invalid_input");
    expect(outdated.details).toMatchObject({ reason: "preview_outdated" });
    expect(memory.read({ recordId: ids.investigation }).body).toBe(SECRET_PLAN);
  });

  test("forgetting is permanent and cannot be repeated; other sessions are told", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const ids = scenario(memory);
    const running = open(repo, home, "codex");
    running.bootstrap();
    memory.manage({ action: "forget", confirmToken: preview(memory, [ids.investigation]).confirmToken, reason: "r", attribution: "user_direction" });

    expect(catchMemchorError(() => memory.manage({ action: "restore", recordId: ids.investigation, reason: "r", attribution: "user_direction" })).code).toBe("lifecycle_conflict");
    expect(catchMemchorError(() => preview(memory, [ids.investigation])).code).toBe("lifecycle_conflict");
    expect(running.recall().corrections?.changes).toEqual([expect.objectContaining({ recordId: ids.investigation, action: "forget" })]);
  });

  test("a corrected or retracted claim can be forgotten, and so can several records at once", () => {
    const memory = open(initRepo(), tempDir());
    const ids = scenario(memory);
    memory.manage({ action: "retract", recordId: ids.decision, reason: "r", attribution: "user_direction" });
    const result = memory.manage({ action: "forget", confirmToken: preview(memory, [ids.decision, ids.copy]).confirmToken, reason: "r", attribution: "user_direction" });
    expect(result).toMatchObject({ action: "forget", forgotten: [ids.decision, ids.copy] });
  });
});

describe("restoring an older database copy", () => {
  test("lifecycle changes made after the backup are re-applied from the ledger when the database is next opened", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const ids = scenario(memory);
    const dbPath = memory.status().storage.dbPath ?? "";
    memory.close();
    const backup = join(tempDir(), "backup.sqlite");
    copyFileSync(dbPath, backup);

    const later = open(repo, home);
    later.manage({ action: "forget", confirmToken: preview(later, [ids.investigation]).confirmToken, reason: "r", attribution: "user_direction" });
    later.manage({ action: "retract", recordId: ids.unrelated, reason: "r", attribution: "user_direction" });
    const ledger = join(dirname(dbPath), "lifecycle.jsonl");
    expect(readFileSync(ledger, "utf8")).not.toContain("acct_SECRET42");
    later.close();

    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    copyFileSync(backup, dbPath);

    const restored = open(repo, home);
    expect(restored.recall({ query: "stripe payouts investigation" }).items).toEqual([]);
    expect(restored.recall({ query: "latency budget" }).items).toEqual([]);
    expect(dump(dbPath)).not.toContain("acct_SECRET42");
    expect(restored.manage({ action: "inspect", recordId: ids.investigation })).toMatchObject({
      record: { lifecycle: "forgotten" },
      history: [expect.objectContaining({ action: "forget", reason: expect.stringMatching(/re-applied/i) as unknown })],
    });
    // Replaying twice changes nothing.
    restored.close();
    const again = open(repo, home);
    expect(again.manage({ action: "inspect", recordId: ids.investigation })).toMatchObject({ history: [expect.objectContaining({ action: "forget" })] });
  });
});
