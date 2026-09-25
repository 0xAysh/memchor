import { claudeCodeAdapter } from "./import/adapters/claude.js";
import { codexAdapter } from "./import/adapters/codex.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";

/**
 * Everything Memchor knows about each agent host, in one place: the memory module picks the
 * transcript adapter from here, the MCP transport the `_meta` key naming the live session,
 * and the CLI its `--host` choices. Transcript formats themselves stay behind
 * {@link TranscriptAdapter} (which also carries the host's display name); this is only which
 * adapter, and how the host names its session.
 */

/** Where hosts keep their history; each adapter reads only its own. */
export interface HostPaths {
  /** Claude Code's config directory. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  claudeConfigDir?: string | undefined;
  /** Codex's home directory. Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string | undefined;
}

export interface HostDescriptor {
  /** The host's transcript format; null when Memchor cannot import its history. */
  transcripts: ((paths: HostPaths) => TranscriptAdapter) | null;
  /**
   * The `tools/call` `_meta` key through which the host names its own session on every call,
   * or null when it sends none (then the live session and its transcript are only joined by
   * worktree).
   */
  sessionMetaKey: string | null;
}

export const HOSTS = {
  "claude-code": {
    transcripts: (paths) => claudeCodeAdapter(paths.claudeConfigDir === undefined ? {} : { configDir: paths.claudeConfigDir }),
    sessionMetaKey: null,
  },
  codex: {
    transcripts: (paths) => codexAdapter(paths.codexHome === undefined ? {} : { codexHome: paths.codexHome }),
    // Codex sends `threadId` on every call, and it equals the id of the thread's rollout
    // (`session_meta.id`), so it is authoritative: adopting it as the host session id makes the
    // live session and the thread's imported rollout the same session for workstream
    // resolution (step 1). `initialize` carries no such id.
    sessionMetaKey: "threadId",
  },
  pi: { transcripts: null, sessionMetaKey: null },
  unknown: { transcripts: null, sessionMetaKey: null },
} as const satisfies Record<string, HostDescriptor>;

export type HostId = keyof typeof HOSTS;

export const HOST_IDS = Object.keys(HOSTS) as HostId[];

/** Hosts whose transcripts Memchor can import. */
export const TRANSCRIPT_HOSTS = HOST_IDS.filter((id) => HOSTS[id].transcripts !== null);

/** The descriptor for a host name; null for any name Memchor does not know (treated like "unknown"). */
export function hostDescriptor(host: string | undefined): HostDescriptor | null {
  return host !== undefined && Object.hasOwn(HOSTS, host) ? HOSTS[host as HostId] : null;
}
