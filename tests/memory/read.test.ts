import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchMemchorError, git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string): Memory {
  const memory = openMemory({ cwd, host: "pi", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("read", () => {
  test("reads a record in budgeted slices that reassemble the exact body", () => {
    const memory = open(initRepo(), tempDir());
    const body = "Ünïcödé 🚀 observation. ".repeat(200);
    const { recordId } = memory.record({ kind: "evidence", title: "long", body, attribution: "direct_observation" });

    let offset = 0;
    let assembled = "";
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(50);
      const slice = memory.read({ recordId, maxBytes: 500, offset });
      expect(Buffer.byteLength(slice.body)).toBeLessThanOrEqual(500);
      expect(slice.budget.usedBytes).toBe(Buffer.byteLength(slice.body));
      assembled += slice.body;
      if (slice.nextOffset === null) {
        expect(slice.truncated).toBe(false);
        break;
      }
      expect(slice.truncated).toBe(true);
      offset = slice.nextOffset;
    }
    expect(assembled).toBe(body);
  });

  test("an offset inside a surrogate pair snaps back to the start of that code point", () => {
    const memory = open(initRepo(), tempDir());
    const { recordId } = memory.record({ kind: "note", body: "a😀b", attribution: "agent_inference" });
    const slice = memory.read({ recordId, offset: 2 });
    expect(slice.offset).toBe(1);
    expect(slice.body).toBe("😀b");
  });

  test("maxTokens bounds the slice at four bytes per token", () => {
    const memory = open(initRepo(), tempDir());
    const { recordId } = memory.record({ kind: "note", body: "a".repeat(1000), attribution: "agent_inference" });
    const slice = memory.read({ recordId, maxTokens: 50 });
    expect(slice.body).toHaveLength(200);
    expect(slice.budget).toMatchObject({ maxTokens: 50, maxBytes: 200, usedBytes: 200, usedTokens: 50 });
    expect(slice.nextOffset).toBe(200);
  });

  test("another workstream's record is scope_denied; retracted and unknown records are not_found", () => {
    const repo = initRepo();
    const home = tempDir();
    const worktree = join(tempDir("memchor-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const mine = open(repo, home);
    const foreign = open(worktree, home).record({ kind: "note", body: "theirs", attribution: "agent_inference" });
    const retracted = mine.record({ kind: "note", body: "wrong", attribution: "agent_inference", reviewState: "retracted" });

    expect(catchMemchorError(() => mine.read({ recordId: foreign.recordId })).code).toBe("scope_denied");
    expect(catchMemchorError(() => mine.read({ recordId: retracted.recordId })).code).toBe("not_found");
    expect(catchMemchorError(() => mine.read({ recordId: "rec_" + "f".repeat(32) })).code).toBe("not_found");
    expect(catchMemchorError(() => mine.read({ recordId: "../../etc/passwd" })).code).toBe("invalid_input");
  });

  test("links are returned in both directions, only when the other end is visible", () => {
    const memory = open(initRepo(), tempDir());
    const evidence = memory.record({ kind: "evidence", body: "e", attribution: "direct_observation" });
    const decision = memory.record({ kind: "decision", body: "d", attribution: "agent_inference", supportedBy: [evidence.recordId] });
    memory.record({ kind: "note", body: "later retracted note", attribution: "agent_inference", reviewState: "retracted" });

    expect(memory.read({ recordId: evidence.recordId }).links).toEqual([
      { recordId: decision.recordId, relation: "supported_by", direction: "incoming" },
    ]);
    const read = memory.read({ recordId: decision.recordId });
    expect(read.links).toEqual([{ recordId: evidence.recordId, relation: "supported_by", direction: "outgoing" }]);
    expect(read).toMatchObject({ kind: "decision", attribution: "agent_inference", reviewState: "unreviewed", freshness: "unknown", host: "pi" });
    expect(read.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
