#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveHome } from "./bootstrap/workspace-resolution.js";
import { MemchorError } from "./errors.js";
import { HOST_IDS, hostDescriptor, TRANSCRIPT_HOSTS } from "./hosts.js";
import { type ImportStatus, openMemory, type Memory } from "./memory.js";
import { IMPORT_CHOICES, type ImportChoice, LIMITS } from "./schemas.js";
import { assertEmbeddedRuntime } from "./storage/database.js";
import { runStdioServer } from "./transports/mcp.js";

const USAGE = `Usage:
  memchor mcp [--host ${HOST_IDS.join("|")}]
                                                      Serve MCP over stdio (started by the agent host)
  memchor diag status                                 Runtime, storage and scope health
  memchor diag records [--query <text>] [--kind <k>]  List eligible records for this worktree
  memchor diag reindex                                Rebuild the search index from canonical records
  memchor diag integrity                              SQLite, foreign-key and search-index checks
  memchor diag demo [--temp-home]                     Run bootstrap → record → checkpoint → recall here and print the pack
                                                      (writes demo records to $MEMCHOR_HOME, or to a new temp home)
  memchor diag consent [--set ${IMPORT_CHOICES.join("|")}] [--host ${TRANSCRIPT_HOSTS.join("|")}]
                                                      Show (or change) the host's transcript-import decision
  memchor diag import [--host ${TRANSCRIPT_HOSTS.join("|")}]
                                                      Import approved transcripts to completion and print progress

Scope is always the Git worktree of the current directory. Storage: $MEMCHOR_HOME or ~/.memchor.`;

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  if (command === "mcp") {
    const { values } = parseArgs({ args: argv.slice(1), options: { host: { type: "string" } }, strict: true });
    if (values.host !== undefined && hostDescriptor(values.host) === null) return usage(`unknown --host ${values.host}`);
    // Fail at startup, visibly, rather than on the first tool call inside the host.
    assertEmbeddedRuntime();
    await runStdioServer({ cwd: process.cwd(), ...(values.host === undefined ? {} : { host: values.host }) });
    return -1; // keep running until stdin ends or a signal arrives
  }
  if (command === "diag" && subcommand !== undefined) {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        query: { type: "string" },
        kind: { type: "string", multiple: true },
        "temp-home": { type: "boolean" },
        set: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
    });
    const home = values["temp-home"] === true ? mkdtempSync(join(tmpdir(), "memchor-demo-")) : resolveHome(undefined);
    // Transcript commands act as the host whose history they manage; the rest as a diagnostic tool.
    const transcripts = subcommand === "consent" || subcommand === "import";
    // A host that cannot import would only report "unsupported" for a mistyped name.
    if (transcripts && values.host !== undefined && !(TRANSCRIPT_HOSTS as string[]).includes(values.host)) {
      return usage(`--host must be one of ${TRANSCRIPT_HOSTS.join(", ")} (got ${values.host})`);
    }
    const host = values.host ?? (transcripts ? "claude-code" : "memchor-diag");
    if (values.set !== undefined && !IMPORT_CHOICES.includes(values.set as ImportChoice)) return usage(`--set must be one of ${IMPORT_CHOICES.join(", ")}`);
    const memory = openMemory({ cwd: process.cwd(), host, home });
    try {
      return diag(memory, subcommand, values, home);
    } finally {
      memory.close();
    }
  }
  return usage(command === undefined || command === "--help" || command === "help" ? undefined : `unknown command ${argv.join(" ")}`);
}

function diag(memory: Memory, subcommand: string, values: { query?: string | undefined; kind?: string[] | undefined; set?: string | undefined }, home: string): number {
  switch (subcommand) {
    case "consent": {
      const status = values.set === undefined ? memory.status().import : memory.bootstrap({ importChoice: values.set as ImportChoice }).import;
      print({ consent: status?.consent ?? null, state: status?.state ?? null, transcripts: status?.transcripts ?? null, transcriptsRoot: status?.transcriptsRoot ?? null });
      return 0;
    }
    case "import": {
      const started = performance.now();
      let peakRss = process.memoryUsage().rss;
      let status: ImportStatus = memory.bootstrap().import;
      const afterBootstrapMs = Math.round(performance.now() - started);
      for (let done = status.state !== "in_progress"; !done; ) {
        const step = memory.continueImport({ maxMs: 1_000 });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        status = step;
        done = step.done || step.problem !== null;
      }
      print({ elapsedMs: Math.round(performance.now() - started), afterBootstrapMs, peakRssMB: Math.round(peakRss / 1e6), import: status });
      return status.problem === null ? 0 : 1;
    }
    case "status":
      print(memory.status());
      return 0;
    case "reindex":
      print(memory.rebuildSearchIndex());
      return 0;
    case "integrity": {
      const report = memory.checkIntegrity();
      print(report);
      return report.ok ? 0 : 1;
    }
    case "demo":
      print(demo(memory, home));
      return 0;
    case "records": {
      // Pages through recall, so the listing shows exactly what agents can see.
      const request = { maxTokens: LIMITS.maxTokens, ...(values.query === undefined ? {} : { query: values.query }), ...(values.kind === undefined ? {} : { kinds: values.kind }) };
      let pack = memory.recall(request as never);
      const scope = pack.scope;
      process.stdout.write(`${scope.workspaceLabel} / ${scope.workstreamLabel}  head r${scope.headRevision}\n`);
      if (pack.checkpoint !== null) process.stdout.write(`${pack.checkpoint.recordId}  checkpoint r${pack.checkpoint.revision}  ${oneLine(pack.checkpoint.excerpt)}\n`);
      for (;;) {
        for (const item of pack.items) {
          process.stdout.write(`${item.recordId}  ${item.kind}  ${item.attribution}  ${item.reviewState}  ${oneLine(item.title ?? item.excerpt)}\n`);
        }
        if (pack.continuation === null) break;
        pack = memory.recall({ maxTokens: LIMITS.maxTokens, continuation: pack.continuation });
      }
      if (pack.empty) process.stdout.write("(no eligible records)\n");
      return 0;
    }
    default:
      return usage(`unknown diag command ${subcommand}`);
  }
}

/** The tracer-bullet flow through the public interface; returns the recalled pack. */
function demo(memory: Memory, home: string): unknown {
  process.stderr.write(`memchor demo: writing demo records to ${home}\n`);
  const { scope } = memory.bootstrap({ hostSessionId: "memchor-diag-demo" });
  const evidence = memory.record({
    kind: "evidence",
    title: "Memchor demo observation",
    body: "memchor demo tracer: the memory database opened in WAL mode with FTS5 available.",
    attribution: "direct_observation",
  });
  const decision = memory.record({
    kind: "decision",
    body: "memchor demo tracer: keep one SQLite database per workspace.",
    attribution: "agent_inference",
    supportedBy: [evidence.recordId],
  });
  memory.checkpoint({
    expectedRevision: scope.headRevision,
    goal: "memchor demo tracer",
    status: "Recorded one observation and one decision.",
    nextSteps: ["Recall them from a fresh session"],
    supportedBy: [evidence.recordId, decision.recordId],
  });
  return memory.recall({ query: "memchor demo tracer" });
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function usage(problem?: string): number {
  if (problem !== undefined) process.stderr.write(`memchor: ${problem}\n\n`);
  process.stderr.write(USAGE + "\n");
  return problem === undefined ? 0 : 64;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof MemchorError) {
      process.stderr.write(`memchor: ${error.message}\n${JSON.stringify(error.toEnvelope(), null, 2)}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`memchor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 70;
    }
  },
);
