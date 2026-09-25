import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  CompatibilityRow,
  ExclusionReason,
  NormalizedEvent,
  ToolKind,
  TranscriptAdapter,
  TranscriptChunk,
  TranscriptFile,
  TranscriptHead,
} from "../normalized-event.js";
import { asObject, type JsonObject, listDir, parseObject, readLines } from "../jsonl.js";
import { shellCall } from "../shell-reads.js";
import { inCompatibility } from "../versions.js";

/**
 * Claude Code transcripts → normalized events.
 *
 * Location (official docs, https://code.claude.com/docs/en/sessions#where-transcripts-are-stored):
 * `$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`, `CLAUDE_CONFIG_DIR` defaulting to
 * `~/.claude`. `<project>` is the cwd with non-alphanumerics replaced by "-" (truncated and
 * hashed past 200 characters), so it is lossy: the workspace comes from each entry's own `cwd`,
 * never from the directory name. Subagent transcripts (`<session>/subagents/`) and auto memory
 * (`<project>/memory/`) are not read: the subagent's final report already appears in the parent
 * transcript as the Agent tool's result.
 *
 * Format: one JSON object per line. The docs state that "the entry format is internal to Claude
 * Code and changes between versions", so this adapter reads only the fields below, pins the
 * versions it accepts in {@link COMPATIBILITY}, and stops at the first entry from any other
 * version instead of guessing:
 *
 *   type, uuid, parentUuid, timestamp, cwd, gitBranch, version, isSidechain, agentId, isMeta,
 *   isCompactSummary, origin.kind, subtype, content (system), message.content[] blocks:
 *   text · thinking · redacted_thinking · tool_use{id,name,input} · tool_result{tool_use_id,content,is_error} · image
 *
 * Every other field (usage, toolUseResult, wireToolInputs, snapshots, …) is ignored. Unknown entry
 * or block types inside a supported version are skipped and counted (`unsupported_entry`), never
 * interpreted.
 */

export const COMPATIBILITY: readonly CompatibilityRow[] = [
  {
    from: "2.1.183",
    below: "2.2.0",
    format: "claude-code-jsonl-v1",
    basis:
      "Observed on 72 local transcripts written by 2.1.183–2.1.281 (2026-09): the fields read here are present and unchanged across that range; only additive keys differ. Fixtures: tests/import/fixtures/claude-code/{2.1.183,2.1.281}.",
  },
];

/** Entry types that carry host bookkeeping only (titles, modes, file snapshots, costs, links). */
const METADATA_TYPES = new Set([
  "mode",
  "permission-mode",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
  "ai-title",
  "custom-title",
  "last-prompt",
  "atis-latch",
  "queue-operation",
  "cost-state",
  "frame-link",
  "pr-link",
  "agent-name",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "fork-context-ref",
  "summary",
]);

/** Tools whose results are whole files or edits: only the call (path) is kept. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"]);
/** Memchor's own tools, under whatever name the user gave the MCP server. */
const MEMCHOR_TOOL = /^mcp__.+__(memory_(?:bootstrap|recall|read|record|checkpoint|status))$/;
/** Context Claude Code injects into user turns; not something the user wrote. */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The first entries carry the cwd; this bounds what discovery reads from each transcript. */
const HEAD_BYTES = 64 * 1024;

export function claudeCodeAdapter(options: { configDir?: string } = {}): TranscriptAdapter {
  // An empty CLAUDE_CONFIG_DIR means unset (Claude Code's own default), never "the cwd".
  const fromEnv = process.env["CLAUDE_CONFIG_DIR"];
  const configDir = options.configDir ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".claude"));
  const root = join(configDir, "projects");
  return {
    host: "claude-code",
    displayName: "Claude Code",
    compatibility: COMPATIBILITY,
    root,
    discover: () => discover(root),
    inspect,
    read,
  };
}

function discover(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  for (const project of listDir(root)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of listDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      try {
        const st = statSync(path);
        files.push({ transcriptId: basename(entry.name, ".jsonl"), path, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
      } catch {
        // Removed between listing and stat (retention sweep): not there, nothing to import.
      }
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function inspect(file: TranscriptFile): TranscriptHead {
  for (const line of readLines(file.path, 0, HEAD_BYTES)) {
    if (line.text === null) continue;
    const entry = parseObject(line.text);
    if (entry !== null && typeof entry["cwd"] === "string") {
      const hostVersion = typeof entry["version"] === "string" ? entry["version"] : null;
      return { cwd: entry["cwd"], hostVersion, supported: hostVersion !== null && isSupported(hostVersion) };
    }
  }
  return { cwd: null, hostVersion: null, supported: true };
}

function read(file: TranscriptFile, from: number, maxBytes: number): TranscriptChunk {
  const chunk: TranscriptChunk = { events: [], end: from, excluded: {}, stop: null };
  const exclude = (reason: ExclusionReason, n = 1): void => {
    chunk.excluded[reason] = (chunk.excluded[reason] ?? 0) + n;
  };
  for (const line of readLines(file.path, from, maxBytes)) {
    if (line.text === null) {
      exclude("oversized_entry");
      chunk.end = line.end;
      continue;
    }
    const entry = parseObject(line.text);
    if (entry === null) {
      exclude("malformed");
      chunk.end = line.end;
      continue;
    }
    const version = entry["version"];
    const versionedEntry = entry["type"] === "user" || entry["type"] === "assistant" || entry["type"] === "system" || entry["type"] === "attachment";
    if (versionedEntry && (typeof version !== "string" || !isSupported(version))) {
      chunk.stop = { reason: "unsupported_version", hostVersion: typeof version === "string" ? version : "missing", offset: line.start };
      return chunk;
    }
    normalizeEntry(entry, line, chunk.events, exclude);
    chunk.end = line.end;
  }
  return chunk;
}

type Entry = JsonObject;
type Excluder = (reason: ExclusionReason, n?: number) => void;

function normalizeEntry(entry: Entry, line: { start: number; end: number }, out: NormalizedEvent[], exclude: Excluder): void {
  const type = entry["type"];
  if (typeof type !== "string") { exclude("malformed"); return; }
  if (METADATA_TYPES.has(type)) { exclude("host_metadata"); return; }
  if (type !== "user" && type !== "assistant" && type !== "system" && type !== "attachment") { exclude("unsupported_entry"); return; }

  const { uuid, timestamp, cwd, version } = entry;
  if (typeof uuid !== "string" || typeof timestamp !== "string" || typeof cwd !== "string" || typeof version !== "string") {
    exclude("malformed"); return;
  }
  const origin = {
    branch: entry["isSidechain"] === true ? (typeof entry["agentId"] === "string" ? entry["agentId"] : "sidechain") : "main",
    observedAt: timestamp,
    cwd,
    gitBranch: typeof entry["gitBranch"] === "string" && entry["gitBranch"] !== "" ? entry["gitBranch"] : null,
    hostVersion: version,
    lineStart: line.start,
    lineEnd: line.end,
  };
  const eventId = (block: number): string => (block === 0 ? uuid : `${uuid}#${block}`);

  if (type === "attachment") { exclude("host_metadata"); return; }
  if (type === "system") {
    // away_summary is a recap Claude Code wrote for the user; every other subtype is bookkeeping.
    if (entry["subtype"] === "away_summary" && typeof entry["content"] === "string" && entry["content"].trim() !== "") {
      out.push({ ...origin, eventId: eventId(0), type: "host_summary", text: entry["content"].trim() });
      return;
    }
    exclude("host_metadata"); return;
  }

  const message = entry["message"];
  if (message === null || typeof message !== "object") { exclude("malformed"); return; }
  const content = (message as { content?: unknown }).content;

  if (type === "user") {
    if (entry["isCompactSummary"] === true) {
      const text = typeof content === "string" ? content : resultText(content, exclude);
      if (text.trim() !== "") out.push({ ...origin, eventId: eventId(0), type: "host_summary", text: text.trim() });
      return;
    }
    // Skill bodies, command caveats and notifications are injected by Claude Code, not typed.
    const originKind = (entry["origin"] as { kind?: unknown } | undefined)?.kind;
    if (entry["isMeta"] === true || (originKind !== undefined && originKind !== "human")) { exclude("injected_context"); return; }
    if (typeof content === "string") { pushUserText(content, 0); return; }
    if (!Array.isArray(content)) { exclude("malformed"); return; }
    let text = "";
    let textBlock = -1;
    content.forEach((block: unknown, index) => {
      const b = block as { type?: unknown; text?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        out.push({ ...origin, eventId: eventId(index), type: "tool_result", callId: b.tool_use_id, text: resultText(b.content, exclude), isError: b.is_error === true });
      } else if (b.type === "text" && typeof b.text === "string") {
        if (textBlock < 0) textBlock = index;
        text += (text === "" ? "" : "\n") + b.text;
      } else if (b.type === "image" || b.type === "document") {
        exclude("binary");
      } else {
        exclude("unsupported_entry");
      }
    });
    if (textBlock >= 0) pushUserText(text, textBlock);
    return;
  }

  // assistant
  if (!Array.isArray(content)) { exclude("malformed"); return; }
  content.forEach((block: unknown, index) => {
    const b = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === "thinking" || b.type === "redacted_thinking") { exclude("hidden_reasoning"); return; }
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.trim() !== "") out.push({ ...origin, eventId: eventId(index), type: "message", role: "assistant", text: b.text.trim() });
      return;
    }
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      out.push({ ...origin, eventId: eventId(index), type: "tool_call", callId: b.id, tool: b.name, ...describeCall(b.name, asObject(b.input), cwd) });
      return;
    }
    exclude("unsupported_entry");
  });

  function pushUserText(raw: string, block: number): void {
    let injected = 0;
    const text = raw.replace(INJECTED, () => {
      injected++;
      return "";
    });
    if (injected > 0) exclude("injected_context", injected);
    if (text.trim() !== "") out.push({ ...origin, eventId: eventId(block), type: "message", role: "user", text: text.trim() });
  }
}

/** One-line description, touched paths and semantic kind of a tool call, from its input. */
function describeCall(name: string, input: Entry, cwd: string): { summary: string; paths: string[]; urls: string[]; toolKind: ToolKind; inputDigest?: string } {
  const str = (key: string): string | null => (typeof input[key] === "string" ? input[key] : null);
  const memchor = MEMCHOR_TOOL.exec(name);
  if (memchor !== null) return { summary: `${memchor[1] ?? name} ${JSON.stringify(input)}`, paths: [], urls: [], toolKind: "memchor" };
  if (FILE_TOOLS.has(name)) {
    const path = str("file_path") ?? str("notebook_path");
    const offset = typeof input["offset"] === "number" ? input["offset"] : null;
    const limit = typeof input["limit"] === "number" ? input["limit"] : null;
    const lines = offset !== null && limit !== null ? ` (lines ${offset}-${offset + limit - 1})` : "";
    return { summary: `${name} ${path ?? "(no path)"}${lines}`, paths: path === null ? [] : [path], urls: [], toolKind: "artifact_access" };
  }
  switch (name) {
    case "Bash":
      // A command that only prints files inside the cwd is a file read, like Read (see shell-reads.ts).
      return { summary: `$ ${str("command") ?? ""}`, urls: [], ...shellCall(str("command"), cwd, cwd) };
    case "Grep":
    case "Glob": {
      const path = str("path");
      return { summary: `${name} ${JSON.stringify(str("pattern") ?? "")}${path === null ? "" : ` in ${path}`}`, paths: path === null ? [] : [path], urls: [], toolKind: "other" };
    }
    case "WebFetch": {
      const url = str("url");
      return { summary: `WebFetch ${url ?? ""}`, paths: [], urls: url === null ? [] : [url], toolKind: "other" };
    }
    case "WebSearch":
      return { summary: `WebSearch ${JSON.stringify(str("query") ?? "")}`, paths: [], urls: [], toolKind: "other" };
    case "Agent":
    case "Task":
      return { summary: `${name}: ${str("description") ?? ""}`, paths: [], urls: [], toolKind: "other" };
    default:
      // Unknown schemas are not safe to summarize. Keep only a deterministic digest for
      // event-version identity; importer bookkeeping never persists this digest or input.
      return {
        summary: `${name} [arguments omitted]`,
        paths: [],
        urls: [],
        toolKind: "other",
        inputDigest: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`,
      };
  }
}

function resultText(content: unknown, exclude: Excluder): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image" || block.type === "document") exclude("binary");
    else if (block.type === "tool_reference") exclude("host_metadata");
    else exclude("unsupported_entry");
  }
  return parts.join("\n");
}

function isSupported(version: string): boolean {
  return inCompatibility(version, COMPATIBILITY);
}
