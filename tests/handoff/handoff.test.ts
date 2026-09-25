import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapResult, CheckpointResult, ContextPack, PackItem, ReadResult, RecordResult } from "../../src/memory.js";
import { git, tempDir } from "../helpers.js";
import { claudeConfigDir, codexHome, codexThreadId, installCodexRollout, installTranscript, renderCodexFixture } from "../import/fixtures.js";
import { spawnServer, type ServerHandle } from "../mcp/harness.js";
import { writeArtifact } from "./artifacts.js";

/**
 * The central V1 story (issue #20, PRD §18 "Handoff"), proved across real processes: separate
 * `memchor mcp` servers for Claude Code and Codex share one MEMCHOR_HOME and one Git worktree,
 * and each imports only hand-written transcripts from its own temporary host history dir. Every
 * server runs with the no-network preload. The packs these tests see are written, with temporary
 * paths replaced by placeholders, to the git-ignored `tests/mcp/__artifacts__/handoff/` as PR evidence.
 */

/** Claude's root-cause message in `2.1.281/basic.jsonl`, repeated verbatim by Codex in `0.148.0-alpha.21/handoff.jsonl`. */
const ROOT_CAUSE = "Root cause: charge() retries a 504 up to three times without an idempotency key, so the gateway settles the first attempt and the retry charges again.";
const CLAUDE_TIMEOUT = "The gateway timeout is 30 s, so a 504 arrives before the first charge settles.";
const CODEX_TIMEOUT = "The gateway timeout is 10 s, not 30 s: src/gateway.ts passes timeoutMs 10000.";
const DECISION = "Charge with a server-side idempotency key per order; remove client retries.";
const FAILED_ATTEMPT = "Tried serialising charge() behind a per-order mutex: the retry still fires after the lock is released, so the order is charged twice.";
const RETRY_FACT = "src/retry.ts: backoff() retries every 5xx, including 504, with no idempotency key.";

/** A committed repository at `<fresh temp dir>/<name>` (so two can share a basename) with the two files the story is about. */
function storeRepo(name = "store"): string {
  const dir = join(tempDir("memchor-handoff-"), name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=fix/double-charge");
  writeFileSync(join(dir, "src/gateway.ts"), "export async function charge(order) {\n  return retry(() => post(order), { retries: 3 });\n}\n");
  writeFileSync(join(dir, "src/retry.ts"), "export function backoff(status) {\n  return status >= 500;\n}\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "checkout");
  return dir;
}

function networkLogIsEmpty(path: string): boolean {
  return (existsSync(path) ? readFileSync(path, "utf8") : "") === "";
}

function item(pack: ContextPack, body: string, host?: string): PackItem {
  const found = pack.items.find((i) => i.excerpt === body && (host === undefined || i.host === host));
  if (found === undefined) throw new Error(`no item "${body.slice(0, 40)}…"${host === undefined ? "" : ` from ${host}`} in the pack`);
  return found;
}

describe("Claude → fresh Codex → fresh Claude handoff across processes", () => {
  test("continues one workstream with attributed Claude and Codex memory, live freshness, kept conflicts, CAS checkpoints and no cross-workspace leakage", async () => {
    const home = tempDir("memchor-home-");
    const repo = storeRepo();
    const otherRepo = storeRepo();
    const claudeDir = claudeConfigDir();
    const codexDir = codexHome();
    const logs: string[] = [];
    const placeholders: [string, string][] = [
      [repo, "<repo>"],
      [otherRepo, "<other-repo-same-basename>"],
      [home, "<memchor-home>"],
      [claudeDir, "<claude-config-dir>"],
      [codexDir, "<codex-home>"],
    ];
    const spawn = async (cwd: string, host: "claude-code" | "codex", meta?: Record<string, unknown>): Promise<ServerHandle> => {
      const networkLog = join(tempDir("memchor-net-"), "network.log");
      logs.push(networkLog);
      return spawnServer({ cwd, home, host, claudeConfigDir: claudeDir, codexHome: codexDir, networkLog, ...(meta === undefined ? {} : { meta }) });
    };
    /** Every pack the main repository's sessions returned after the other repository had memory. */
    const mainPacks: ContextPack[] = [];

    // Both repositories have Claude history; a /branch copy re-stores the main session's entries under a new session id.
    const claudeParent = installTranscript(claudeDir, "2.1.281/basic.jsonl", { cwd: repo });
    const claudeBranch = installTranscript(claudeDir, "2.1.281/basic.jsonl", { cwd: repo });
    installTranscript(claudeDir, "2.1.281/basic.jsonl", { cwd: otherRepo });

    // ── (a) Claude session: consent, import, decision, failed attempt, facts, checkpoint ──
    const claude = await spawn(repo, "claude-code");
    const asked = await claude.ok<BootstrapResult>("memory_bootstrap");
    expect(asked.import).toMatchObject({ host: "claude-code", state: "consent_required" });
    expect(asked.import.question).toMatch(/^Memchor found 3 local Claude Code sessions \(2 in this project, 1 in other projects\)/);
    const claudeBoot = await claude.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    expect(claudeBoot.import).toMatchObject({ state: "complete", currentProject: { transcripts: 2, complete: 2 } });
    expect(claudeBoot.scope).toMatchObject({ workspaceLabel: "store", workstreamLabel: "fix/double-charge", resolvedBy: "new_workstream", headRevision: 0, host: "claude-code" });
    const scope = claudeBoot.scope;
    const userAsk = item(claudeBoot.context, "Use a server-side idempotency key per order; do not add client retries.", "claude-code");
    const rootCause = claudeBoot.context.items.find((i) => i.excerpt === ROOT_CAUSE);
    expect(rootCause).toBeDefined();

    const gatewayRef = { kind: "code", locator: "src/gateway.ts", path: "src/gateway.ts" };
    const retryRef = { kind: "code", locator: "src/retry.ts", path: "src/retry.ts" };
    const decision = await claude.ok<RecordResult>("memory_record", { kind: "decision", body: DECISION, attribution: "user_direction", supportedBy: [userAsk.recordId], externalRefs: [gatewayRef] });
    const attempt = await claude.ok<RecordResult>("memory_record", { kind: "attempt", body: FAILED_ATTEMPT, attribution: "direct_observation", externalRefs: [gatewayRef] });
    const retryFact = await claude.ok<RecordResult>("memory_record", { kind: "evidence", body: RETRY_FACT, attribution: "direct_observation", externalRefs: [retryRef] });
    const claudeTimeout = await claude.ok<RecordResult>("memory_record", { kind: "evidence", body: CLAUDE_TIMEOUT, attribution: "agent_inference" });
    const claudeCheckpoint = await claude.ok<CheckpointResult>("memory_checkpoint", {
      expectedRevision: 0,
      goal: "Stop checkout double-charging when the gateway times out",
      status: "Root cause found in the retry loop; fix not started.",
      decisions: [DECISION],
      failedAttempts: [FAILED_ATTEMPT],
      nextSteps: ["Drop 504 from backoff() in src/retry.ts and add an idempotency key to charge()"],
      supportedBy: [decision.recordId, attempt.recordId, retryFact.recordId],
      externalRefs: [gatewayRef],
    });
    expect(claudeCheckpoint).toMatchObject({ revision: 1, previousRevision: 0 });
    await claude.close();

    // The unrelated repository with the same directory name gets its own Claude memory (same MEMCHOR_HOME, same host dirs).
    const otherClaude = await spawn(otherRepo, "claude-code");
    expect((await otherClaude.ok<BootstrapResult>("memory_bootstrap")).import.state).toBe("not_approved");
    const otherBoot = await otherClaude.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    expect(otherBoot.scope).toMatchObject({ workspaceLabel: "store", workstreamLabel: "fix/double-charge", resolvedBy: "new_workstream" });
    expect(otherBoot.scope.workspaceId).not.toBe(scope.workspaceId);
    const otherDecision = await otherClaude.ok<RecordResult>("memory_record", { kind: "decision", body: "Keep client retries: the upstream gateway deduplicates charges.", attribution: "user_direction" });
    await otherClaude.ok("memory_record", { kind: "evidence", body: CLAUDE_TIMEOUT, attribution: "agent_inference" });
    const otherCheckpoint = await otherClaude.ok<CheckpointResult>("memory_checkpoint", { expectedRevision: 0, goal: "Unrelated store work", status: "zebracorn status of the other repository" });
    const otherImported = (await otherClaude.ok<ContextPack>("memory_recall", { maxTokens: 8_000 })).items.map((i) => i.recordId);
    await otherClaude.close();

    // ── (b) Live state moves on: the second file is edited, the first is untouched; Codex has history ──
    writeFileSync(join(repo, "src/retry.ts"), "export function backoff(status) {\n  return status >= 500 && status !== 504;\n}\n");
    const threadId = codexThreadId();
    installCodexRollout(codexDir, "", { cwd: repo, threadId, content: renderCodexFixture("0.148.0-alpha.21/handoff.jsonl", { cwd: repo, threadId, recordId: rootCause?.recordId ?? "" }) });
    const otherThread = codexThreadId();
    installCodexRollout(codexDir, "0.148.0-alpha.21/handoff.jsonl", { cwd: otherRepo, threadId: otherThread });

    // A second Claude session opens now and reads revision 1; it will try to publish after Codex.
    const lateClaude = await spawn(repo, "claude-code");
    expect((await lateClaude.ok<BootstrapResult>("memory_bootstrap")).scope.headRevision).toBe(1);

    // ── (c) Fresh Codex session on thread T in the same worktree ──
    const codex = await spawn(repo, "codex", { threadId });
    const codexAsked = await codex.ok<BootstrapResult>("memory_bootstrap");
    expect(codexAsked.import).toMatchObject({ host: "codex", state: "consent_required" });
    expect(codexAsked.import.question).toMatch(/^Memchor found 2 local Codex sessions \(1 in this project, 1 in other projects\)/);
    const codexBoot = await codex.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    mainPacks.push(codexBoot.context);
    expect(codexBoot.import).toMatchObject({ state: "complete", currentProject: { transcripts: 1, complete: 1, counters: { echoes: 1 } } });
    expect(codexBoot.scope).toMatchObject({
      workspaceId: scope.workspaceId,
      workstreamId: scope.workstreamId,
      workstreamLabel: "fix/double-charge",
      resolvedBy: "worktree_binding",
      headRevision: 1,
      host: "codex",
      ambiguity: null,
    });
    // Claude's checkpoint, decision and failed attempt arrive with Claude provenance.
    const context = codexBoot.context;
    expect(context.checkpoint).toMatchObject({ revision: 1, host: "claude-code", recordId: claudeCheckpoint.recordId });
    expect(context.checkpoint?.excerpt).toContain(FAILED_ATTEMPT);
    const decisionItem = item(context, DECISION);
    expect(decisionItem).toMatchObject({ recordId: decision.recordId, kind: "decision", host: "claude-code", attribution: "user_direction", citations: [{ recordId: userAsk.recordId, relation: "supported_by" }] });
    expect(item(context, FAILED_ATTEMPT)).toMatchObject({ recordId: attempt.recordId, kind: "attempt", host: "claude-code" });
    // Unchanged file: current, no warning (reuse without re-reading). Edited file: stale, read the live code.
    expect(decisionItem).toMatchObject({ freshness: "current", warning: null, externalRefs: [expect.objectContaining({ path: "src/gateway.ts", freshness: "current", reason: "unchanged" })] });
    const staleItem = item(context, RETRY_FACT);
    expect(staleItem).toMatchObject({ recordId: retryFact.recordId, freshness: "stale", externalRefs: [expect.objectContaining({ path: "src/retry.ts", freshness: "stale", reason: "changed" })] });
    expect(staleItem.warning).toMatch(/Read the current file/);
    // The bootstrap pack alone already carries both hosts' side of the timeout disagreement.
    expect(item(context, CLAUDE_TIMEOUT, "claude-code")).toBeDefined();
    expect(item(context, CODEX_TIMEOUT, "codex").source).toMatchObject({ host: "codex", transcriptId: threadId });
    expect(context.budget.usedBytes).toBeLessThanOrEqual(context.budget.maxBytes);
    expect(context.budget).toMatchObject({ maxTokens: 2_000, maxBytes: 8_000 });

    // Codex's own imported history, attributed to Codex; the conflicting claims are both kept.
    const conflict = await codex.ok<ContextPack>("memory_recall", { query: "gateway timeout", maxTokens: 8_000 });
    mainPacks.push(conflict);
    const claudeSide = item(conflict, CLAUDE_TIMEOUT, "claude-code");
    const codexSide = item(conflict, CODEX_TIMEOUT, "codex");
    expect(claudeSide).toMatchObject({ recordId: claudeTimeout.recordId, source: null, independentRoot: `record:${claudeTimeout.recordId}`, corroboration: { independentRoots: 1, records: 1 } });
    expect(codexSide).toMatchObject({ attribution: "agent_inference", source: { host: "codex", transcriptId: threadId }, corroboration: { independentRoots: 1, records: 1 } });
    expect(codexSide.independentRoot).toMatch(new RegExp(`^event:codex/${threadId}@\\d+$`));

    // Root rule: the /branch copy is the same Claude observation (one item listing the copy). Codex
    // stating the claim after its own failing test run, before recalling anything, is a second
    // observation. Its verbatim repeat after the Memchor recall echoed Claude's record is a copy of
    // that record (derived_from), and the echo itself is never a record, so neither corroborates.
    const roots = await codex.ok<ContextPack>("memory_recall", { query: "root cause retries idempotency key", maxTokens: 8_000 });
    mainPacks.push(roots);
    const stated = roots.items.filter((i) => i.excerpt === ROOT_CAUSE);
    expect(stated.map((i) => i.host).sort()).toEqual(["claude-code", "codex"]);
    for (const i of stated) expect(i.corroboration).toEqual({ independentRoots: 2, records: 4 });
    const claudeRoot = stated.find((i) => i.host === "claude-code");
    const copies = claudeRoot?.copies.map((c) => c.source?.transcriptId) ?? [];
    expect(copies).toHaveLength(2);
    expect(copies).toEqual(expect.arrayContaining([threadId, expect.stringMatching(new RegExp(`^(${claudeParent.sessionId}|${claudeBranch.sessionId})$`))]));
    const codexOwn = stated.find((i) => i.host === "codex");
    expect(codexOwn?.copies).toEqual([]);
    expect(codexOwn?.independentRoot).toMatch(new RegExp(`^event:codex/${threadId}@\\d+$`));

    // Codex continues: restating Claude's decision with a citation is a copy of it, not corroboration.
    const restated = await codex.ok<RecordResult>("memory_record", { kind: "note", body: DECISION, attribution: "agent_inference", links: [{ to: decision.recordId, relation: "derived_from" }] });
    const fix = await codex.ok<RecordResult>("memory_record", {
      kind: "evidence",
      body: "backoff() in src/retry.ts no longer retries 504; charge() still sends no idempotency key.",
      attribution: "direct_observation",
      externalRefs: [retryRef],
    });
    const copyPack = await codex.ok<ContextPack>("memory_recall", { query: "server-side idempotency key per order", maxTokens: 8_000 });
    mainPacks.push(copyPack);
    expect(item(copyPack, DECISION)).toMatchObject({ recordId: decision.recordId, corroboration: { independentRoots: 1, records: 2 }, copies: [expect.objectContaining({ recordId: restated.recordId, host: "codex" })] });

    // A normal pack: the head checkpoint and the decisions and attempts, all still current.
    const normal = await codex.ok<ContextPack>("memory_recall", { query: "idempotency key mutex", kinds: ["decision", "attempt"] });
    mainPacks.push(normal);
    expect(normal.checkpoint).toMatchObject({ revision: 1, host: "claude-code", freshness: "current", warning: null });
    expect(normal.items.map((i) => i.recordId).sort()).toEqual([decision.recordId, attempt.recordId].sort());
    for (const i of normal.items) expect(i).toMatchObject({ host: "claude-code", freshness: "current", warning: null });

    const codexCheckpoint = await codex.ok<CheckpointResult>("memory_checkpoint", {
      expectedRevision: 1,
      goal: "Stop checkout double-charging when the gateway times out",
      status: "Codex: backoff() no longer retries 504; idempotency key for charge() not added yet. Gateway timeout disputed (30 s vs 10 s).",
      decisions: [DECISION],
      failedAttempts: [FAILED_ATTEMPT],
      openQuestions: ["Is the gateway timeout 30 s or 10 s?"],
      nextSteps: ["Add an idempotency key to charge() in src/gateway.ts"],
      supportedBy: [fix.recordId, decision.recordId],
      externalRefs: [retryRef],
    });
    expect(codexCheckpoint).toMatchObject({ revision: 2, previousRevision: 1 });
    await codex.close();

    // The Claude session that read revision 1 cannot overwrite Codex's revision 2.
    const stale = await lateClaude.call("memory_checkpoint", { expectedRevision: 1, goal: "late", status: "written from an old read" });
    expect(stale).toMatchObject({ isError: true, structured: { error: { code: "checkpoint_conflict", retryable: false, details: { currentRevision: 2 } } } });
    await lateClaude.close();

    // The other repository's Codex thread imports into its own workspace only.
    const otherCodex = await spawn(otherRepo, "codex", { threadId: otherThread });
    expect((await otherCodex.ok<BootstrapResult>("memory_bootstrap")).import.state).toBe("not_approved");
    const otherCodexBoot = await otherCodex.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    expect(otherCodexBoot.scope).toMatchObject({ workspaceId: otherBoot.scope.workspaceId, workstreamId: otherBoot.scope.workstreamId });
    const otherCodexItems = (await otherCodex.ok<ContextPack>("memory_recall", { query: "gateway timeout", maxTokens: 8_000 })).items;
    expect(item({ items: otherCodexItems } as ContextPack, CODEX_TIMEOUT, "codex").source?.transcriptId).toBe(otherThread);
    expect(otherCodexItems.some((i) => i.source?.transcriptId === threadId)).toBe(false);
    await otherCodex.close();

    // ── (d) Fresh Claude session: Codex's checkpoint and the freshness warnings ──
    const resumed = await spawn(repo, "claude-code");
    const resumedBoot = await resumed.ok<BootstrapResult>("memory_bootstrap");
    mainPacks.push(resumedBoot.context);
    expect(resumedBoot.scope).toMatchObject({ workspaceId: scope.workspaceId, workstreamId: scope.workstreamId, resolvedBy: "worktree_binding", headRevision: 2, host: "claude-code" });
    expect(resumedBoot.context.checkpoint).toMatchObject({ revision: 2, host: "codex", recordId: codexCheckpoint.recordId, freshness: "current", warning: null });
    expect(resumedBoot.context.checkpoint?.excerpt).toContain("Gateway timeout disputed");
    const resumedStale = item(resumedBoot.context, RETRY_FACT);
    expect(resumedStale).toMatchObject({ host: "claude-code", freshness: "stale" });
    expect(resumedStale.warning).toMatch(/Read the current file/);
    expect(item(resumedBoot.context, "backoff() in src/retry.ts no longer retries 504; charge() still sends no idempotency key.")).toMatchObject({ host: "codex", freshness: "current" });

    // ── (g) Truncation: bodies are cut, never warnings, citations or reference freshness ──
    const query = "backoff retries 504 src/retry.ts";
    const full = await resumed.ok<ContextPack>("memory_recall", { query, maxTokens: 8_000 });
    const firstPage = await resumed.ok<ContextPack>("memory_recall", { query, maxBytes: 1_000 });
    const nextPage = await resumed.ok<ContextPack>("memory_recall", { continuation: firstPage.continuation, maxBytes: 1_100 });
    mainPacks.push(full, firstPage, nextPage);
    expect(firstPage).toMatchObject({ truncated: true, items: [], checkpoint: { recordId: codexCheckpoint.recordId, truncated: true } });
    expect(firstPage.checkpoint?.excerpt).toMatch(/cut by Memchor.*memory_read/);
    expect(firstPage.checkpoint).toMatchObject({ citations: full.checkpoint?.citations, externalRefs: full.checkpoint?.externalRefs, warning: full.checkpoint?.warning });
    expect(nextPage.items.length).toBeGreaterThan(0);
    for (const page of [firstPage, nextPage]) {
      expect(page.budget.usedBytes).toBeLessThanOrEqual(page.budget.maxBytes);
      for (const cut of page.items) {
        const whole = full.items.find((i) => i.recordId === cut.recordId);
        expect(cut).toMatchObject({ warning: whole?.warning, citations: whole?.citations, externalRefs: whole?.externalRefs, freshness: whole?.freshness, independentRoot: whole?.independentRoot });
        if (cut.excerpt !== whole?.excerpt) expect(cut.excerpt).toMatch(/cut by Memchor/);
      }
    }
    expect(nextPage.items.some((i) => i.freshness === "stale" && i.warning !== null)).toBe(true);

    // ── (e) No cross-workspace leakage: nothing of the same-named repository in any main pack; direct reads refused ──
    const probe = await resumed.ok<ContextPack>("memory_recall", { query: "upstream gateway deduplicates zebracorn", maxTokens: 8_000 });
    mainPacks.push(probe);
    expect(probe.items.map((i) => i.excerpt).join("\n")).not.toMatch(/upstream gateway deduplicates|zebracorn/);
    const leaked = [otherBoot.scope.workspaceId, otherBoot.scope.workstreamId ?? "", otherDecision.recordId, otherCheckpoint.recordId, ...otherImported, "zebracorn", "upstream gateway deduplicates", otherThread];
    expect(mainPacks).toHaveLength(10);
    for (const pack of mainPacks) {
      const text = JSON.stringify(pack);
      for (const id of leaked) expect(text).not.toContain(id);
    }
    for (const recordId of [otherDecision.recordId, otherCheckpoint.recordId, ...otherImported]) {
      expect((await resumed.call("memory_read", { recordId })).structured).toMatchObject({ error: { code: "not_found" } });
    }
    // The main repository's own records stay readable, with their live freshness.
    expect(await resumed.ok<ReadResult>("memory_read", { recordId: retryFact.recordId })).toMatchObject({ freshness: "stale", host: "claude-code" });
    await resumed.close();

    for (const log of logs) expect(networkLogIsEmpty(log), log).toBe(true);
    expect(logs).toHaveLength(6);

    writeArtifact("1-claude-bootstrap", claudeBoot, placeholders);
    writeArtifact("2-codex-bootstrap", codexBoot, placeholders);
    writeArtifact("3-claude-resumed-bootstrap", resumedBoot, placeholders);
    writeArtifact("pack-normal", normal, placeholders);
    writeArtifact("pack-copies", copyPack, placeholders);
    writeArtifact("pack-stale", context, placeholders);
    writeArtifact("pack-conflicting", conflict, placeholders);
    writeArtifact("pack-truncated", { firstPage, nextPage }, placeholders);
  }, 120_000);

  test("a worktree two earlier sessions could continue asks instead of guessing, stays workspace-level until the choice, then binds it", async () => {
    const home = tempDir("memchor-home-");
    const repo = storeRepo();
    const logs: string[] = [];
    const spawn = async (cwd: string, host: "claude-code" | "codex"): Promise<ServerHandle> => {
      const networkLog = join(tempDir("memchor-net-"), "network.log");
      logs.push(networkLog);
      return spawnServer({ cwd, home, host, claudeConfigDir: claudeConfigDir(), codexHome: codexHome(), networkLog });
    };
    const worktree = (branch: string, create = false): string => {
      const path = join(tempDir("memchor-wt-"), "wt");
      git(repo, "worktree", "add", "--quiet", ...(create ? ["-b", branch, path] : [path, branch]));
      return path;
    };

    // The main worktree's workstream is bound to a live worktree, so it is never offered elsewhere.
    const main = await spawn(repo, "claude-code");
    const mainScope = (await main.ok<BootstrapResult>("memory_bootstrap")).scope;
    const shared = await main.ok<RecordResult>("memory_record", { kind: "preference", body: "Never log card numbers.", attribution: "user_direction", workspaceLevel: true });
    const mainOnly = await main.ok<RecordResult>("memory_record", { kind: "decision", body: "Main worktree decision about webhooks.", attribution: "user_direction" });
    await main.close();

    // Claude worked on feat/webhook in a worktree that is gone now.
    const first = worktree("feat/webhook", true);
    const claude = await spawn(first, "claude-code");
    const a = (await claude.ok<BootstrapResult>("memory_bootstrap")).scope.workstreamId ?? "";
    const aDecision = await claude.ok<RecordResult>("memory_record", { kind: "decision", body: "Deduplicate webhook settlement by event id.", attribution: "user_direction" });
    await claude.ok("memory_checkpoint", { expectedRevision: 0, goal: "Deduplicate webhook settlement", status: "dedupe table drafted", nextSteps: ["add the unique index"] });
    await claude.close();
    git(repo, "worktree", "remove", "--force", first);

    // Codex, in another worktree on the same branch, was asked and started a separate workstream.
    const second = worktree("feat/webhook");
    const codex = await spawn(second, "codex");
    expect((await codex.ok<BootstrapResult>("memory_bootstrap")).scope.ambiguity?.candidates.map((c) => c.workstreamId)).toEqual([a]);
    const b = (await codex.ok<BootstrapResult>("memory_bootstrap", { workstream: "new" })).scope.workstreamId ?? "";
    await codex.ok("memory_checkpoint", { expectedRevision: 0, goal: "Retry webhook delivery with backoff", status: "backoff schedule agreed", nextSteps: ["wire the scheduler"] });
    await codex.close();
    git(repo, "worktree", "remove", "--force", second);

    // A third worktree on the branch: the branch is evidence for both, identity for neither.
    const third = worktree("feat/webhook");
    const session = await spawn(third, "claude-code");
    const asked = await session.ok<BootstrapResult>("memory_bootstrap");
    expect(asked.scope).toMatchObject({ workspaceId: mainScope.workspaceId, workstreamId: null, workstreamLabel: null, resolvedBy: null, headRevision: 0, branch: "feat/webhook" });
    expect(asked.scope.ambiguity?.question).toMatch(/workstream set to the chosen workstreamId, or "new"/);
    const candidates = asked.scope.ambiguity?.candidates ?? [];
    expect(candidates.map((c) => c.workstreamId).sort()).toEqual([a, b].sort());
    expect(candidates.find((c) => c.workstreamId === a)).toMatchObject({ branch: "feat/webhook", headRevision: 1, lastCheckpoint: { goal: "Deduplicate webhook settlement", next: "add the unique index" }, reasons: [expect.objectContaining({ signal: "branch" })] });
    expect(candidates.find((c) => c.workstreamId === b)).toMatchObject({ headRevision: 1, lastCheckpoint: { goal: "Retry webhook delivery with backoff" } });
    expect(candidates.map((c) => c.workstreamId)).not.toContain(mainScope.workstreamId);

    // Workspace-level only: no checkpoint, no workstream memory, workstream writes refused.
    expect(asked.context).toMatchObject({ checkpoint: null, items: [expect.objectContaining({ recordId: shared.recordId, workspaceLevel: true })] });
    expect(asked.context.notice).toMatch(/No workstream is bound yet/);
    expect((await session.call("memory_read", { recordId: aDecision.recordId })).structured).toMatchObject({ error: { code: "scope_denied" } });
    expect((await session.call("memory_read", { recordId: mainOnly.recordId })).structured).toMatchObject({ error: { code: "scope_denied" } });
    for (const [tool, args] of [
      ["memory_record", { kind: "note", body: "guessing would merge unrelated work", attribution: "agent_inference" }],
      ["memory_checkpoint", { expectedRevision: 0, goal: "g", status: "s" }],
    ] as const) {
      expect((await session.call(tool, args)).structured).toMatchObject({ error: { code: "scope_ambiguous", details: { candidates: expect.arrayContaining([a, b]) as unknown } } });
    }

    // The user's choice binds this session and the worktree for later sessions of any host.
    const chosen = await session.ok<BootstrapResult>("memory_bootstrap", { workstream: a });
    expect(chosen.scope).toMatchObject({ workstreamId: a, resolvedBy: "choice", ambiguity: null, headRevision: 1 });
    expect(chosen.context.checkpoint?.excerpt).toContain("Deduplicate webhook settlement");
    expect(chosen.context.items.map((i) => i.recordId)).toContain(aDecision.recordId);
    expect((await session.call("memory_record", { kind: "note", body: "after choosing", attribution: "agent_inference" })).isError).toBe(false);
    await session.close();
    const later = await spawn(third, "codex");
    expect((await later.ok<BootstrapResult>("memory_bootstrap")).scope).toMatchObject({ workstreamId: a, resolvedBy: "worktree_binding", ambiguity: null });
    await later.close();

    for (const log of logs) expect(networkLogIsEmpty(log), log).toBe(true);
    writeArtifact("pack-ambiguous", { asked, chosen }, [
      [repo, "<repo>"],
      [third, "<new-worktree-on-feat-webhook>"],
      [home, "<memchor-home>"],
    ]);
  }, 120_000);
});
