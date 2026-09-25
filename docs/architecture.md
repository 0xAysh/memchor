# Architecture

```
memchor mcp (src/transports/mcp.ts)   memchor diag (src/cli.ts)
            └──────────────┬──────────────┘
                 src/memory.ts  ← all policy
   scope · idempotency · CAS · eligibility · budgets · citations
            │                              │
            │               src/import/reconcile.ts  ← discover · order · batch · cursor · dedupe
            │                              │ NormalizedEvent only (one TranscriptAdapter, chosen by host)
            │                 ┌────────────┴─────────────┐
            │     adapters/claude.ts            adapters/codex.ts     ← the only code that knows each host's JSON
            │                 │ (read-only)              │ (read-only)
            │   $CLAUDE_CONFIG_DIR/projects/*/*.jsonl    $CODEX_HOME/{sessions/YYYY/MM/DD,archived_sessions}/rollout-*.jsonl
            │
  one SQLite file per workspace (WAL, FTS5)
```

The adapters contain no memory policy. Host differences outside the transcript format live in one descriptor table, `src/hosts.ts`: `openMemory` picks the transcript adapter from it (`claude-code` → Claude Code, `codex` → Codex, anything else → none), the MCP server the `_meta` key that names a live session (Codex: `threadId`; an id longer than 200 characters is ignored, never cut), and the CLI its `--host` choices. The MCP server forwards raw tool arguments to the module. The module parses them with the zod schemas in `src/schemas.ts`, which are also the source of the tools' JSON Schemas. Each `MemchorError` becomes `isError: true` with `{ error: { code, message, retryable, details } }`.

## Memory module interface

`openMemory({ cwd, host, home?, hostSessionId?, busyTimeoutMs?, claudeConfigDir?, codexHome?, importBudgetMs? }): Memory`. All methods are synchronous and throw only `MemchorError` for expected failures.

| Method | Contract |
|---|---|
| `bootstrap({hostSessionId?, importChoice?, task?, workstream?, maxTokens?, maxBytes?})` | Binds scope (or returns `scope.ambiguity`), records an import choice if given, imports the current project's approved transcripts within `importBudgetMs` (default 3 s), and returns scope, `import` status (or the consent question), and `recall({ maxTokens, maxBytes })`. `workstream` (`<id>` or `"new"`) answers an ambiguity; `task` names the task explicitly |
| `continueImport({maxMs?})` | One bounded step of the remaining approved import (current project first, then other projects' own workspaces). The MCP server calls it between requests while alive. Not an agent tool |
| `record({kind, body, attribution, …})` | Appends one record with its links and search chunks; `operationKey` makes it idempotent |
| `checkpoint({expectedRevision, goal, status, …})` | Appends revision `expectedRevision + 1` only if the head still equals `expectedRevision` |
| `recall({query?, kinds?, maxTokens?, maxBytes?, continuation?})` | A bounded pack: head checkpoint first, then ranked eligible items, each with live freshness, provenance, independent root and corroboration (see [Recall applicability](#recall-applicability)), plus `corrections` when memory in scope changed since this session's previous pack |
| `read({recordId, maxTokens?, maxBytes?, offset?})` | A slice of one visible record's body, with its visible links, live freshness and independent root. Offsets count UTF-16 code units; an offset inside a surrogate pair snaps back to that code point's start. A record that is no longer current is `not_found` with its `lifecycle`, `replacementId` or `taint` |
| `manage({v?, action, recordId?, recordIds?, confirmToken?, body?, reason?, attribution?, operationKey?})` | `inspect` \| `correct` \| `supersede` \| `retract` \| `restore` one in-scope claim, or `forget_preview` then `forget` (see [Memory lifecycle](#memory-lifecycle)). Each change is one transaction; the result lists what it took out of (or back into) current guidance |
| `status()` | Runtime, storage, the scope bootstrap *would* resolve (`workstreamId`, `resolvedBy`, `taskKey`, or the `ambiguity` it would ask), and counts. It runs the same resolution rules as bootstrap without their writes (`previewWorkstream`); after a repository move it reports no resolution until bootstrap re-points the bindings, and none while a schema migration is pending (the next bootstrap migrates). Strictly read-only: no registry entry, rows or migrations. Never throws for scope or storage problems |
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

**Workstream: one deep operation.** `resolveWorkstream` (`src/bootstrap/workstream-resolution.ts`) is used by live bootstrap and by the transcript importer. It returns a bound workstream (created and bound if needed) or an explicit ambiguity, inside the caller's write transaction, so Claude, Codex and Pi cannot drift apart. The rules decide first and write second; `previewWorkstream` runs only the decision, which is how `status` reports what bootstrap would do on a read-only connection:

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

**Ambiguity UX.** `scope.ambiguity = { question, candidates, omittedCandidates }`. Each candidate carries `workstreamId`, `label`, `branch`, `taskKey`, `headRevision`, `lastCheckpoint` (goal, status and first next step, clipped; a field is null when the body is not in the rendered checkpoint form), `lastActiveAt` and `reasons` (`session_binding` / `worktree_binding` / `task` / `branch`, with a sentence). At most 5 are listed, the most recently active first. While ambiguous:

- the session row has `workstream_id NULL` (workspace-level);
- `recall` and `read` see only workspace-level records, because eligibility binds a key no workstream has, and the pack notice says why;
- `record` without `workspaceLevel: true` and `checkpoint` throw `scope_ambiguous`.

The agent shows `question`, then calls `bootstrap({workstream})`. That choice becomes the session's workstream and the worktree's binding. Bootstrap re-resolves an existing session only while it is ambiguous or when given `workstream` or `task`.

`ensureWorkspace` still fails closed with `storage_unavailable` when the database's `workspaces` row names a different workspace id or repository key that is not a recorded former key. An example is a registry entry pointing at another repository's database.

## Storage and invariants

`$MEMCHOR_HOME/registry.json` (atomic tmp+rename) maps each repository key to a workspace (id, label, root commit, former keys after moves). A `retired` section keeps workspaces whose path now holds another repository, so the moved original can reclaim them. Each workspace has `workspaces/<id>/memory.sqlite` and `config.json`.

| Table | Role | Invariant |
|---|---|---|
| `records` | Canonical, append-only knowledge | Body ≤ 16 KiB; `attribution`, `review_state`, `lifecycle` (v5) and `freshness` are CHECKed enums; `workstream_id NULL` means workspace-level; `superseded_by` names the replacement of a corrected or superseded claim |
| `links` | Provenance (`supported_by`, `derived_from`, `supersedes`, …) | Both ends visible to the writer's workstream at write time (the importer's lineage links need only be in scope) |
| `taints` (v5) | Why an active record is not current: (record, cause, `invalidated` \| `quarantined`) | One row per cause; the record is eligible again only when every cause is gone |
| `lifecycle_events` (v5) | Append-only audit of every lifecycle change | `seq` is the correction watermark |
| `suppressions` (v5) | Host events (host + event id) whose claim is no longer active | The importer skips new copies and versions of them. No foreign keys: markers outlive the rows they name |
| `workstreams` | Label, lifecycle, `head_revision`, `task_key`, `branch` (v4) | The head only moves inside the CAS transaction; `branch` (last seen) is evidence, never identity |
| `checkpoints` | Revision history | `PRIMARY KEY (workstream_id, revision)` backs the CAS |
| `operations` | Idempotency keys | The hash covers operation + workstream + normalised input |
| `worktree_bindings`, `sessions` | Scope binding | One workstream per worktree path; `sessions.workstream_id NULL` (v4) = a workspace-level session awaiting a choice |
| `chunks`, `chunks_fts` | **Derived** search projection | A pure function of `records`; rebuildable |
| `sources` | One row per imported transcript | `records.source_id` points here |
| `import_cursors` (v2) | Per-transcript reconciliation position | Advances only in the transaction that stores the batch's records; `anchor_hash` detects rewrites |
| `import_events` (v2) | Event identity → record | PK = host + transcript + branch + event id + content hash, so replay is a no-op and an edit is a new version |
| `consents` | Reserved | The import decision is host-level, so it lives in `$MEMCHOR_HOME/consent.json`, not in a workspace |

**Eligibility** (`src/retrieval/eligibility.ts`) is one SQL predicate, `VISIBLE_SQL`, used by recall ranking and loading (and so FTS), direct reads, link and citation expansion, independent roots, echo lineage, the head checkpoint and the ambiguity glimpse; `memchor diag records` pages through recall, so it is covered too. A record must be in this workstream or workspace-level, have `lifecycle = 'active'`, and have no `taints` row. Recall additionally excludes checkpoint records: the head is returned separately. `memory_manage inspect` is the one reader of ineligible records, and it labels them (`eligible: false`).

## Transaction ordering

Every write is one `BEGIN IMMEDIATE` transaction, so it never upgrades from reader to writer and cannot hit `SQLITE_BUSY_SNAPSHOT`. Helpers that rely on the caller's transaction assert `db.inTransaction`: `appendRecord`, `insertLinks`, `indexRecord`, `rebuildSearchIndex` and `publishCheckpoint`. Inside the transaction:

- **`record`**: look up the operation key → insert the record → insert links (each target scope-checked) → insert chunks and FTS rows → insert the operation row.
- **`checkpoint`**: look up the operation key (a replay wins over a conflict) → compare the head with `expectedRevision` → append the checkpoint record, its links and chunks → insert the `checkpoints` row → conditionally update `head_revision`.
- **`manage`** (a change): look up the operation key → check the claim's state (else `lifecycle_conflict`; for forget, the preview's impact) → append the replacement with its `supersedes` link → find dependents → insert taints → (forget: remove the payload) → set the lifecycle of the claim and its copies → insert or release suppressions → append the `lifecycle_events` row → append the ledger entry.

**Reads.** Recall reads in one deferred transaction, so the head, candidates and citations share a snapshot. Scope and eligibility sit in the WHERE clause, ahead of bm25 ranking. Ties are broken by `created_at DESC, seq DESC`. Query words are individually quoted, so FTS syntax cannot be injected.

**Budgets.** The budget covers the whole pack as the client receives it: the UTF-8 length of its JSON, including `scope` (and any ambiguity question), omissions, notice, continuation and the `budget` object. `usedBytes` is that exact length, and the effective budget is `min(maxBytes, 4 × maxTokens)`. Tokens are estimated as `ceil(bytes / 4)`. The bootstrap pack is `recall({ maxTokens, maxBytes })` and has the same budget (2,000 tokens / 8,000 bytes by default; bootstrap accepts both, validated as for recall). The envelope is measured first; the continuation may take at most a quarter of the budget, and entries fill the rest (the entry that leads a page may use the continuation's share, which then carries less). Each entry is measured with its fixed metadata (warning, per-reference freshness, citations, provenance, copies) before its body, so under pressure the body is cut, and a cut body ends with an explicit `[… cut by Memchor …; memory_read …]` marker. Warnings and citations are never dropped: an entry whose metadata alone exceeds what the envelope leaves is left out and listed by id in `omissions` (`exceeds_budget`), at most 5 per page (fewer when the budget cannot also hold the continuation), the rest on later pages; what did not fit is counted as `budget` and reachable through `continuation`. The guarantee: every pack is at most the effective budget, with one exception. A budget that cannot hold the envelope (scope is never cut), or the envelope with the one oversized id a page must list to advance, gets a "starved" pack: no entries, no continuation, every match counted as `candidate_limit`, and a notice saying the budget is too small. That pack is the envelope alone and may be larger than the budget. Any budget that holds it makes progress: each page returns an entry or reports one as `exceeds_budget`, and what its continuation cannot carry is counted as `candidate_limit`.

**Continuations** freeze the sequence. Page 1 ranks up to 500 eligible records, and the token carries the unreturned `seq`s in rank order, as many as fit in its share of the budget. The token is HMAC-signed with a per-workspace secret over the workspace, workstream and payload (so it need not carry the ids) and is bound to the query and kinds. Later pages load records by `seq` and re-check scope and eligibility, without re-ranking. So writes between pages, which shift bm25 statistics, can neither reorder nor inject records, and no record a continuation carries is skipped or repeated. Matches beyond the cap, and those a small budget's continuation cannot carry, are reported as `candidate_limit`. This design keeps recall read-only, with no server-side snapshot table to expire.

**Ranking caveat.** bm25's corpus statistics (IDF, average length) are computed by FTS5 over *all* chunks, including retracted and other-workstream records. Ineligible rows can therefore change scores, but never eligibility: they are filtered in the WHERE clause and cannot be returned, cited or counted.

**Durability.** Connections run with `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and a bounded `busy_timeout` (default 5 s). The one-time switch to WAL retries when SQLite answers `SQLITE_BUSY` immediately.

## Recall applicability

Memory is knowledge *about* the repository; the repository stays the source of truth (PRD §11). Recall therefore labels what it returns instead of vouching for it.

**Freshness** (`src/retrieval/freshness.ts`). When an agent writes a record or checkpoint with a local code reference that pins nothing (`commit` and `observedHash` omitted), Memchor observes the file itself, outside the write transaction: the worktree's HEAD, whether the file was dirty, and the SHA-256 of the whole file (≤ 1 MiB), stamped `observedAt`. The content is never stored. At recall and read, each returned reference is labelled:

| Reference | Label | Why |
|---|---|---|
| Same bytes (hash), or clean at the observed commit and still clean at HEAD | `current` / `unchanged` | Equal bytes mean the observation still describes the file. The commit shortcut is sound only when the file was clean then and now: then Git guarantees identical bytes, even for files too large to hash |
| Different bytes / file gone | `stale` / `changed`, `missing` | The record may describe code that no longer exists |
| Imported Read/Edit path | `unknown` / `transcript_reference` | The transcript never fingerprinted what it saw; hashing at import would certify the version on disk *then*, not the one read |
| No fingerprint (caller-pinned, sensitive path, file absent when written) | `unknown` / `not_observed` (`unknown_commit` if a pinned commit is not in the repository) | Nothing to compare against |
| Path outside this worktree (another repository or worktree, a symlink escaping it, `..`) | `unknown` / `outside_worktree` | Never read. Repository identity needs no stored field: each repository has its own database |
| Over 1 MiB and its Git state changed | `unknown` / `too_large` | Reading it would be unbounded work |
| Issue, PR, URL, document | `unknown` / `remote_unverified` | Remote state changes without a local trace, and Memchor makes no network call |

The whole file is hashed, not the cited line range: line numbers shift with any edit above them, so a range hash would misfire both ways, while a whole-file change only costs the agent a re-read. A record's `freshness` is the worst of its references (stale > unknown > current, `unknown` when it has none). A stale or unknown item carries a short `warning` telling the agent to read the current file or verify the remote source.

Validation is bounded. Packing first selects the prefix the budget can hold, sizing every code reference at its smallest possible label. Only that prefix is checked, then repacked with the real labels, which can only shrink it, so no unchecked record is ever returned. Per recall: one path-limited `git status --porcelain=v2` (only the selected paths, never a repository scan), a `git cat-file --batch-check` only when a caller-pinned commit must be checked, at most 64 references (the rest `check_limit`), and 8 MiB hashed. Files are opened non-blocking and must be regular files, so a named pipe cannot hang recall.

**Independent roots** (`independentRoots` in `src/integrity/provenance.ts`). Repetition is not evidence (PRD §13.5): a claim copied five times is still one observation. Every item has an `independentRoot`:

- An imported record's root is its source event, `event:<host>/<eventId>`. The transcript id and branch are deliberately excluded: a Claude Code `/branch` or resumed session re-stores the same entries under a new transcript id, and an edited event keeps its id, so all copies and versions of one host event share a root.
- A record `derived_from` or `supported_by` a visible record takes that record's root (derived_from first, then the earliest target): restating or resting on a claim is not a second observation of it.
- Otherwise the root is the record itself, `record:<recordId>`. Memchor does not infer derivation from similar text. An uncited restatement cannot be told apart from an independent observation, so agents are instructed to cite instead of re-recording, and Memchor's own output in a transcript is never imported as a record.
- One derivation *is* inferred at import, because it is verbatim and the importer saw its cause (PRD §8.3, §17: echoed memory never becomes independent corroboration). When Memchor output in a transcript names existing records (a recall, read or bootstrap the agent ran), a later assistant message or host summary on the same branch that contains one of those records' bodies, or one of its sentences, is stored `derived_from` that record and inherits its root. The comparison ignores case and whitespace. A body or sentence must be at least 40 characters, since short ones ("Tests pass.") recur on their own. The window is the rest of the branch in the current reconciliation pass, not just the turn: the echo stays in the agent's context, and in compaction summaries, after the user speaks again. Statements made before the echo, user messages and tool output are never linked. Only records the transcript's workstream can see become targets. This works for any host, because it only uses the host-neutral echo and message events (`restatedEchoes` in `src/import/reconcile.ts`).

Known limits of the root rule: a paraphrase of echoed memory, or a restatement shorter than 40 characters, still counts as an independent observation, because it cannot be told from one without guessing. So can a copy of memory the agent saw some other way (an earlier transcript, a file it wrote). Messages imported before this rule existed are not re-linked; their events are replays.

Among the loaded candidates, records with the same claim (body, whitespace-normalised) and the same root are collapsed into one item at the rank of the first-ranked one. The item is the group's earliest record (observation time, then storage order), not a newer restatement that ranked higher on recency: a restatement is always written after what it cites, so a Codex note citing Claude's decision never presents that decision as Codex's. It lists up to five `copies` (id, host, session, source, time), and the copies leave the recall sequence with it, so later pages never return them again. Records with the same claim but different roots are never collapsed. Each stays its own item, and `corroboration: { independentRoots, records }` says how many distinct observations and how many records state it. Different claims are never merged either, so conflicting Claude and Codex observations both appear, each with its `host`, `sessionId`, `source` and `createdAt`. Counting is limited to the page's candidates, which can only under-count roots, never over-count them.

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

**Codex format** (`src/import/adapters/codex.ts`). Rollouts live in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` and move flat into `archived_sessions/` when archived; the transcript id is the thread id (`session_meta.id`, also in the file name), so archiving is a move, not a new transcript. Nothing else in `CODEX_HOME` is read (`auth.json`, `config.toml`, `session_index.jsonl`, the SQLite state). The only version stamp is `session_meta.cli_version` on line 1, and it records the thread's *creator*: a newer Codex that resumes a thread appends without re-stamping. The table therefore gates whole files, strictly on evidence:

| Codex creator version | Format | Basis |
|---|---|---|
| ≥ 0.125.0-alpha.3, < 0.143.0 | `codex-rollout-legacy-v1` | 110 local Codex Desktop rollouts from 0.125.0-alpha.3, 0.126.0-alpha.8, 0.133.0-alpha.1, 0.142.0–0.142.5; `openai/codex` rust-v0.142.5 has no `history_mode`. Fixtures for 0.125.0-alpha.3 and 0.142.5 |
| ≥ 0.148.0-alpha.21, < 0.148.0-alpha.22 | `codex-rollout-legacy-v1` | Legacy-mode rollouts written by the pinned `codex-cli 0.148.0-alpha.21` (`codex app-server` `thread/start`); its source still persists `user_message`/`agent_message`/`mcp_tool_call_end` in legacy mode. Fixtures for 0.148.0-alpha.21 |

In every row, a paginated rollout (`history_mode` other than `"legacy"`, or any line with a top-level `ordinal`) stops with `hostVersion` `<cli_version>+paginated`: that format drops the message events in favour of `item_completed`. Versions compare by semver precedence (`src/import/versions.ts`), so `0.148.0-beta.21` is not mistaken for `0.148.0-alpha.21`. A rollout that stops at its first line stores nothing, not even a cursor; it is reported as `stopped` with its gap and re-read on every pass.

Mapping. User text comes only from `event_msg/user_message` (Codex's record of what was typed, never injected context) and assistant text only from `event_msg/agent_message`; their `response_item/message` copies would double every message and are counted as metadata, or as `injected_context` for developer messages and Codex's contextual user blocks (`# AGENTS.md instructions`, `<environment_context>`, `<skill>`, …). Reasoning is `hidden_reasoning`. `function_call`/`custom_tool_call`/`local_shell_call`/`web_search_call` are tool calls, joined to `*_output` by `call_id`; Codex's output framing (`Chunk ID`/`Wall time`/`Process exited with code N`/`Exit code: N`) is stripped and a non-zero exit code is the only error signal (Codex does not persist a success flag). `apply_patch` (its `*** Add/Update/Delete File` and `Move to` paths, resolved against the turn's cwd) and `view_image` are artifact access. A shell command (`exec_command`, `shell`, `shell_command`) is artifact access only when it is a pure file read (below), with its paths resolved against the call's `workdir`; any other command is `other`. `write_stdin` keeps only the session, never the keystrokes. Memchor's own calls (`mcp__<server>` namespace or the flat `mcp__<server>__memory_*` name, optionally with Codex's `_<12 hex>` collision suffix) are kind `memchor`, and their result is the bare MCP JSON, so echo suppression and the step-1 binding signal work as for Claude. A local compaction's `compacted.message` becomes a host summary without Codex's prompt prefix; a remote (encrypted) one and its `replacement_history` import nothing.

Identity and context. Legacy events carry no ids, and the files are append-only, so an event's id is `<thread id>@<byte offset>` (plus `#k`), globally unique because independent roots use host + event id only. The cwd is per turn: each event gets the cwd of the last `turn_context` before it (a read that starts mid-file scans back up to 1 MiB for it), so a turn that moves to another worktree quarantines the rollout from there. The git branch label follows the last own-id `session_meta` (Codex appends a copy with updated `git`). Subagent threads (`source.subagent`) are not listed: their "user" is the parent agent, which already holds their result.

Forks. A fork's file starts with a verbatim, re-timestamped copy of its parent's rollout. When the parent is on disk, each copied line that equals the parent's line (timestamp ignored), from the parent's first line up to the first difference, keeps the *parent's* event id and time, so the copy is a copy of the same observation in recall, never independent corroboration.

Live binding. Codex sends `_meta.threadId` (the rollout's id) on every `tools/call` and nothing in `initialize`. `memchor mcp --host codex` adopts it as the host session id before the first operation binds the session (a per-host `_meta` key in `src/transports/mcp.ts`; Claude Code sends none), so the thread's rollout, when imported, resolves to the live session's workstream by step 1.

Known Codex limits:

- Not supported, reported as `unsupported_version` gaps: 0.104.x (it writes `user_message` before its turn's `turn_context`), 0.143.0 – 0.148.0-alpha.20 and anything newer than 0.148.0-alpha.21 (no rollouts or build to verify), and every paginated rollout (the 0.148 TUI and `codex exec` create paginated threads by default; the app-server, which Codex Desktop uses, creates legacy ones unless asked otherwise). Compressed `.jsonl.zst` rollouts (an off-by-default feature) are not listed.
- A resumer newer than the creator appends lines Memchor cannot version-check; unknown types among them are skipped and counted, never guessed.
- Rolled-back turns (`thread_rolled_back`) stay imported: they were already emitted when the rollback line arrives, and the adapter seam cannot retract. The user can retract them with `memory_manage`.
- A fork whose parent rollout is not on disk keeps its own ids for the copied prefix, so the copy over-counts as an independent observation until the parent reappears (a changed id then counts as a new event, not a replay).
- If more than 1 MiB of output separates a turn's `turn_context` from a batch boundary, events after the boundary take the thread's initial cwd and branch label (a batch boundary falls there only in very long turns; no local rollout ever changed cwd mid-thread).
- A web search has no result line, so it is kept as call bookkeeping only, never as a record. MCP results can be truncated by Codex in `function_call_output`; the id extraction then falls back to scanning the text, as for clipped Claude output. MCP `isError` is not read (it lives only in `mcp_tool_call_end`).

**What is stored.** User text → `evidence` / `user_direction`. Assistant text → `evidence` / `agent_inference`. Tool call and its result → one `evidence` / `direct_observation` record with the call summary and a bounded output. Host summaries (compaction, away summary) → `note`. Records carry `createdAt` = the event time and `source` = {host, transcript, branch, event}. Privacy rules (`src/import/privacy.ts`):

| Content | Handling |
|---|---|
| Thinking, injected context (`isMeta`, non-human origin, `<system-reminder>`; Codex developer messages and contextual user blocks), attachments, metadata entries, images and audio | Excluded and counted |
| File reads and edits (Read, Write, Edit, NotebookEdit; Codex `apply_patch`, `view_image`), and shell commands that only print files | Reference only: path as a code `externalRef`, no content |
| Output of a call touching `.env`, keys, credential files | Withheld |
| Credentials (AWS, GitHub, Anthropic/OpenAI-style, Slack, Google, JWT, private keys, URL passwords, `secret=` assignments) | `[redacted:<kind>]`; pattern-based, so best-effort |
| Messages > 4 KB, tool output > 1.5 KB, summaries > 8 KB | Head + tail with `[… N bytes omitted by Memchor …]` |
| Memchor's own tool calls and results | Never records; the existing record ids they mention are kept as references |
| A tool result whose call could not be read | Output withheld (fails closed: its path is unknown) |

Shell file reads (`src/import/shell-reads.ts`, shared by both adapters for Claude's `Bash` and Codex's shell tools). Agents read code through the shell far more often than through a read tool: `sed -n` and `nl -ba … | sed -n` make up over 40% of the shell commands in the local Codex rollouts the format was checked against. A command counts as a pure read only when every part of it is understood without evaluating anything, and every file it reads resolves inside the event's working directory: `cat`, `head`, `tail`, `nl`, `less`, `more`, `bat`, or `sed -n` whose script only prints (`12p`, `1,200p`, `/re/,/re/p`), with their options and file operands; joined by `|`, `&&`, `;` or newlines; with `cd <dir>` (which moves where later relative paths resolve), `echo` separators, `2>/dev/null` / `2>&1`; optionally inside one `bash|sh|zsh -c '<script>'` wrapper. Later pipeline stages may filter what the first printed. Options are checked against a per-command allow-list, every letter of a short-option cluster included, and a count must be a number: an unknown letter or long option fails closed, so `less -So log.txt` (`-o`/`-O` write a log file), `less -k`, a pager's `+cmd` operand (`less`, `more`) and `bat --pager`/`--paging` other than `never` are not reads. A read of a file outside the working directory (`cat /tmp/test.log`, `tail ../other/notes.md`, or after `cd` out of it) is not a pure read either: the importer only references paths inside the worktree, so treating it as one would drop both the output and the path. It stays `other`, and the importer's redaction and sensitive-path withholding apply to its output as to any command (`cat ~/.aws/credentials` or an absolute `.env` is withheld). Everything else stays `other` and is kept as a bounded passage as before: `$`, backticks, `$(…)`, `~`, braces, subshells, `||`, `&`, any other redirect or heredoc, `sed -i`/`-f` or a `w` command, positional arguments after a `-c` script, and searches (`grep`, `rg`), whose matched lines are results rather than a file read. A glob operand (`cat src/*.ts`) is still a read, but no single path is recorded for it. Known limits: a read written any other way (an interpreter one-liner, `awk`, `xxd`, an unrecognised option) keeps up to 1.5 KB of the file as a tool-output passage, as before. What an `echo` separator prints (`echo '---'; cat a.ts`) goes with the file content, and the stored call summary is the tool and its first path rather than the command, so the echoed literal is not kept. Codex's `local_shell_call` (not seen in local history or the fixtures) is not classified. Shell commands imported before this classification (or before a change to it) keep what was stored for them: nothing is backfilled. If such a transcript is later rewritten, the new pass sees the call's changed identity (its retention and paths are part of the tool-call hash) and records it as a new version, counted in `conflicts`; the result, whose text is unchanged, is a replay and keeps its stored content.

**Batches and cursors.** Each batch (≈1 MiB of transcript) is one `BEGIN IMMEDIATE` transaction:

```text
re-read cursor (CAS: another process moved it → give up this transcript for now)
  → first batch: ensure workspace row, worktree binding, session, source, cursor
  → per event: scope check → identity lookup (same hash: replay) → suppressed host event? skip → (other hash: new linked version) → record + links (+ inherited taints) + chunks + import_events row
  → update cursor: offset, anchor hash, state, gap, counters (file size/mtime only once caught up)
```

A kill mid-batch rolls the whole batch back. The cursor never passes evidence that is not durable, and the retry re-reads the same lines (tested with a real `SIGKILL`). Unchanged file → skipped without reading. Grown with a matching anchor → append. Otherwise (rewritten or truncated) → a new pass from byte 0 under a new epoch, reconciled by identity. Identities not seen again are reported as `missing` and never deleted. A partial trailing line (the host is still writing) is left for later. Known limit: an edit that keeps the file's size and falls before the 4 KiB anchor is not detected. Claude Code and Codex (legacy rollouts) only append, so this needs an outside rewrite. Codex's opt-in in-place migration to paginated rollouts is a rewrite: the new pass stops at line 1 (`+paginated`) and the records already imported are kept.

**Scope.** Before its first batch, a transcript is resolved by the same `resolveWorkstream` a live bootstrap uses. The inputs are its first event's worktree and current branch, its transcript id as the host session id (for Codex, the thread id the live server adopted from `_meta.threadId`), and the `scope.workstreamId` reported by Memchor output in that batch before the transcript leaves its first worktree. So Memchor output naming an existing workstream of this workspace is authoritative (step 1), even over the worktree's binding. A live session with the same host session id is authoritative too. Every distinct cwd is resolved through Git (once per process). There is no path-prefix shortcut, because a directory inside the worktree can be a nested worktree, a submodule or another clone.

- **Held.** When resolution is ambiguous (conflicting session metadata, or a worktree whose only evidence is an orphaned workstream's branch), nothing is written. The transcript counts as `quarantined` and is reported as a `scope_ambiguous` gap. It is re-resolved when its file changes or at the next bootstrap, for example after the user chose that worktree's workstream. It is *not* imported workspace-level: workspace-level records are recalled in every workstream, so ambiguous history would enter current guidance.
- **Quarantined.** After the first batch, two things quarantine a transcript from that line on (`scope_ambiguous`, cursor held, nothing after it imported): a later event whose cwd is in another worktree or repository, or Memchor output naming a different existing workstream.

Transcripts whose cwd is gone or not in Git are counted as `unassigned`. `all projects` imports each repository into its own workspace database. Retrieval never mixes them.

**Order and budget.** Bootstrap imports only the current repository (newest transcript first) until its budget. The MCP server then calls `continueImport` in 200 ms steps with 25 ms pauses until every approved transcript is reconciled. Expected failures (`storage_busy`, `storage_full`, `storage_unavailable`, an unreadable `consent.json` → state `unavailable`) are reported as `import.problem` and never fail bootstrap. The MCP loop retries a failed step with backoff (2 s … 32 s, five times). Any other error is a bug: the batch rolls back and the error propagates. Gaps met while backfilling other projects are reported in this process's status, labelled with their workspace. No model call and no network access are involved; the e2e test preloads a guard that fails on any socket, DNS lookup or fetch.

## Memory lifecycle

`memory_manage` (`src/integrity/lifecycle.ts`) owns every change to whether a claim is current guidance. Handlers and agents never touch the tables; one call is one `BEGIN IMMEDIATE` transaction with no model or network call inside.

```text
                 correct ──▶ corrected   wrong; a `correction` record (body + "Reason: …") supersedes it
  active ──────  supersede ─▶ superseded right then, outdated now; a same-kind record replaces it
    ▲            retract ──▶ retracted  wrong; withdrawn without a replacement
    └── restore ◀────────────┘           only a retraction made here; removes exactly its own taints and suppressions
  any state but forgotten ── forget_preview → user confirms → forget ──▶ forgotten   payload removed; final
```

`review_state` stays the review axis (unreviewed / accepted / disputed); `record` no longer accepts `retracted`. Records the v3 migration retracted become `lifecycle = 'retracted'` and can never be restored.

**One claim, one observation.** A change applies to the record and every in-scope copy of the same host event (host + event id: a Claude Code `/branch` copy, an edited version), the same identity independent roots use. The event goes into `suppressions`, so a cursor reset, rewrite pass or new copy skips it (`import.counters.suppressed`). An imported record that restates or rests on an ineligible record (an echoed record corrected since, an earlier version) is linked to it and inherits its state (`lineage: "inherit"` in `appendRecord`), and a host summary imported after a corrected event of its transcript is quarantined.

**Dependents are tainted in the same transaction** (`src/integrity/taints.ts`), transitively, depth ≤ 16:

| Dependency on the changed claim | correct / retract | supersede |
|---|---|---|
| `derived_from` (restates it) | invalidated | invalidated |
| `supported_by` (rests on it) | quarantined | — |
| No lineage: a checkpoint repeating it verbatim (the ≥ 40-character rule in `src/integrity/restatement.ts`, last 1,000 checkpoints of its scope), a host summary of its transcript written at or after it | quarantined | — |

`related_to` and `references` never taint: they are loose. A superseded claim was true when made, so conclusions that rested on it stay. A quarantined head checkpoint is withheld from packs with a notice asking for a new checkpoint (`expectedRevision` = the head); older revisions are not promoted.

**Correction watermark.** Each change appends a `lifecycle_events` row. A Memory instance (one host session) starts at the current watermark; its next pack carries `corrections: { watermark, changes (≤ 5, oldest first), omitted }` for changes in its scope since, then advances. The notice is part of the budgeted envelope. A session is not told about its own change unless other changes came first.

**Forget** is the one change that deletes. `forget_preview({recordIds ≤ 50})` is read-only: it lists the targets (with excerpts), every copy of the same host event, the records that will be invalidated or quarantined (their own content is kept, and the preview says so), and how many links, search chunks and host events are affected, plus a `confirmToken`: an HMAC over the ids, a digest of that impact and a 30-minute expiry, bound to the workspace and workstream. `forget({confirmToken, reason, attribution})` recomputes the impact and refuses with `invalid_input` (`preview_outdated`) if it differs, so what the user confirmed is what happens. Then, in one transaction: taints; the FTS entries are deleted and the index is optimized; chunks and links are deleted; title, body, references, applicability and content hash are blanked; the reasons of the record's earlier lifecycle changes (they may quote it) and, for a tool result, its call's summary in `import_events` become `[forgotten]`; the result and call events are suppressed. What stays is a tombstone: id, kind, host, times, provenance ids, lifecycle `forgotten`. Connections run with `secure_delete = ON`, so freed pages are zeroed; `tests/import/lifecycle-replay.test.ts` checks the database file itself.

**Ledger and restore.** Every change is also appended (fsynced, inside its transaction) to `$MEMCHOR_HOME/workspaces/<id>/lifecycle.jsonl`: ids, action, attribution, host, the host events, time. Never content. The one supported restore procedure is putting an older copy of `memory.sqlite` back (removing its `-wal`/`-shm`). Every workspace open (`openWorkspaceDatabase`, used by sessions and the importer) re-applies the ledger entries the database lacks, in order, with the same effects code live changes use, and an audit reason saying so. A record the copy never had still gets its host events suppressed, so a later import cannot bring it back. The check is lock-free when nothing is missing; a gap takes the write lock and re-reads, so a change still committing in another process is never applied twice.

**Inspect** returns any in-scope record whatever its state: body (≤ 4 KB), lifecycle, `eligible`, taints with causes, live freshness, source, `history` (its lifecycle events), `replacement`, `evidence` (what it rests on or restates), `conflicts` (other versions of the same event, `related_to` records) and `derivations` (incoming `derived_from`/`supported_by`, with the taint it put on each), each list ≤ 20 with totals in `counts`.

Known limits: forgetting is not forensic erasure. A claim already in a model's context, in a host transcript, in WAL frames not yet checkpointed, or in an export or backup is not erased. Deleting `lifecycle.jsonl` removes the restore protection; a running session hears of a change only on its next pack. A paraphrase in a checkpoint or summary, or an uncited agent record repeating the claim, is not found (verbatim only). Copies in another workstream are not changed, though their host event is suppressed for the whole workspace.

## Handoff

The V1 story (Claude Code → a fresh Codex session → a fresh Claude Code session in one worktree) needs no handoff-specific code: each host runs its own `memchor mcp` process, and they meet only in `$MEMCHOR_HOME` through the pieces above.

```text
Claude  memchor mcp --host claude-code   bootstrap (consent, import its transcripts) → record → checkpoint r1
                                              │ same repository key → same workspace database
Codex   memchor mcp --host codex         bootstrap (consent, import its rollouts; _meta.threadId = the thread)
                                              │ worktree binding → same workstream; the rollout joins it by session binding
                                              → pack: r1 + Claude and Codex records, each with host/session/source,
                                                live freshness (unchanged file current, edited file stale + "read the current file"),
                                                independent roots; conflicting claims both kept → checkpoint r2 (CAS on r1)
Claude  memchor mcp --host claude-code   bootstrap → r2 from Codex, with the same freshness warnings
```

The proof is `tests/handoff/`:

- `handoff.test.ts` (always runs): separate server processes with the no-network preload, hand-written Claude and Codex (`0.148.0-alpha.21/handoff.jsonl`) histories, and a second repository with the same directory name in the same `MEMCHOR_HOME`. It checks the three sessions, a stale concurrent Claude checkpoint (`checkpoint_conflict`), the root rule (a `/branch` copy and a Memchor echo add nothing, Codex stating Claude's claim after its own test run and before any recall is a second root, its verbatim repeat after the recall echoed Claude's record is a copy, a cited restatement is a copy), no leakage into any pack or `memory_read`, truncation, and a worktree two earlier sessions could continue (`scope.ambiguity` until the user chooses).
- `handoff-real-codex.test.ts`: the Codex step through the pinned `codex app-server` and a localhost stub model (skipped like `codex-connection.test.ts`).
- `matrix.test.ts`: the repository/worktree identity and freshness matrix.

Each run writes the packs and the matrix, with temporary paths replaced by placeholders, to the git-ignored `tests/mcp/__artifacts__/handoff/`.

The host connections are pinned to the releases they were tested with: Claude Code `2.1.282` (`tests/mcp/claude-connection.test.ts`: `claude mcp add -s user`, the `list`/`get` health checks, and a `claude -p` session against a localhost stub model) and `codex-cli 0.148.0-alpha.21` (`tests/mcp/codex-connection.test.ts`). Each host starts one `memchor mcp` per session in the session's working directory, which is how Memchor finds the repository. Claude Code passes its own environment to the server; Codex clears it, so `CODEX_HOME` and `MEMCHOR_HOME` must be given explicitly. The README has the exact commands.

## Runtime gate

At open, Memchor requires embedded SQLite ≥ 3.51.3, the release with the fix for the [WAL-reset bug](https://sqlite.org/wal.html#walresetbug). It also requires FTS5: the compile option must be present and creating an FTS5 table must succeed. If either check fails, it throws `unsupported_runtime` with the version it found. The rule is the pure function `assertSupportedRuntime`, which has no override. `memchor mcp` runs it at process start and exits non-zero with the message on stderr before serving. Every database open runs it again.

## Error codes

| Code | Meaning |
|---|---|
| `scope_unresolved` | cwd is not inside a Git worktree |
| `scope_ambiguous` | No workstream is chosen yet (`scope.ambiguity`): thrown by `record` without `workspaceLevel` and by `checkpoint`; `details.candidates` lists the ids. Also the gap reason for a held or quarantined transcript |
| `scope_denied` | The target belongs to another workstream |
| `not_found` | Unknown or ineligible record (its `details` name the `lifecycle`, `replacementId` or `taint`), or a chosen `workstream` that is not in this workspace |
| `lifecycle_conflict` | `memory_manage` found the claim in the wrong state (already corrected, or restoring what was not retracted here); `details.lifecycle` / `replacementId` |
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
- Steps run with foreign keys off, as SQLite's documented table-rebuild procedure requires. v4 rebuilds `sessions` to make `workstream_id` nullable. v5 adds `records.lifecycle` and the `taints`, `lifecycle_events` and `suppressions` tables. Each step runs `foreign_key_check` before committing, and rolls back on any violation.
- Concurrent openers serialise, and the second finds nothing to do.
- A database newer than the build fails closed before any pragma changes it.
- A shipped migration is never edited.
- Every new version needs an upgrade test from each earlier version (`tests/migrations/`).
