import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { asObject, type JsonObject, type Line, listDir, parseAny, parseObject, readLines } from "../jsonl.js";
import type {
  CompatibilityRow,
  EventOrigin,
  ExclusionReason,
  NormalizedEvent,
  ToolKind,
  TranscriptAdapter,
  TranscriptChunk,
  TranscriptFile,
  TranscriptHead,
} from "../normalized-event.js";
import { shellCall } from "../shell-reads.js";
import { inCompatibility } from "../versions.js";

/**
 * Codex rollouts → normalized events.
 *
 * Location (openai/codex `rollout/src/lib.rs`, `utils/home-dir`): `$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<local time>-<thread id>.jsonl`, moved flat into `$CODEX_HOME/archived_sessions/` when a
 * thread is archived (the id survives the move). `CODEX_HOME` defaults to `~/.codex`. Nothing
 * else under it is read: not `auth.json`, `config.toml`, `session_index.jsonl` (thread names)
 * or the SQLite state databases.
 *
 * Format: one `{timestamp, type, payload}` object per line. The only version stamp is
 * `session_meta.payload.cli_version` on the first line, and it names the thread's *creator*: a
 * newer Codex that resumes the thread appends without re-stamping. So the table gates the whole
 * file on its creator, and inside a supported file every unknown entry or payload type is
 * skipped and counted (`unsupported_entry`), never interpreted. Fields read:
 *
 *   session_meta{id, cwd, cli_version, history_mode, forked_from_id, source, thread_source, git.branch}
 *   turn_context{cwd} · event_msg{user_message{message, images, local_images, audio, local_audio},
 *   agent_message{message}} · response_item{message.role/content, function_call{name, namespace,
 *   arguments{cmd, command, workdir, …}, call_id}, custom_tool_call{name, input, call_id}, local_shell_call{action.command},
 *   web_search_call{id, action}, *_output{call_id, output}} · compacted{message}
 *
 * Messages come from one source per role: `event_msg/user_message` (Codex's own record of what the
 * user typed, never injected context) and `event_msg/agent_message`. The `response_item` message
 * copies of the same turns would double every message; they are counted as metadata, or as
 * injected context for developer messages and Codex's contextual user blocks.
 *
 * Paginated rollouts (0.148+, `history_mode` ≠ "legacy" or a per-line `ordinal`) drop those events
 * in favour of `item_completed`; they stop the read with `unsupported_version` ("<v>+paginated").
 */

export const COMPATIBILITY: readonly CompatibilityRow[] = [
  {
    from: "0.125.0-alpha.3",
    below: "0.143.0",
    format: "codex-rollout-legacy-v1",
    basis:
      "Observed on 110 local Codex Desktop rollouts written by 0.125.0-alpha.3, 0.126.0-alpha.8, 0.133.0-alpha.1 and 0.142.0–0.142.5 (2026-02…09): the fields read here are present and unchanged, only additive keys differ; openai/codex rust-v0.142.5 has no history_mode. Fixtures: tests/import/fixtures/codex/{0.125.0-alpha.3,0.142.5}.",
  },
  {
    from: "0.148.0-alpha.21",
    below: "0.148.0-alpha.22",
    format: "codex-rollout-legacy-v1",
    basis:
      "Legacy-mode rollouts written by the bundled codex-cli 0.148.0-alpha.21 through `codex app-server` thread/start in a temporary CODEX_HOME; source at rust-v0.148.0-alpha.21 still persists user_message/agent_message/mcp_tool_call_end in legacy mode. Fixtures: tests/import/fixtures/codex/0.148.0-alpha.21.",
  },
];

const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;
/** The first line (session_meta, with Codex's full base instructions) is 10–45 KiB in practice. */
const HEAD_BYTES = 1 << 20;
/**
 * How far back `read` looks for the `turn_context` that sets the cwd of the lines after `from`.
 * Codex writes one per turn; a turn with more output than this between its context and `from`
 * falls back to the thread's initial cwd (see docs/architecture.md, known limits).
 */
const CONTEXT_SCAN_BYTES = [64 << 10, 256 << 10, 1 << 20];

/** Memchor's own tools, under whatever name the user gave the MCP server (Codex may append `_<12 hex>` on a name collision). */
const MEMCHOR_TOOL = /^mcp__.+__(memory_(?:bootstrap|recall|read|record|checkpoint|status))(?:_[0-9a-f]{12})?$/;
/** Codex's framing of a tool output: exec (`Process exited with code N`), apply_patch (`Exit code: N`) and MCP (`Wall time`). */
const OUTPUT_HEADER = /^(?:Chunk ID: [^\n]*\n)?(?:Exit code: (-?\d+)\n)?Wall time: [^\n]*\n(?:Process exited with code (-?\d+)\n|Process running with session ID [^\n]*\n)?(?:Original token count: [^\n]*\n)?Output:\n/;
/** Codex's local-compaction summary starts with this sentence (`prompts/templates/compact/summary_prefix.md`), then a newline. */
const SUMMARY_PREFIX = "Another language model started to solve this problem";
/** Blocks Codex injects into user turns (`core/src/context/contextual_user_message.rs`); counted, never imported. */
const CONTEXTUAL_USER = ["# agents.md instructions", "<environment_context>", "<external_", "<skill>", "<user_shell_command>", "<turn_aborted>", "<subagent_notification>", "<codex_internal_context", "<goal_context>", "<recommended_plugins>", "<hook_prompt", "<user_instructions>", "warning: "];

/** event_msg payload types that carry bookkeeping or duplicate a response_item (e.g. the *_end events). */
const METADATA_EVENTS = new Set([
  "token_count",
  "task_started",
  "task_complete",
  "turn_aborted",
  "thread_rolled_back",
  "context_compacted",
  "error",
  "warning",
  "exec_command_end",
  "patch_apply_end",
  "mcp_tool_call_end",
  "web_search_end",
  "image_generation_end",
  "thread_name_updated",
  "thread_settings_applied",
  "item_completed",
  "entered_review_mode",
  "exited_review_mode",
  "sub_agent_activity",
]);
const METADATA_ITEMS = new Set(["tool_search_call", "tool_search_output", "compaction", "context_compaction", "other", "agent_message"]);
const METADATA_TYPES = new Set(["world_state", "security_risk_score", "inter_agent_communication", "inter_agent_communication_metadata"]);

type Entry = JsonObject;
type Excluder = (reason: ExclusionReason, n?: number) => void;

/** What line 1 says about the whole rollout. */
interface Head {
  id: string;
  cwd: string;
  version: string;
  gitBranch: string | null;
  paginated: boolean;
  forkedFrom: string | null;
  subagent: boolean;
  /** Byte just past line 1. */
  end: number;
}

/** A fork's copied parent prefix: child line start → the parent line it copies. */
interface ForkPrefix {
  parentId: string;
  lines: Map<number, { start: number; timestamp: string }>;
}

export function codexAdapter(options: { codexHome?: string } = {}): TranscriptAdapter {
  // An empty CODEX_HOME means unset, as in Codex itself (`find_codex_home`).
  const fromEnv = process.env["CODEX_HOME"];
  const root = options.codexHome ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".codex"));
  /** Line 1 never changes in an append-only rollout, so a head is read once per path. */
  const heads = new Map<string, Head | null>();
  /** Settled fork prefixes (the copy ended before the file did). */
  const forks = new Map<string, ForkPrefix | null>();

  const headOf = (path: string): Head | null => {
    if (heads.has(path)) return heads.get(path) ?? null;
    const head = readHead(path);
    // A file with no complete first line yet is looked at again next time.
    if (head !== undefined) heads.set(path, head);
    return head ?? null;
  };

  const discover = (): TranscriptFile[] => {
    const byId = new Map<string, TranscriptFile>();
    const consider = (dir: string, name: string): void => {
      const match = ROLLOUT_NAME.exec(name);
      if (match === null) return;
      const path = join(dir, name);
      let file: TranscriptFile;
      try {
        const st = statSync(path);
        if (!st.isFile()) return;
        // A reverted paginated thread keeps its thread id with a rollout suffix; it is its own file.
        file = { transcriptId: `${match[1] ?? ""}${match[2] ?? ""}`.toLowerCase(), path, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
      } catch {
        return; // removed or archived between listing and stat
      }
      // A subagent's "user" is its parent agent, and the parent already holds its result (like Claude's subagents).
      if (headOf(path)?.subagent === true) return;
      const seen = byId.get(file.transcriptId);
      // Archiving is a rename, so one id in both places is a transient copy: keep the fuller one.
      if (seen === undefined || file.size > seen.size || (file.size === seen.size && file.mtimeMs > seen.mtimeMs)) byId.set(file.transcriptId, file);
    };
    const walk = (dir: string, depth: number): void => {
      for (const entry of listDir(dir)) {
        if (entry.isDirectory() && depth > 0) walk(join(dir, entry.name), depth - 1);
        else if (!entry.isDirectory()) consider(dir, entry.name);
      }
    };
    walk(join(root, "sessions"), 3);
    walk(join(root, "archived_sessions"), 0);
    return [...byId.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };

  const inspect = (file: TranscriptFile): TranscriptHead => {
    const head = headOf(file.path);
    if (head === null) return { cwd: null, hostVersion: null, supported: true };
    return { cwd: head.cwd, hostVersion: head.version, supported: isSupported(head.version) && !head.paginated };
  };

  const forkPrefix = (file: TranscriptFile, head: Head): ForkPrefix | null => {
    if (head.forkedFrom === null) return null;
    if (forks.has(file.path)) return forks.get(file.path) ?? null;
    const parent = discover().find((f) => f.transcriptId === head.forkedFrom);
    if (parent === undefined) return null; // not cached: the parent may be unarchived later
    const prefix = matchPrefix(file.path, head, parent.path, head.forkedFrom);
    if (prefix.settled) forks.set(file.path, prefix.prefix);
    return prefix.prefix;
  };

  const read = (file: TranscriptFile, from: number, maxBytes: number): TranscriptChunk => {
    const chunk: TranscriptChunk = { events: [], end: from, excluded: {}, stop: null };
    const exclude: Excluder = (reason, n = 1) => {
      chunk.excluded[reason] = (chunk.excluded[reason] ?? 0) + n;
    };
    const head = headOf(file.path);
    const lines = readLines(file.path, from, maxBytes);
    if (lines.length === 0) return chunk;
    if (head === null) {
      // No readable session_meta: nothing can be attributed (cwd, version), so fail closed.
      chunk.stop = { reason: "unsupported_version", hostVersion: "missing", offset: from };
      return chunk;
    }
    if (!isSupported(head.version) || head.paginated) {
      chunk.stop = { reason: "unsupported_version", hostVersion: head.paginated ? `${head.version}+paginated` : head.version, offset: from };
      return chunk;
    }
    const context = from <= head.end ? { cwd: head.cwd, gitBranch: head.gitBranch } : contextBefore(file.path, from, head);
    const fork = forkPrefix(file, head);
    for (const line of lines) {
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
      if (typeof entry["ordinal"] === "number") {
        chunk.stop = { reason: "unsupported_version", hostVersion: `${head.version}+paginated`, offset: line.start };
        return chunk;
      }
      const copied = fork?.lines.get(line.start);
      normalizeEntry(entry, line, { head, context, copied: copied === undefined || fork === null ? null : { parentId: fork.parentId, ...copied } }, chunk.events, exclude);
      chunk.end = line.end;
    }
    return chunk;
  };

  return { host: "codex", displayName: "Codex", compatibility: COMPATIBILITY, root, discover, inspect, read };
}

function isSupported(version: string): boolean {
  return inCompatibility(version, COMPATIBILITY);
}

/** Line 1, or null when it is not a usable session_meta; undefined when no complete line exists yet. */
function readHead(path: string): Head | null | undefined {
  const [line] = readLines(path, 0, 1);
  if (line === undefined) return undefined;
  if (line.text === null || line.end > HEAD_BYTES) return null;
  const entry = parseObject(line.text);
  if (entry?.["type"] !== "session_meta") return null;
  const payload = asObject(entry["payload"]);
  const { id, cwd, cli_version: version } = payload;
  if (typeof id !== "string" || typeof cwd !== "string" || typeof version !== "string") return null;
  const source = payload["source"];
  return {
    id,
    cwd,
    version,
    gitBranch: branchOf(payload),
    paginated: (payload["history_mode"] !== undefined && payload["history_mode"] !== "legacy") || typeof entry["ordinal"] === "number",
    forkedFrom: typeof payload["forked_from_id"] === "string" ? payload["forked_from_id"] : null,
    subagent: payload["thread_source"] === "subagent" || (source !== null && typeof source === "object" && "subagent" in source),
    end: line.end,
  };
}

function branchOf(payload: Entry): string | null {
  const branch = asObject(payload["git"])["branch"];
  return typeof branch === "string" && branch !== "" ? branch : null;
}

/**
 * The cwd and git branch in force at `from`: the last `turn_context` (cwd is per turn, and a
 * turn may move the thread to another directory) and the last own-id `session_meta` (Codex
 * appends a copy with updated `git` when the branch moves) before it. Scanned backwards in
 * growing windows up to 1 MiB; beyond that the thread's initial values are used.
 */
function contextBefore(path: string, from: number, head: Head): { cwd: string; gitBranch: string | null } {
  for (const size of CONTEXT_SCAN_BYTES) {
    const start = Math.max(head.end, from - size);
    const lines = readLines(path, start, from - start).filter((line) => line.end <= from);
    // A window that starts mid-line begins with a fragment.
    if (start > head.end) lines.shift();
    let gitBranch: string | null | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i]?.text;
      if (text === null || text === undefined) continue;
      const lead = text.slice(0, 160);
      if (lead.includes('"type":"session_meta"') && gitBranch === undefined) {
        const payload = asObject(parseObject(text)?.["payload"]);
        if (payload["id"] === head.id) gitBranch = branchOf(payload);
      } else if (lead.includes('"type":"turn_context"')) {
        const cwd = asObject(parseObject(text)?.["payload"])["cwd"];
        if (typeof cwd === "string") return { cwd, gitBranch: gitBranch === undefined ? head.gitBranch : gitBranch };
      }
    }
    if (start === head.end) return { cwd: head.cwd, gitBranch: gitBranch === undefined ? head.gitBranch : gitBranch };
  }
  return { cwd: head.cwd, gitBranch: head.gitBranch };
}

/**
 * A fork starts with a verbatim, re-timestamped copy of its parent's rollout (Codex
 * `ForkPersistence::Copied`), which the parent's own import already holds. Mapping each copied
 * line to the parent line it copies keeps the parent's event identity, so the copy is recalled
 * as a copy of the same observation, never as independent corroboration. The match is exact
 * (payload and type equal, timestamp ignored), line by line from the parent's first line, and
 * stops at the first divergence: after it, lines are the fork's own.
 */
function matchPrefix(childPath: string, head: Head, parentPath: string, parentId: string): { prefix: ForkPrefix; settled: boolean } {
  const prefix: ForkPrefix = { parentId, lines: new Map() };
  let childAt = head.end;
  let parentAt = 0;
  let childLines: Line[] = [];
  let parentLines: Line[] = [];
  for (;;) {
    if (childLines.length === 0) childLines = readLines(childPath, childAt, 1 << 20);
    if (parentLines.length === 0) parentLines = readLines(parentPath, parentAt, 1 << 20);
    const child = childLines.shift();
    const parent = parentLines.shift();
    // The fork's own file ended inside the copy: more may still be appended, so not settled.
    if (child === undefined) return { prefix, settled: false };
    if (parent === undefined || child.text === null || parent.text === null) return { prefix, settled: true };
    const a = parseObject(child.text);
    const b = parseObject(parent.text);
    const timestamp = b?.["timestamp"];
    if (a === null || b === null || typeof timestamp !== "string" || withoutTimestamp(a) !== withoutTimestamp(b)) return { prefix, settled: true };
    prefix.lines.set(child.start, { start: parent.start, timestamp });
    childAt = child.end;
    parentAt = parent.end;
  }
}

function withoutTimestamp(entry: Entry): string {
  return JSON.stringify({ ...entry, timestamp: null });
}

interface LineContext {
  head: Head;
  /** Mutable: turn_context and own-id session_meta lines update it as they go by. */
  context: { cwd: string; gitBranch: string | null };
  /** Set when this line is a copy of a parent line (forks). */
  copied: { parentId: string; start: number; timestamp: string } | null;
}

function normalizeEntry(entry: Entry, line: { start: number; end: number }, ctx: LineContext, out: NormalizedEvent[], exclude: Excluder): void {
  const type = entry["type"];
  const payload = entry["payload"];
  const timestamp = entry["timestamp"];
  if (typeof type !== "string" || typeof timestamp !== "string" || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    exclude("malformed");
    return;
  }
  const p = payload as Entry;
  switch (type) {
    case "session_meta":
      // Only the thread's own metadata updates move its branch; a foreign id is the parent's meta inside a fork's copy.
      if (p["id"] === ctx.head.id) ctx.context.gitBranch = branchOf(p);
      exclude("host_metadata");
      return;
    case "turn_context":
      if (typeof p["cwd"] === "string") ctx.context.cwd = p["cwd"];
      exclude("host_metadata");
      return;
    case "compacted": {
      const message = typeof p["message"] === "string" ? p["message"].trim() : "";
      if (message === "") {
        // Remote compaction: the summary is encrypted; replacement_history only repeats earlier turns.
        exclude("host_metadata");
        return;
      }
      const text = message.startsWith(SUMMARY_PREFIX) && message.includes("\n") ? message.slice(message.indexOf("\n") + 1).trim() : message;
      if (text !== "") out.push({ ...origin(ctx, line, timestamp, 0), type: "host_summary", text });
      return;
    }
    case "event_msg":
      eventMessage(p, ctx, line, timestamp, out, exclude);
      return;
    case "response_item":
      responseItem(p, ctx, line, timestamp, out, exclude);
      return;
    default:
      exclude(METADATA_TYPES.has(type) ? "host_metadata" : "unsupported_entry");
  }
}

/** Identity and place of an event. `<thread id>@<byte offset>` is globally unique (recall roots use host + event id only). */
function origin(ctx: LineContext, line: { start: number; end: number }, timestamp: string, block: number): EventOrigin {
  const suffix = block === 0 ? "" : `#${block}`;
  return {
    branch: "main",
    // Legacy rollouts are append-only and their events carry no ids of their own, so the line's
    // offset is the event's stable identity; a fork's copy keeps the parent line's identity and time.
    eventId: ctx.copied === null ? `${ctx.head.id}@${line.start}${suffix}` : `${ctx.copied.parentId}@${ctx.copied.start}${suffix}`,
    observedAt: ctx.copied === null ? timestamp : ctx.copied.timestamp,
    cwd: ctx.context.cwd,
    gitBranch: ctx.context.gitBranch,
    hostVersion: ctx.head.version,
    lineStart: line.start,
    lineEnd: line.end,
  };
}

function eventMessage(p: Entry, ctx: LineContext, line: { start: number; end: number }, timestamp: string, out: NormalizedEvent[], exclude: Excluder): void {
  const kind = p["type"];
  if (kind === "user_message" || kind === "agent_message") {
    if (typeof p["message"] !== "string") {
      exclude("malformed");
      return;
    }
    if (kind === "user_message") {
      for (const key of ["images", "local_images", "audio", "local_audio"]) {
        const media = p[key];
        if (Array.isArray(media) && media.length > 0) exclude("binary", media.length);
      }
    }
    const text = p["message"].trim();
    if (text !== "") out.push({ ...origin(ctx, line, timestamp, 0), type: "message", role: kind === "user_message" ? "user" : "assistant", text });
    return;
  }
  if (typeof kind === "string" && kind.startsWith("agent_reasoning")) exclude("hidden_reasoning");
  else if (typeof kind === "string" && METADATA_EVENTS.has(kind)) exclude("host_metadata");
  else exclude("unsupported_entry");
}

function responseItem(p: Entry, ctx: LineContext, line: { start: number; end: number }, timestamp: string, out: NormalizedEvent[], exclude: Excluder): void {
  const kind = p["type"];
  const at = (block: number) => origin(ctx, line, timestamp, block);
  switch (kind) {
    case "message": {
      const role = p["role"];
      if (role === "developer" || role === "system") exclude("injected_context");
      else if (role === "user" && isContextual(p["content"])) exclude("injected_context");
      // The user's and the assistant's words are imported from their event_msg twins.
      else exclude("host_metadata");
      return;
    }
    case "reasoning":
      exclude("hidden_reasoning");
      return;
    case "function_call":
    case "custom_tool_call": {
      const { name, call_id: callId } = p;
      if (typeof name !== "string" || typeof callId !== "string") {
        exclude("malformed");
        return;
      }
      const namespace = typeof p["namespace"] === "string" ? p["namespace"] : null;
      // Codex's own joiner (`core/src/tools/handlers/mcp.rs::join_tool_name`).
      const tool = namespace === null ? name : `${namespace.replace(/_+$/, "")}__${name.replace(/^_+/, "")}`;
      let input: unknown;
      if (kind === "custom_tool_call") input = typeof p["input"] === "string" ? { input: p["input"] } : null;
      else input = typeof p["arguments"] === "string" ? parseAny(p["arguments"]) : null;
      const raw = kind === "custom_tool_call" ? p["input"] : p["arguments"];
      out.push({ ...at(0), type: "tool_call", callId, tool, ...describeCall(tool, input, raw, ctx.context.cwd) });
      return;
    }
    case "local_shell_call": {
      const command = asObject(p["action"])["command"];
      const callId = typeof p["call_id"] === "string" ? p["call_id"] : `${ctx.head.id}@${line.start}`;
      const cmd = Array.isArray(command) ? command.filter((c): c is string => typeof c === "string").join(" ") : "";
      out.push({ ...at(0), type: "tool_call", callId, tool: "local_shell", summary: `$ ${cmd}`, paths: [], urls: [], toolKind: "other" });
      return;
    }
    case "web_search_call": {
      // No call id and no result line: the search itself is the observation.
      const action = asObject(p["action"]);
      const callId = typeof p["id"] === "string" ? p["id"] : `${ctx.head.id}@${line.start}`;
      const url = typeof action["url"] === "string" ? action["url"] : null;
      let summary = "web_search";
      if (action["type"] === "search" && typeof action["query"] === "string") summary = `web_search ${JSON.stringify(action["query"])}`;
      else if (action["type"] === "open_page" && url !== null) summary = `web_search open ${url}`;
      else if (action["type"] === "find_in_page" && url !== null) summary = `web_search find ${JSON.stringify(typeof action["pattern"] === "string" ? action["pattern"] : "")} in ${url}`;
      out.push({ ...at(0), type: "tool_call", callId, tool: "web_search", summary, paths: [], urls: url === null ? [] : [url], toolKind: "other" });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = p["call_id"];
      if (typeof callId !== "string") {
        exclude("malformed");
        return;
      }
      const output = p["output"];
      let text: string;
      if (typeof output === "string") text = output;
      else if (Array.isArray(output)) {
        const parts: string[] = [];
        for (const item of output as Entry[]) {
          if (item["type"] === "input_text" && typeof item["text"] === "string") parts.push(item["text"]);
          else if (item["type"] === "input_image" || item["type"] === "input_file") exclude("binary");
          else exclude("unsupported_entry");
        }
        text = parts.join("\n");
      } else {
        exclude("malformed");
        return;
      }
      // Codex does not persist a success flag; the exit code in its own output header is the only error signal.
      const header = OUTPUT_HEADER.exec(text);
      const exitCode = header?.[1] ?? header?.[2];
      out.push({ ...at(0), type: "tool_result", callId, text: header === null ? text : text.slice(header[0].length), isError: exitCode !== undefined && exitCode !== "0" });
      return;
    }
    case "image_generation_call":
      exclude("binary");
      return;
    default:
      exclude(typeof kind === "string" && METADATA_ITEMS.has(kind) ? "host_metadata" : "unsupported_entry");
  }
}

function isContextual(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as Entry[]).some((item) => {
    const text = typeof item["text"] === "string" ? item["text"].trimStart().toLowerCase() : "";
    return CONTEXTUAL_USER.some((marker) => text.startsWith(marker));
  });
}

/** One-line description, touched paths and semantic kind of a call. `input` is null when the model's arguments were not JSON. */
function describeCall(tool: string, input: unknown, raw: unknown, cwd: string): { summary: string; paths: string[]; urls: string[]; toolKind: ToolKind; inputDigest?: string } {
  const memchor = MEMCHOR_TOOL.exec(tool);
  if (memchor !== null) return { summary: `${memchor[1] ?? tool} ${JSON.stringify(input ?? {})}`, paths: [], urls: [], toolKind: "memchor" };
  const args = asObject(input);
  const str = (key: string): string | null => (typeof args[key] === "string" ? args[key] : null);
  const at = (path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));
  const omitted = () => ({
    summary: `${tool} [arguments omitted]`,
    paths: [],
    urls: [],
    toolKind: "other" as const,
    // Unknown schemas are not safe to summarize; the digest only distinguishes argument changes.
    inputDigest: `sha256:${createHash("sha256").update(typeof raw === "string" ? raw : JSON.stringify(raw ?? null)).digest("hex")}`,
  });
  if (input === null) return omitted();
  switch (tool) {
    case "apply_patch": {
      const patch = str("input") ?? "";
      const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter((p) => p !== "");
      const unique = [...new Set(paths)];
      return { summary: `apply_patch ${unique.join(", ")}`, paths: unique.map(at), urls: [], toolKind: "artifact_access" };
    }
    case "view_image": {
      const path = str("path");
      return { summary: `view_image ${path === null ? "(no path)" : at(path)}`, paths: path === null ? [] : [at(path)], urls: [], toolKind: "artifact_access" };
    }
    // A command that only prints files is a file read (see shell-reads.ts); its paths resolve
    // against the call's own workdir, which Codex runs it in, else the turn's cwd.
    case "exec_command":
      return { summary: `$ ${str("cmd") ?? ""}`, urls: [], ...shellCall(str("cmd"), at(str("workdir") ?? cwd)) };
    case "shell": {
      const command = args["command"];
      const argv = Array.isArray(command) ? (command as unknown[]) : null;
      return { summary: `$ ${argv === null ? "" : argv.filter((c) => typeof c === "string").join(" ")}`, urls: [], ...shellCall(argv, at(str("workdir") ?? cwd)) };
    }
    case "shell_command":
      return { summary: `$ ${str("command") ?? ""}`, urls: [], ...shellCall(str("command"), at(str("workdir") ?? cwd)) };
    case "write_stdin": {
      // What was typed into a running process can be a password; only the session is described.
      const session = args["session_id"];
      return { summary: `write_stdin → session ${typeof session === "number" || typeof session === "string" ? String(session) : "?"}`, paths: [], urls: [], toolKind: "other" };
    }
    case "spawn_agent":
      return { summary: `spawn_agent: ${str("agent_type") ?? ""}`, paths: [], urls: [], toolKind: "other" };
    default:
      return omitted();
  }
}
