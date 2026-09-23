# Memchor

Local working memory for coding agents. An agent host (Claude Code, Codex, …) starts `memchor mcp` inside a Git repository. Agents can then record attributed evidence and decisions, publish versioned checkpoints, and later recall a small, cited context pack, including from a different agent or a fresh session.

Memchor stores knowledge *about* the work: goals, status, decisions, failed attempts, preferences, next steps, and pointers to code and documents. It never stores the artifacts themselves. The live repository stays the source of truth.

- Stored locally in one SQLite database per repository, under `~/.memchor` (or `$MEMCHOR_HOME`). Nothing is written into the repository.
- No daemon, no network, no embeddings. Several host processes share the database through SQLite WAL.

## Development

Requires Node `>=24` (`.node-version` pins 25.9.0) and Git.

```sh
npm ci
npm run build       # tsc → dist/
npm run typecheck
npm run lint
npm test            # builds dist/, then runs all suites against real SQLite, Git and server processes
```

## Commands

```sh
memchor mcp [--host claude-code|codex|pi|unknown]   # MCP server over stdio (the host starts this)
memchor diag status                                 # runtime (SQLite/FTS5), storage, scope, counts
memchor diag records [--query <text>] [--kind <k>]  # what agents can currently recall here
memchor diag reindex                                # rebuild the search index from canonical records
memchor diag integrity                              # SQLite, foreign-key and FTS integrity checks
```

Scope always comes from the current directory's Git worktree. No command or tool accepts a workspace id or path.

## Connecting an agent (illustrative, untested)

These command shapes follow the PRD. They have not been verified against pinned host releases.

```sh
claude mcp add memchor -- memchor mcp --host claude-code
codex mcp add memchor -- memchor mcp --host codex
```

MCP tools: `memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_status`. The server's MCP `instructions` carry the agent protocol: bootstrap first, verify live state, record with honest attribution, cite evidence, and checkpoint with `expectedRevision` before finishing.

See [docs/architecture.md](docs/architecture.md) for the interface, schema, invariants and error codes.
