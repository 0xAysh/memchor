# Memchor

Local working memory for coding agents. An agent host (Claude Code, Codex, …) starts `memchor mcp` inside a Git repository. Agents can then record attributed evidence and decisions, publish versioned checkpoints, and later recall a small, cited context pack, including from a different agent or a fresh session.

Memchor stores knowledge *about* the work: goals, status, decisions, failed attempts, preferences, next steps, and pointers to code and documents. It never stores the artifacts themselves. The live repository stays the source of truth.

- Stored locally in one SQLite database per repository, under `~/.memchor` (or `$MEMCHOR_HOME`). Nothing is written into the repository.
- No daemon, no network, no embeddings. Several host processes share the database through SQLite WAL.
- On first use with Claude Code or Codex, Memchor offers to seed memory from that host's local transcripts (`all projects`, `current project only`, or `none`). Imported passages are bounded, attributed and cited back to their transcript; hidden reasoning, binaries, recognised secrets, file contents and Memchor's own output are left out.

## Development

Requires Node `>=24` (`.node-version` pins 25.9.0) and Git.

```sh
npm ci
npm run build       # tsc → dist/
npm run typecheck
npm run lint
npm test            # builds dist/, then runs all suites against real SQLite, Git and server processes

# Deterministic sanitized workload: small + large import timing and peak-RSS JSON evidence
npm run benchmark:import

# Local-only: snapshot your real Claude Code, Codex and Pi transcripts into the git-ignored .real-transcripts/
npm run snapshot:transcripts    # then `npm test` also runs tests/import/real-history.test.ts against it
MEMCHOR_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts   # or read a config dir in place
MEMCHOR_REAL_CODEX_HOME=~/.codex npx vitest run tests/import/real-history.test.ts   # (Codex: only sessions/ and archived_sessions/ are read)
```

`npm run benchmark:import` generates sanitized JSONL in a temporary directory, imports it without network/model calls, and reports stable `small`/`large` scenario fields: transcript, turn, event and record counts; elapsed milliseconds; RSS delta and process peak RSS; and database bytes. Values are evidence for the machine running the command, not flaky pass/fail thresholds. Scenario sizes can be overridden with `-- --small-transcripts N --small-turns N --large-transcripts N --large-turns N`.

Real transcripts hold account ids, file contents and credentials, so they never leave your machine. `.real-transcripts/` is git-ignored, and the snapshot script refuses to run unless git confirms that. It intentionally copies Claude, Codex and Pi `*.jsonl` histories as local product-development fixtures, never settings, Codex's `auth.json`/`config.toml`/SQLite state or Pi's `auth.json`; current product import support remains independently adapter-gated. Every committed fixture under `tests/import/fixtures/` is hand-written. Other tests never read real history: `vitest.config.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at empty directories.

`tests/mcp/codex-connection.test.ts` drives the real Codex CLI (`codex mcp add/list/get`, `codex app-server`) in a temporary `CODEX_HOME`. It runs only against the pinned build, `codex-cli 0.148.0-alpha.21` (bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; override with `MEMCHOR_TEST_CODEX_BIN`), and is skipped, with the reason on stderr, when that binary is missing or reports another version.

## Commands

```sh
memchor mcp [--host claude-code|codex|pi|unknown]   # MCP server over stdio (the host starts this)
memchor diag status                                 # runtime (SQLite/FTS5), storage, scope, counts (read-only)
memchor diag records [--query <text>] [--kind <k>]  # what agents can currently recall here
memchor diag reindex                                # rebuild the search index from canonical records
memchor diag integrity                              # SQLite, foreign-key and FTS integrity checks (read-only)
memchor diag demo [--temp-home]                     # run the tracer flow here and print the pack
                                                    # (writes demo records: set MEMCHOR_HOME or pass --temp-home)
memchor diag consent [--set all|current_project|none] [--host claude-code|codex]
                                                    # show or change a host's transcript-import decision (default claude-code)
memchor diag import [--host claude-code|codex]      # import approved transcripts to completion; print progress and timing
```

Claude Code transcripts are read from `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). Codex rollouts are read from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`); nothing else in `CODEX_HOME` is read. The import decision is stored per host in `$MEMCHOR_HOME/consent.json`.

Scope always comes from the current directory's Git worktree. No command or tool accepts a workspace id or path.

## Connecting an agent

### Connect Codex (verified with codex-cli 0.148.0-alpha.21)

Tested against `codex-cli 0.148.0-alpha.21` (the build bundled with the ChatGPT desktop app, `/Applications/ChatGPT.app/Contents/Resources/codex`) by `tests/mcp/codex-connection.test.ts`. Use absolute paths: Codex starts the server in the thread's working directory (your repository), so a relative program or script path would be resolved there.

```sh
# From a checkout (after npm run build); this exact form was run against 0.148.0-alpha.21:
codex mcp add memchor -- "$(command -v node)" /abs/path/to/memchor/dist/cli.js mcp --host codex
# With memchor installed on PATH, the same with its absolute path:
codex mcp add memchor -- "$(command -v memchor)" mcp --host codex

codex mcp list            # memchor … enabled
codex mcp get memchor     # command, args, env (masked), timeouts
```

- **Keep `--host codex`.** Codex identifies itself as `codex-mcp-client` in the MCP handshake, so without the flag Memchor would not know it serves Codex (no transcript import, no thread binding).
- **Environment is not inherited.** Codex starts MCP servers with a cleared environment (only `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, … pass through). If you use a non-default `CODEX_HOME` or `MEMCHOR_HOME`, pass them explicitly, or Memchor reads `~/.codex` and stores in `~/.memchor`:

  ```sh
  codex mcp add memchor --env CODEX_HOME="$CODEX_HOME" --env MEMCHOR_HOME="$MEMCHOR_HOME" -- "$(command -v memchor)" mcp --host codex
  ```

  Running `codex mcp add memchor …` again replaces the whole entry, including any `--env` given before.
- **Never set `cwd`** for this server. Without it, Codex starts one Memchor per thread in that thread's working directory, which is how Memchor finds the repository and worktree. A fixed `cwd` would put every thread in one scope.
- **Timeouts.** Codex's documentation and code disagree on the defaults (docs: 10 s startup, 60 s per tool; 0.148 code: 30 s and 300 s), and `codex mcp add` has no flag for them. Set them explicitly in `$CODEX_HOME/config.toml`, in the `[mcp_servers.memchor]` table (above its `.env` sub-table):

  ```toml
  [mcp_servers.memchor]
  command = "/abs/path/to/memchor"
  args = ["mcp", "--host", "codex"]
  startup_timeout_sec = 20
  tool_timeout_sec = 60
  ```

  Memchor answers the handshake before touching storage, and `memory_bootstrap` bounds its transcript import to 3 s, continuing in the background.
- Every tool call from Codex carries the thread id (`_meta.threadId`); Memchor binds it to the session, so the thread's own rollout, once imported, joins the same workstream.

Codex rollouts written by 0.125.0-alpha.3 – 0.142.x and by 0.148.0-alpha.21 (legacy history mode) are imported; see [Transcript import](docs/architecture.md#transcript-import) for the table and known gaps.

### Connect Claude Code (illustrative, untested)

This command shape follows the PRD. It has not been verified against a pinned Claude Code release yet.

```sh
claude mcp add memchor -- memchor mcp --host claude-code
```

MCP tools: `memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_status`. The server's MCP `instructions` carry the agent protocol: bootstrap first, verify live state, record with honest attribution, cite evidence, and checkpoint with `expectedRevision` before finishing.

See [docs/architecture.md](docs/architecture.md) for the interface, schema, invariants and error codes.
