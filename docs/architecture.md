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
| `bootstrap({hostSessionId?, importChoice?, task?, workstream?})` | Binds scope (or returns `scope.ambiguity`), records an import choice if given, imports the current project's approved transcripts within `importBudgetMs` (default 3 s), and returns scope, `import` status (or the consent question), and `recall({})`. `workstream` (`<id>` or `"new"`) answers an ambiguity; `task` names the task explicitly |
| `continueImport({maxMs?})` | One bounded step of the remaining approved import (current project first, then other projects' own workspaces). The MCP server calls it between requests while alive. Not an agent tool |
| `record({kind, body, attribution, …})` | Appends one record with its links and search chunks; `operationKey` makes it idempotent |
| `checkpoint({expectedRevision, goal, status, …})` | Appends revision `expectedRevision + 1` only if the head still equals `expectedRevision` |
| `recall({query?, kinds?, maxTokens?, maxBytes?, continuation?})` | A bounded pack: head checkpoint first, then ranked eligible items |
| `read({recordId, maxTokens?, maxBytes?, offset?})` | A slice of one visible record's body, with its visible links. Offsets count UTF-16 code units; an offset inside a surrogate pair snaps back to that code point's start |
| `status()` | Runtime, storage, the scope bootstrap *would* bind, and counts. Strictly read-only: no registry entry, rows or migrations. Never throws for scope or storage problems |
| `rebuildSearchIndex()` | Regenerates the derived index inside one write transaction |
| `checkIntegrity()` | Read-only `integrity_check`, `foreign_key_check` and FTS index-vs-content check. It reports a damaged, foreign or unmigrated file and never repairs or migrates it |

## Scope

Scope is resolved from the trusted `cwd` on the first operation. Payload schemas are strict, so `workspaceId`, `workstreamId`, `cwd` and `path` are rejected. The one scope input is bootstrap's `workstream`, the user's answer to an ambiguity. It can only name a workstream in the database already chosen from `cwd`, so an id from another workspace is `not_found` and can never widen scope.

**Workspace = repository identity** (`src/bootstrap/workspace-resolution.ts`). `locateWorkspace` reads Git and the registry and writes nothing. `registerWorkspace` records the result.

| Signal | Weight | Why |
|---|---|---|
| Repository key: realpath of the Git common dir | Authoritative while the repository stays put | Every worktree of one repository shares it, and unrelated repositories never do, however similar their names. The workspace id is `ws_` + its hash, salted only if the registry already gives that id to another workspace |
| Recorded root commit absent from this object store | Proves "different repository" | A path reused by an unrelated repository must not inherit memory. The old entry is retired, and the newcomer gets its own id |
| Unregistered key, old key gone from disk, recorded root commit present here, exactly one such workspace | A move | The registry entry and the database's `repository_key` are re-pointed. Worktree bindings under the old main worktree are rewritten to the same relative position, and linked worktrees outside it keep their paths. Consent for the old path still applies |
| Root commit alone | Evidence, never identity | Clones and forks share it. A clone whose original still exists stays separate. Two vanished candidates are never guessed between. An unborn repository never matches |

Known limit: a fresh clone made after the original was deleted is indistinguishable from a move, because Memchor keeps no marker inside the repository. It continues the original's memory. A linked worktree moved with `git worktree move` loses its binding, and its orphaned workstream is then offered as a branch candidate. Transcripts recorded at a moved repository's old path, and not imported before the move, count as `unassigned`, because their cwd no longer resolves through Git.

**Workstream: one deep operation.** `resolveWorkstream` (`src/bootstrap/workstream-resolution.ts`) is used by live bootstrap and by the transcript importer. It returns a bound workstream (created and bound if needed) or an explicit ambiguity, inside the caller's write transaction, so Claude, Codex and Pi cannot drift apart:

| # (PRD §9.2) | Signal | Effect | Why |
|---|---|---|---|
| – | Explicit choice: `workstream: <id> \| "new"` | Binds, and rebinds the worktree to it | The user answered the question |
| 1 | Session metadata: this host + host session id already bound in `sessions`, or an imported transcript's Memchor output reporting `scope.workstreamId` of an existing workstream | Binds. A session binding never rebinds another workstream's worktree; an unbound worktree adopts it | Memchor itself bound that very session. Nothing is closer evidence. Ids not in this database are ignored |
| 2 | Existing binding of this Git worktree | Binds, whatever branch is checked out | The worktree is where the work physically happens. Bindings survive branch switches |
| 3 | Explicit task (`task` → task key: `#20`; `host/owner/repo#20` for an issue or PR URL; `PROJ-7`) | Binds the one active workstream with that key. A workstream without a key adopts it | The user named the task. A task that *contradicts* the task of the bound workstream from steps 1–2 is a conflict and is asked about, never overridden |
| 4 | Strong match to one active workstream | – | V1 has no strong signal beyond 1–3. Branch similarity is not one. An issue reference on a checkpoint is a citation, not an identity claim, so it sets no task key |
| 5 | Branch | Labels new workstreams. Lists active workstreams last seen on this branch whose every bound worktree is gone as candidates. Never binds | Branches are renamed, reused and shared by unrelated work. A workstream bound to a live worktree is never offered to another. A detached HEAD is no evidence |
| 6 | Conversational choice | More than one credible candidate, conflicting signals, or branch-only evidence: `scope.ambiguity`, nothing bound | Guessing would silently merge unrelated work |

One confident candidate binds automatically. With no candidate at all, the worktree gets a new workstream.

**Ambiguity UX.** `scope.ambiguity = { question, candidates, omittedCandidates }`. Each candidate carries `workstreamId`, `label`, `branch`, `taskKey`, `headRevision`, `lastCheckpoint` (goal, status and first next step, clipped), `lastActiveAt` and `reasons` (`session_binding` / `worktree_binding` / `task` / `branch`, with a sentence). At most 5 are listed, the most recently active first. While ambiguous:

- the session row has `workstream_id NULL` (workspace-level);
- `recall` and `read` see only workspace-level records, because eligibility binds a key no workstream has, and the pack notice says why;
- `record` without `workspaceLevel: true` and `checkpoint` throw `scope_ambiguous`.

The agent shows `question`, then calls `bootstrap({workstream})`. That choice becomes the session's workstream and the worktree's binding. Bootstrap re-resolves an existing session only while it is ambiguous or when given `workstream` or `task`.

`ensureWorkspace` still fails closed with `storage_unavailable` when the database's `workspaces` row names a different workspace id or repository key that is not a recorded former key. An example is a registry entry pointing at another repository's database.

## Storage and invariants

`$MEMCHOR_HOME/registry.json` (atomic tmp+rename) maps each repository key to a workspace (id, label, root commit, former keys after moves). A `retired` section keeps workspaces whose path now holds another repository, so the moved original can reclaim them. Each workspace has `workspaces/<id>/memory.sqlite` and `config.json`.

| Table | Role | Invariant |
|---|---|---|
| `records` | Canonical, append-only knowledge | Body ≤ 16 KiB; `attribution`, `review_state` and `freshness` are CHECKed enums; `workstream_id NULL` means workspace-level |
| `links` | Provenance (`supported_by`, …) | Both ends visible to the writer's workstream at write time |
| `workstreams` | Label, lifecycle, `head_revision`, `task_key`, `branch` (v4) | The head only moves inside the CAS transaction; `branch` (last seen) is evidence, never identity |
| `checkpoints` | Revision history | `PRIMARY KEY (workstream_id, revision)` backs the CAS |
| `operations` | Idempotency keys | The hash covers operation + workstream + normalised input |
| `worktree_bindings`, `sessions` | Scope binding | One workstream per worktree path; `sessions.workstream_id NULL` (v4) = a workspace-level session awaiting a choice |
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

**Consent.** On a host's first bootstrap, Memchor discovers transcripts and reads only their head (≤ 64 KiB, for the first cwd and version). It then returns counts, including how many were written by versions it cannot read, and the exact question: `all`, `current_project` or `none`. Nothing else is read until the user answers through `bootstrap({importChoice})`. The decision is per host, in `$MEMCHOR_HOME/consent.json` (atomic write). Its read-modify-write is serialized by a bounded, dead-owner-recoverable cross-process lock. `current_project` approves the repository it was chosen in, adding to any approved earlier; it never revokes one. `none` imports nothing and does not even inventory transcripts; cooperative memory is untouched. `memory_status` and `memchor diag consent` show or change it.

**Adapter seam.** `TranscriptAdapter` (`src/import/normalized-event.ts`) is the one host-format boundary: `discover`, `inspect`, and `read(file, offset, maxBytes)` returning `NormalizedEvent`s (message, host summary, tool call with a host-neutral semantic kind, tool result), exclusion counts, and a `stop` for an unsupported or missing version. The importer never sees host JSON. It alone maps semantic tool kinds (`artifact_access`, `memchor`, `other`) to reference-only, echo-suppression, or bounded-passage retention. Once consent is `none`, bootstrap, continuation, and status do not call discovery, inspection, or reads.

**Canonical privacy.** Tool-call identity retains only the exact call id needed to join a later result. Unknown tool schemas expose a deterministic `<tool> [arguments omitted]` marker plus a transient input digest, so argument changes still produce distinct event identities without raw input entering canonical storage. Descriptive metadata is sanitized before insertion: if any recognized secret or sensitive path occurs in a known call, its entire argument summary is replaced (no redacted command remainder is retained); otherwise known safe summaries are bounded. Artifact paths become bounded worktree-relative references, and non-sensitive URLs become origins without userinfo, path, query, or fragment. Retention classification and a sensitive-path bit are the only other bookkeeping needed to enforce result policy. Raw inputs and transient input digests never enter `import_events.meta`. The v3 migration finds legacy result records through durable import provenance (host + transcript + branch + call id + result record id), with a fail-safe fallback to the importer invariant that transcript `direct_observation` records are tool results when an early v2 row lacks call-id metadata. It never infers identity from human title text. It retracts and replaces inseparable title/body content wholesale, clears references, and rebuilds FTS; record ids, provenance rows and links remain intact, while unrelated transcript records remain usable. If a later source rewrite replays an unknown call imported before this fix, its digest-based bookkeeping identity becomes one explicit safe version and its quarantined result remains a replay, so no evidence record is duplicated.

**Rewrite detection.** The trailing 4 KiB anchor preserves incremental append resumption. Once caught up, the cursor also stores a whole-source SHA-256. A same-size source is hashed before the unchanged fast path; a mismatch (including an early edit outside the anchor) starts a new epoch from byte zero. The completed fingerprint, event rows, records, and cursor commit in the same batch transaction.

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

**Scope.** Before its first batch, a transcript is resolved by the same `resolveWorkstream` a live bootstrap uses. The inputs are its first event's worktree and current branch, its transcript id as the host session id, and the `scope.workstreamId` reported by Memchor output in that batch before the transcript leaves its first worktree. So Memchor output naming an existing workstream of this workspace is authoritative (step 1), even over the worktree's binding. A live session with the same host session id is authoritative too. Every distinct cwd is resolved through Git (once per process). There is no path-prefix shortcut, because a directory inside the worktree can be a nested worktree, a submodule or another clone.

- **Held.** When resolution is ambiguous (conflicting session metadata, or a worktree whose only evidence is an orphaned workstream's branch), nothing is written. The transcript counts as `quarantined` and is reported as a `scope_ambiguous` gap. It is re-resolved when its file changes or at the next bootstrap, for example after the user chose that worktree's workstream. It is *not* imported workspace-level: workspace-level records are recalled in every workstream, so ambiguous history would enter current guidance.
- **Quarantined.** After the first batch, two things quarantine a transcript from that line on (`scope_ambiguous`, cursor held, nothing after it imported): a later event whose cwd is in another worktree or repository, or Memchor output naming a different existing workstream.

Transcripts whose cwd is gone or not in Git are counted as `unassigned`. `all projects` imports each repository into its own workspace database. Retrieval never mixes them.

**Order and budget.** Bootstrap imports only the current repository (newest transcript first) until its budget. The MCP server then calls `continueImport` in 200 ms steps with 25 ms pauses until every approved transcript is reconciled. Expected failures (`storage_busy`, `storage_full`, `storage_unavailable`, an unreadable `consent.json` → state `unavailable`) are reported as `import.problem` and never fail bootstrap. The MCP loop retries a failed step with backoff (2 s … 32 s, five times). Any other error is a bug: the batch rolls back and the error propagates. Gaps met while backfilling other projects are reported in this process's status, labelled with their workspace. No model call and no network access are involved; the e2e test preloads a guard that fails on any socket, DNS lookup or fetch.

## Runtime gate

At open, Memchor requires embedded SQLite ≥ 3.51.3, the release with the fix for the [WAL-reset bug](https://sqlite.org/wal.html#walresetbug). It also requires FTS5: the compile option must be present and creating an FTS5 table must succeed. If either check fails, it throws `unsupported_runtime` with the version it found. The rule is the pure function `assertSupportedRuntime`, which has no override. `memchor mcp` runs it at process start and exits non-zero with the message on stderr before serving. Every database open runs it again.

## Error codes

| Code | Meaning |
|---|---|
| `scope_unresolved` | cwd is not inside a Git worktree |
| `scope_ambiguous` | No workstream is chosen yet (`scope.ambiguity`): thrown by `record` without `workspaceLevel` and by `checkpoint`; `details.candidates` lists the ids. Also the gap reason for a held or quarantined transcript |
| `scope_denied` | The target belongs to another workstream |
| `not_found` | Unknown or ineligible (e.g. retracted) record, or a chosen `workstream` that is not in this workspace |
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
- Steps run with foreign keys off, as SQLite's documented table-rebuild procedure requires. v4 rebuilds `sessions` to make `workstream_id` nullable. Each step runs `foreign_key_check` before committing, and rolls back on any violation.
- Concurrent openers serialise, and the second finds nothing to do.
- A database newer than the build fails closed before any pragma changes it.
- A shipped migration is never edited.
- Every new version needs an upgrade test from each earlier version (`tests/migrations/`).
