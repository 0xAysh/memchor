#!/usr/bin/env node
import { parseArgs } from "node:util";
import { MemchorError } from "./errors.js";
import { openMemory, type Memory } from "./memory.js";
import { runStdioServer } from "./transports/mcp.js";

const USAGE = `Usage:
  memchor mcp [--host claude-code|codex|pi|unknown]   Serve MCP over stdio (started by the agent host)
  memchor diag status                                 Runtime, storage and scope health
  memchor diag records [--query <text>] [--kind <k>]  List eligible records for this worktree
  memchor diag reindex                                Rebuild the search index from canonical records
  memchor diag integrity                              SQLite, foreign-key and search-index checks

Scope is always the Git worktree of the current directory. Storage: $MEMCHOR_HOME or ~/.memchor.`;

const HOSTS = ["claude-code", "codex", "pi", "unknown"];

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  if (command === "mcp") {
    const { values } = parseArgs({ args: argv.slice(1), options: { host: { type: "string" } }, strict: true });
    if (values.host !== undefined && !HOSTS.includes(values.host)) return usage(`unknown --host ${values.host}`);
    await runStdioServer({ cwd: process.cwd(), ...(values.host === undefined ? {} : { host: values.host }) });
    return -1; // keep running until stdin ends or a signal arrives
  }
  if (command === "diag" && subcommand !== undefined) {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { query: { type: "string" }, kind: { type: "string", multiple: true } },
      strict: true,
    });
    const memory = openMemory({ cwd: process.cwd(), host: "memchor-diag" });
    try {
      return diag(memory, subcommand, values);
    } finally {
      memory.close();
    }
  }
  return usage(command === undefined || command === "--help" || command === "help" ? undefined : `unknown command ${argv.join(" ")}`);
}

function diag(memory: Memory, subcommand: string, values: { query?: string | undefined; kind?: string[] | undefined }): number {
  switch (subcommand) {
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
    case "records": {
      // Pages through recall, so the listing shows exactly what agents can see.
      const request = { maxTokens: 8000, ...(values.query === undefined ? {} : { query: values.query }), ...(values.kind === undefined ? {} : { kinds: values.kind }) };
      let pack = memory.recall(request as never);
      const scope = pack.scope;
      process.stdout.write(`${scope.workspaceLabel} / ${scope.workstreamLabel}  head r${scope.headRevision}\n`);
      if (pack.checkpoint !== null) process.stdout.write(`${pack.checkpoint.recordId}  checkpoint r${pack.checkpoint.revision}  ${oneLine(pack.checkpoint.excerpt)}\n`);
      for (;;) {
        for (const item of pack.items) {
          process.stdout.write(`${item.recordId}  ${item.kind}  ${item.attribution}  ${item.reviewState}  ${oneLine(item.title ?? item.excerpt)}\n`);
        }
        if (pack.continuation === null) break;
        pack = memory.recall({ maxTokens: 8000, continuation: pack.continuation });
      }
      if (pack.empty) process.stdout.write("(no eligible records)\n");
      return 0;
    }
    default:
      return usage(`unknown diag command ${subcommand}`);
  }
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
      process.stderr.write(JSON.stringify(error.toEnvelope(), null, 2) + "\n");
      process.exitCode = 2;
    } else {
      process.stderr.write(`memchor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 70;
    }
  },
);
