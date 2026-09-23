// The low-level `Server` is used on purpose: `McpServer` validates tool input itself
// and answers failures with its own error text, which would bypass the memory module's
// `invalid_input` envelope. Here the module is the only validator.
/* eslint-disable @typescript-eslint/no-deprecated */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemchorError } from "../errors.js";
import { type Memory, openMemory } from "../memory.js";
import { BootstrapInput, CheckpointInput, ReadInput, RecallInput, RecordInput, StatusInput } from "../schemas.js";

/**
 * Thin MCP adapter over the memory module. It holds no memory policy: it forwards raw
 * tool arguments to the module (which parses them with its own schemas), returns results
 * as structuredContent plus the same JSON as text, and maps `MemchorError` to an
 * `isError: true` envelope `{ error: { code, message, retryable, details } }`.
 */

const INSTRUCTIONS = `Memchor is local working memory shared by the coding agents used in this repository.
- Call memory_bootstrap first. Tell the user the workspace/workstream it resolved, read the returned context before redoing prior research, and verify live repository state before changing code: memory describes the work, the repository is the source of truth.
- Record consequential observations, decisions, failed attempts, preferences and next steps with memory_record. Set attribution honestly (user_direction, direct_observation, agent_inference) and cite supporting evidence with supportedBy.
- Never re-record memory_recall/memory_read output as new evidence; cite the existing recordId instead.
- Before finishing, publish memory_checkpoint with expectedRevision = the headRevision you last read. On checkpoint_conflict, recall, reconcile deliberately and retry; never overwrite.
- An empty or partial pack is an honest miss: do not invent prior context. Report storage errors and conflicts to the user.`;

interface ToolSpec {
  schema: z.ZodType;
  description: string;
  run: (memory: Memory, args: unknown) => object;
}

// Arguments are passed through untyped: the module's own `parse` is the only validation.
const TOOLS: Record<string, ToolSpec> = {
  memory_bootstrap: {
    schema: BootstrapInput,
    description:
      "Call first in every session. Resolves this repository's workspace and workstream (never from arguments), and returns the head checkpoint plus recent memory, or an honest empty result.",
    run: (memory, args) => memory.bootstrap(args as never),
  },
  memory_recall: {
    schema: RecallInput,
    description:
      "Return a bounded, cited context pack: the head checkpoint first, then eligible records ranked for the query. Respects maxTokens/maxBytes; follow `continuation` for more. Items carry recordIds, citations, attribution and freshness; verify live artifacts before acting on them.",
    run: (memory, args) => memory.recall(args as never),
  },
  memory_read: {
    schema: ReadInput,
    description: "Expand one record by recordId within a byte/token budget; continue with nextOffset. Other workstreams' and retracted records are refused.",
    run: (memory, args) => memory.read(args as never),
  },
  memory_record: {
    schema: RecordInput,
    description:
      "Store one attributed piece of working knowledge (evidence, decision, attempt, preference, constraint, question, next_step, note, reference). Store knowledge about artifacts and point to them with externalRefs; never paste whole files. Cite evidence with supportedBy. Use operationKey to make retries safe. Do not re-record recalled memory.",
    run: (memory, args) => memory.record(args as never),
  },
  memory_checkpoint: {
    schema: CheckpointInput,
    description:
      "Publish the workstream's continuation state (goal, status, decisions, failed attempts, open questions, next steps) before finishing. Compare-and-swap: pass expectedRevision = the headRevision you last read; a checkpoint_conflict means someone else published first, so recall and reconcile.",
    run: (memory, args) => memory.checkpoint(args as never),
  },
  memory_status: {
    schema: StatusInput,
    description: "Report Memchor health: embedded SQLite/FTS5 runtime, schema version, database path, resolved scope, counts and capabilities.",
    run: (memory, args) => memory.status(args as never),
  },
};

const TOOL_LIST = Object.entries(TOOLS).map(([name, spec]) => {
  const inputSchema = z.toJSONSchema(spec.schema, { io: "input" }) as { type: "object"; [key: string]: unknown };
  delete inputSchema["$schema"];
  return { name, description: spec.description, inputSchema };
});

export interface McpServerOptions {
  cwd: string;
  /** From `--host`; falls back to the MCP client's name, then "unknown". */
  host?: string;
  home?: string;
  log?: (message: string) => void;
}

/**
 * Builds the server. The Memory opens lazily on the first tool call, after the
 * initialize handshake, so the client's name is known when no `--host` was given.
 */
export function createMcpServer(options: McpServerOptions): { server: Server; close: () => void } {
  const log = options.log ?? ((message: string) => process.stderr.write(`memchor: ${message}\n`));
  const server = new Server({ name: "memchor", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  let memory: Memory | undefined;
  const getMemory = (): Memory => {
    memory ??= openMemory({
      cwd: options.cwd,
      host: options.host ?? server.getClientVersion()?.name ?? "unknown",
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    return memory;
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const spec = TOOLS[request.params.name];
    if (spec === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${request.params.name}`);
    try {
      const result = spec.run(getMemory(), request.params.arguments ?? {}) as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      if (!(error instanceof MemchorError)) {
        log(`internal error in ${request.params.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        throw new McpError(ErrorCode.InternalError, "Memchor hit an internal error; the outcome is unknown, so recall before retrying a write.");
      }
      const envelope = error.toEnvelope();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: { ...envelope } };
    }
  });

  return {
    server,
    close: () => {
      memory?.close();
      memory = undefined;
    },
  };
}

/**
 * Serves MCP over stdio until stdin ends or SIGTERM/SIGINT arrives, then closes the
 * database. Stdout carries only JSON-RPC; everything else (including stray console
 * output) goes to stderr.
 */
export async function runStdioServer(options: McpServerOptions): Promise<void> {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(String).join(" ") + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const { server, close } = createMcpServer(options);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`memchor: MCP server ready (cwd ${options.cwd})\n`);
}
