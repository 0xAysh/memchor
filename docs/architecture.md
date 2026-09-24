# Architecture

```
memchor mcp (src/transports/mcp.ts)   memchor diag (src/cli.ts)
            └──────────────┬──────────────┘
                 src/memory.ts  ← all policy
   scope · idempotency · CAS · eligibility · budgets · citations
            │                              │
            │               src/import/reconcile.ts  ← discover · order · batch · cursor · dedupe
            │                              │ NormalizedEvent only
            │               src/import/adapters/claude.ts  ← the only code that knows Claude's JSON
            │                              │ (read-only)
       one SQLite file per workspace (WAL, FTS5)      $CLAUDE_CONFIG_DIR/projects/*/*.jsonl
```

The adapters contain no memory policy. The MCP server forwards raw tool arguments to the module. The module parses them with the zod schemas in `src/schemas.ts`, which are also the source of the tools' JSON Schemas. Each `MemchorError` becomes `isError: true` with `{ error: { code, message, retryable, details } }`.

## Memory module interface

`openMemory({ cwd, host, home?, hostSessionId?, busyTimeoutMs? }): Memory`. All methods are synchronous and throw only `MemchorError` for expected failures.

| Method | Contract |
|---|---|
| `bootstrap({hostSessionId?, importChoice?})` | Binds scope, records an import choice if given, imports the current project's approved transcripts within `importBudgetMs` (default 3 s), and returns scope, `import` status (or the consent question), and `recall({})` |
| `continueImport({maxMs?})` | One bounded step of the remaining approved import (current project first, then other projects' own workspaces). The MCP server calls it between requests while alive. Not an agent tool |
| `record({kind, body, attribution, …})` | Appends one record with its links and search chunks; `operationKey` makes it idempotent |
| `checkpoint({expectedRevision, goal, status, …})` | Appends revision `expectedRevision + 1` only if the head still equals `expectedRevision` |
| `recall({query?, kinds?, maxTokens?, maxBytes?, continuation?})` | A bounded pack: head checkpoint first, then ranked eligible items |
| `read({recordId, maxTokens?, maxBytes?, offset?})` | A slice of one visible record's body, with its visible links. Offsets count UTF-16 code units; an offset inside a surrogate pair snaps back to that code point's start |
| `status()` | Runtime, storage, the scope bootstrap *would* bind, and counts. Strictly read-only: no registry entry, rows or migrations. Never throws for scope or storage problems |
| `rebuildSearchIndex()` | Regenerates the derived index inside one write transaction |
| `checkIntegrity()` | Read-only `integrity_check`, `foreign_key_check` and FTS index-vs-content check. It reports a damaged, foreign or unmigrated file and never repairs or migrates it |

**Scope** is resolved once per instance from the trusted `cwd`:

1. Git toplevel and common dir give the workspace (id = hash of the common dir's realpath).
2. For the workstream, an existing worktree binding wins, whatever branch is checked out.
3. Otherwise the worktree gets a new workstream, labelled with its branch. The branch is only a label and never selects another worktree's workstream (PRD §9.2).
4. `bindScope` fails closed with `storage_unavailable` if the database's `workspaces` row names a different workspace id or repository key, for example when a registry entry points at another repository's database.

Payload schemas are strict, so `workspaceId`, `cwd` and `path` are rejected.

## Storage and invariants

`$MEMCHOR_HOME/registry.json` (atomic tmp+rename) maps each repository to a workspace. Each workspace has `workspaces/<id>/memory.sqlite` and `config.json`.

| Table | Role | Invariant |
|---|---|---|
| `records` | Canonical, append-only knowledge | Body ≤ 16 KiB; `attribution`, `review_state` and `freshness` are CHECKed enums; `workstream_id NULL` means workspace-level |
| `links` | Provenance (`supported_by`, …) | Both ends visible to the writer's workstream at write time |
| `workstreams` | Label, lifecycle, `head_revision` | The head only moves inside the CAS transaction |
| `checkpoints` | Revision history | `PRIMARY KEY (workstream_id, revision)` backs the CAS |
| `operations` | Idempotency keys | The hash covers operation + workstream + normalised input |
| `worktree_bindings`, `sessions` | Scope binding | One workstream per worktree path |
| `chunks`, `chunks_fts` | **Derived** search projection | A pure function of `records`; rebuildable |
| `sources` | One row per imported transcript | `records.source_id` points here |
| `import_cursors` (v2) | Per-transcript reconciliation position | Advances only in the transaction that stores the batch's records; `anchor_hash` detects rewrites |
| `import_events` (v2) | Event identity → record | PK = host + transcript + branch + event id + content hash, so replay is a no-op and an edit is a new version |
| `consents` | Reserved | The import decision is host-level, so it lives in `$MEMCHOR_HOME/consent.json`, not in a workspace |

**Eligibility** (`src/retrieval/eligibility.ts`) is one SQL predicate used for reads, links, citations and ranking. A record must be in this workstream or workspace-level, and not retracted. Recall additionally excludes checkpoint records: the head is returned separately.

## Transaction ordering

Every write is one `BEGIN IMMEDIATE` transaction, so it never upgrades from reader to writer and cannot hit `SQLITE_BUSY_SNAPSHOT`. Helpers that rely on the caller's transaction assert `db.inTransaction`: `appendRecord`, `insertLinks`, `indexRecord`, `rebuildSearchIndex` and `publishCheckpoint`. Inside the transaction:

- **`record`**: look up the operation key → insert the record → insert links (each target scope-checked) → insert chunks and FTS rows → insert the operation row.
- **`checkpoint`**: look up the operation key (a replay wins over a conflict) → compare the head with `expectedRevision` → append the checkpoint record, its links and chunks → insert the `checkpoints` row → conditionally update `head_revision`.

**Reads.** Recall reads in one deferred transaction, so the head, candidates and citations share a snapshot. Scope and eligibility sit in the WHERE clause, ahead of bm25 ranking. Ties are broken by `created_at DESC, seq DESC`. Query words are individually quoted, so FTS syntax cannot be injected.

**Budgets.** A pack's size is the sum of the UTF-8 JSON bytes of the checkpoint and items, and never exceeds `min(maxBytes, 4 × maxTokens)`. Tokens are estimated as `ceil(bytes / 4)`.

**Continuations** freeze the sequence. Page 1 ranks up to 500 eligible records, and the token carries the unreturned `seq`s in rank order. The token is HMAC-signed with a per-workspace secret and bound to the workspace, workstream, query and kinds. Later pages load records by `seq` and re-check scope and eligibility, without re-ranking. So writes between pages, which shift bm25 statistics, can neither reorder nor inject records, and no eligible page-1 record is skipped or repeated. Matches beyond the cap are reported as `candidate_limit`. This design keeps recall read-only, with no server-side snapshot table to expire.

**Ranking caveat.** bm25's corpus statistics (IDF, average length) are computed by FTS5 over *all* chunks, including retracted and other-workstream records. Ineligible rows can therefore change scores, but never eligibility: they are filtered in the WHERE clause and cannot be returned, cited or counted.

**Durability.** Connections run with `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and a bounded `busy_timeout` (default 5 s). The one-time switch to WAL retries when SQLite answers `SQLITE_BUSY` immediately.

## Transcript import

**Consent.** On a host's first bootstrap, Memchor discovers transcripts and reads only their head (≤ 64 KiB, for the first cwd and version). It then returns counts, including how many were written by versions it cannot read, and the exact question: `all`, `current_project` or `none`. Nothing else is read until the user answers through `bootstrap({importChoice})`. The decision is per host, in `$MEMCHOR_HOME/consent.json` (atomic write). `current_project` approves the repository it was chosen in, adding to any approved earlier; it never revokes one. `none` imports nothing and does not even inventory transcripts; cooperative memory is untouched. `memory_status` and `memchor diag consent` show or change it.

**Adapter seam.** `TranscriptAdapter` (`src/import/normalized-event.ts`) is the one host-format boundary: `discover`, `inspect`, and `read(file, offset, maxBytes)` returning `NormalizedEvent`s (message, host summary, tool call with its output policy, tool result), exclusion counts, and a `stop` for an unsupported version. The importer never sees host JSON.

**Claude Code format** (`src/import/adapters/claude.ts`). The docs say the entry format "is internal to Claude Code and changes between versions", so the adapter reads a pinned field list and uses an explicit table:

| Claude Code versions | Format | Basis |
|---|---|---|
| ≥ 2.1.183, < 2.2.0 | `claude-code-jsonl-v1` | 72 local transcripts from 2.1.183–2.1.281; fixtures for 2.1.183 and 2.1.281 |

An entry from any other version stops that transcript at that line (`stopped`, gap `unsupported_version`, cursor held). The transcript resumes once a Memchor that knows the version runs. Unknown entry or block types inside a supported version are skipped and counted, never interpreted. Not read at all: subagent transcripts (their final report is the parent's Agent tool result), `toolUseResult`, usage, snapshots and every other field.

**What is stored.** User text → `evidence` / `user_direction`. Assistant text → `evidence` / `agent_inference`. Tool call and its result → one `evidence` / `direct_observation` record with the call summary and a bounded output. Host summaries (compaction, away summary) → `note`. Records carry `createdAt` = the event time and `source` = {host, transcript, branch, event}. Privacy rules (`src/import/privacy.ts`):

| Content | Handling |
|---|---|
| Thinking, injected context (`isMeta`, non-human origin, `<system-reminder>`), attachments, metadata entries, images | Excluded and counted |
| File reads and edits (Read, Write, Edit, NotebookEdit) | Reference only: path as a code `externalRef`, no content |
| Output of a call touching `.env`, keys, credential files | Withheld |
| Credentials (AWS, GitHub, Anthropic/OpenAI-style, Slack, Google, JWT, private keys, URL passwords, `secret=` assignments) | `[redacted:<kind>]`; pattern-based, so best-effort |
| Messages > 4 KB, tool output > 1.5 KB, summaries > 8 KB | Head + tail with `[… N bytes omitted by Memchor …]` |
| Memchor's own tool calls and results | Never records; the existing record ids they mention are kept as references |
| A tool result whose call could not be read | Output withheld (fails closed: its path is unknown) |

**Batches and cursors.** Each batch (≈1 MiB of transcript) is one `BEGIN IMMEDIATE` transaction:

```text
re-read cursor (CAS: another process moved it → give up this transcript for now)
  → first batch: ensure workspace row, worktree binding, session, source, cursor
  → per event: scope check → identity lookup (same hash: replay; other hash: new linked version) → record + links + chunks + import_events row
  → update cursor: offset, anchor hash, state, gap, counters (file size/mtime only once caught up)
```

A kill mid-batch rolls the whole batch back. The cursor never passes evidence that is not durable, and the retry re-reads the same lines (tested with a real `SIGKILL`). Unchanged file → skipped without reading. Grown with a matching anchor → append. Otherwise (rewritten or truncated) → a new pass from byte 0 under a new epoch, reconciled by identity. Identities not seen again are reported as `missing` and never deleted. A partial trailing line (the host is still writing) is left for later. Known limit: an edit that keeps the file's size and falls before the 4 KiB anchor is not detected. Claude Code only appends, so this needs an outside rewrite.

**Scope.** A transcript binds to the workstream of its first event's worktree, creating the binding exactly as a live bootstrap there would. Every distinct cwd is resolved through Git (once per process). There is no path-prefix shortcut, because a directory inside the worktree can be a nested worktree, a submodule or another clone. Two things quarantine it from that line on (`scope_ambiguous`, cursor held, nothing after it imported): a later event whose cwd is in another worktree or repository, or Memchor output in it naming a different existing workstream. Transcripts whose cwd is gone or not in Git are counted as `unassigned`. `all projects` imports each repository into its own workspace database. Retrieval never mixes them.

**Order and budget.** Bootstrap imports only the current repository (newest transcript first) until its budget. The MCP server then calls `continueImport` in 200 ms steps with 25 ms pauses until every approved transcript is reconciled. Expected failures (`storage_busy`, `storage_full`, `storage_unavailable`, an unreadable `consent.json` → state `unavailable`) are reported as `import.problem` and never fail bootstrap. The MCP loop retries a failed step with backoff (2 s … 32 s, five times). Any other error is a bug: the batch rolls back and the error propagates. Gaps met while backfilling other projects are reported in this process's status, labelled with their workspace. No model call and no network access are involved; the e2e test preloads a guard that fails on any socket, DNS lookup or fetch.

## Runtime gate

At open, Memchor requires embedded SQLite ≥ 3.51.3, the release with the fix for the [WAL-reset bug](https://sqlite.org/wal.html#walresetbug). It also requires FTS5: the compile option must be present and creating an FTS5 table must succeed. If either check fails, it throws `unsupported_runtime` with the version it found. The rule is the pure function `assertSupportedRuntime`, which has no override. `memchor mcp` runs it at process start and exits non-zero with the message on stderr before serving. Every database open runs it again.

## Error codes

| Code | Meaning |
|---|---|
| `scope_unresolved` | cwd is not inside a Git worktree |
| `scope_ambiguous` | Not thrown. Used as the gap reason for a quarantined transcript whose scope signals conflict |
| `scope_denied` | The target belongs to another workstream |
| `not_found` | Unknown or ineligible (e.g. retracted) record |
| `invalid_input` | Schema violation, unknown key, oversized content, or a bad continuation |
| `idempotency_conflict` | The operation key was reused with a different request |
| `checkpoint_conflict` | The head ≠ `expectedRevision`; `details.currentRevision` gives the head |
| `storage_busy` | The busy timeout was exceeded (`retryable: true`) |
| `storage_full` | The disk or database is full; nothing was acknowledged |
| `storage_unavailable` | The database, registry or home cannot be used, or the database belongs to another workspace or repository |
| `unsupported_runtime` | SQLite too old, no FTS5, or a database schema newer than this build |

## Migrations

`src/storage/migrations/` holds an append-only ordered list, and `PRAGMA user_version` is the applied count:

- Each step runs in its own `BEGIN IMMEDIATE` transaction together with the version bump, so a failed step leaves the previous version intact.
- Concurrent openers serialise, and the second finds nothing to do.
- A database newer than the build fails closed before any pragma changes it.
- A shipped migration is never edited.
- Every new version needs an upgrade test from each earlier version (`tests/migrations/`).
