# Architecture

```
memchor mcp (src/transports/mcp.ts)   memchor diag (src/cli.ts)
            └──────────────┬──────────────┘
                 src/memory.ts  ← all policy
   scope · idempotency · CAS · eligibility · budgets · citations
                           │
       one SQLite file per workspace (WAL, FTS5)
```

The adapters contain no memory policy. The MCP server forwards raw tool arguments to the module. The module parses them with the zod schemas in `src/schemas.ts`, which are also the source of the tools' JSON Schemas. Each `MemchorError` becomes `isError: true` with `{ error: { code, message, retryable, details } }`.

## Memory module interface

`openMemory({ cwd, host, home?, hostSessionId?, busyTimeoutMs? }): Memory`. All methods are synchronous and throw only `MemchorError` for expected failures.

| Method | Contract |
|---|---|
| `bootstrap({hostSessionId?})` | Binds scope and returns it, the created flags, the runtime, and `recall({})` |
| `record({kind, body, attribution, …})` | Appends one record with its links and search chunks; `operationKey` makes it idempotent |
| `checkpoint({expectedRevision, goal, status, …})` | Appends revision `expectedRevision + 1` only if the head still equals `expectedRevision` |
| `recall({query?, kinds?, maxTokens?, maxBytes?, continuation?})` | A bounded pack: head checkpoint first, then ranked eligible items |
| `read({recordId, maxTokens?, maxBytes?, offset?})` | A slice of one visible record's body, with its visible links |
| `status()` | Runtime, storage, scope and counts. Never throws for scope problems |
| `rebuildSearchIndex()` / `checkIntegrity()` | Regenerate the derived index / read-only checks |

**Scope** is resolved once per instance from the trusted `cwd`:

1. Git toplevel and common dir give the workspace (id = hash of the common dir's realpath).
2. For the workstream, an existing worktree binding wins.
3. Otherwise the worktree adopts the single active workstream labelled with its branch. Two or more such workstreams is `scope_ambiguous`.
4. Otherwise a new workstream is created.

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
| `sources`, `consents`, `import_cursors` | Reserved for later slices | Created now to avoid a migration |

**Eligibility** (`src/retrieval/eligibility.ts`) is one SQL predicate used for reads, links, citations and ranking. A record must be in this workstream or workspace-level, and not retracted. Recall additionally excludes checkpoint records: the head is returned separately.

## Transaction ordering

Every write is one `BEGIN IMMEDIATE` transaction, so it never upgrades from reader to writer and cannot hit `SQLITE_BUSY_SNAPSHOT`. Inside it:

- **`record`**: look up the operation key → insert the record → insert links (each target scope-checked) → insert chunks and FTS rows → insert the operation row.
- **`checkpoint`**: look up the operation key (a replay wins over a conflict) → compare the head with `expectedRevision` → append the checkpoint record, its links and chunks → insert the `checkpoints` row → conditionally update `head_revision`.

**Reads.** Recall reads in one deferred transaction, so the head, candidates and citations share a snapshot. Scope and eligibility sit in the WHERE clause, ahead of bm25 ranking. Ties are broken by `created_at DESC, seq DESC`. Query words are individually quoted, so FTS syntax cannot be injected.

**Budgets.** A pack's size is the sum of the UTF-8 JSON bytes of the checkpoint and items, and never exceeds `min(maxBytes, 4 × maxTokens)`. Tokens are estimated as `ceil(bytes / 4)`.

**Continuations** are HMAC-signed with a per-workspace secret and bound to the workspace, workstream, query, kinds and a `seq` snapshot.

**Durability.** Connections run with `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and a bounded `busy_timeout` (default 5 s). The one-time switch to WAL retries when SQLite answers `SQLITE_BUSY` immediately.

## Runtime gate

At open, Memchor requires embedded SQLite ≥ 3.51.3, the release with the fix for the [WAL-reset bug](https://sqlite.org/wal.html#walresetbug). It also requires FTS5: the compile option must be present and creating an FTS5 table must succeed. If either check fails, it throws `unsupported_runtime` with the version it found.

## Error codes

| Code | Meaning |
|---|---|
| `scope_unresolved` | cwd is not inside a Git worktree |
| `scope_ambiguous` | Several active workstreams could own this unbound worktree |
| `scope_denied` | The target belongs to another workstream |
| `not_found` | Unknown or ineligible (e.g. retracted) record |
| `invalid_input` | Schema violation, unknown key, oversized content, or a bad continuation |
| `idempotency_conflict` | The operation key was reused with a different request |
| `checkpoint_conflict` | The head ≠ `expectedRevision`; `details.currentRevision` gives the head |
| `storage_busy` | The busy timeout was exceeded (`retryable: true`) |
| `storage_full` | The disk or database is full; nothing was acknowledged |
| `storage_unavailable` | The database, registry or home cannot be used |
| `unsupported_runtime` | SQLite too old, no FTS5, or a database schema newer than this build |

## Migrations

`src/storage/migrations/` holds an append-only ordered list, and `PRAGMA user_version` is the applied count:

- Each step runs in its own `BEGIN IMMEDIATE` transaction together with the version bump, so a failed step leaves the previous version intact.
- Concurrent openers serialise, and the second finds nothing to do.
- A database newer than the build fails closed before any pragma changes it.
- A shipped migration is never edited.
- Every new version needs an upgrade test from each earlier version (`tests/migrations/`).
