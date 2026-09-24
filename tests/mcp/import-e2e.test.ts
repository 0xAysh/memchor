import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";
import { spawnServer } from "./harness.js";

interface Item {
  recordId: string;
  kind: string;
  attribution: string;
  excerpt: string;
  citations: { recordId: string; relation: string }[];
  source: { kind: string; host: string; transcriptId: string; eventId: string } | null;
}
interface Pack {
  items: Item[];
}
interface ImportView {
  state: string;
  question: string | null;
  backfill: { reconciled: boolean } | null;
}

describe("transcript import over MCP", () => {
  test("fixture transcript → consent → import → cited context pack with Claude provenance, with no network access", async () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const other = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const networkLog = join(tempDir(), "network.log");
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    installTranscript(config, "2.1.183/basic.jsonl", { cwd: other });

    const server = await spawnServer({ cwd: repo, home, host: "claude-code", claudeConfigDir: config, networkLog });
    const first = await server.ok<{ import: ImportView; context: Pack }>("memory_bootstrap");
    expect(first.import.state).toBe("consent_required");
    expect(first.import.question).toMatch(/^Memchor found 2 local Claude Code sessions \(1 in this project, 1 in other projects\)/);
    expect(first.context.items).toEqual([]);

    const approved = await server.ok<{ import: ImportView; context: Pack }>("memory_bootstrap", { importChoice: "all" });
    const observation = approved.context.items.find((i) => i.excerpt.startsWith("$ npm test -- gateway"));
    expect(observation).toMatchObject({
      kind: "evidence",
      attribution: "direct_observation",
      source: { kind: "transcript", host: "claude-code", transcriptId: session.sessionId, eventId: "00000000-0000-4000-8000-000000000006" },
    });

    // The agent builds on the imported observation; the pack cites it.
    const decision = await server.ok<{ recordId: string }>("memory_record", {
      kind: "decision",
      body: "Charge with a server-side idempotency key per order; remove client retries.",
      attribution: "user_direction",
      supportedBy: [observation?.recordId],
    });
    const pack = await server.ok<Pack>("memory_recall", { query: "idempotency key client retries" });
    expect(pack.items.find((i) => i.recordId === decision.recordId)?.citations).toEqual([{ recordId: observation?.recordId, relation: "supported_by" }]);
    expect(pack.items.some((i) => i.source?.host === "claude-code")).toBe(true);

    // Remaining approved history (the other project) is backfilled while the server stays up.
    let status = await server.ok<{ import: ImportView }>("memory_status");
    for (let tries = 0; status.import.backfill?.reconciled !== true && tries < 100; tries++) {
      await new Promise((r) => setTimeout(r, 50));
      status = await server.ok<{ import: ImportView }>("memory_status");
    }
    expect(status.import).toMatchObject({ state: "complete", backfill: { reconciled: true } });
    await server.close();

    const elsewhere = await spawnServer({ cwd: other, home, host: "claude-code", claudeConfigDir: config, networkLog });
    const otherPack = await elsewhere.ok<Pack>("memory_recall", { query: "page count" });
    expect(otherPack.items[0]).toMatchObject({ source: { host: "claude-code" } });
    expect(otherPack.items[0]?.excerpt).toMatch(/Math\.floor/);
    await elsewhere.close();

    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  });
});
