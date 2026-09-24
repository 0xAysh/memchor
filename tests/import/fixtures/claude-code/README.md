# Claude Code transcript fixtures

Hand-written JSONL in the shape Claude Code writes to
`$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`. Every line keeps the real key set
of its entry type for that version (observed on local transcripts, 2026-09); all content,
ids, paths and hashes are synthetic.

Nothing here is copied or derived from a real transcript, and none ever should be:
transcripts hold account ids, file contents and credentials. To check the importer
against real local history, run the opt-in suite, which reads it in place and commits
nothing:

```sh
MEMCHOR_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts
```

Placeholders, substituted by `tests/import/fixtures.ts`:

| Placeholder | Replaced with |
|---|---|
| `{{CWD}}` | the test's Git worktree (absolute path) |
| `{{SESSION}}` | the transcript's session id |

| Directory | Claude Code version | Covers |
|---|---|---|
| `2.1.281/basic.jsonl` | 2.1.281 (installed when written) | user/assistant text, thinking, Bash/Read/image tool results, a Memchor echo, injected context, attachments, metadata lines, a secret in tool output |
| `2.1.281/branches.jsonl` | 2.1.281 | a rewind fork (two children of one parent) and an inline sidechain |
| `2.1.281/compaction.jsonl` | 2.1.281 | `compact_boundary` + `isCompactSummary` summary, `away_summary` |
| `2.1.281/malformed.jsonl` | 2.1.281 | an unparseable line mid-file, an unknown entry type, a partial trailing line |
| `2.1.281/large-and-sensitive.jsonl` | 2.1.281 | an oversized message and tool output (`{{LARGE_MESSAGE}}`, `{{LARGE_OUTPUT}}`, generated at render time), a `.env` read, credentials in assistant text |
| `2.1.183/basic.jsonl` | 2.1.183 (oldest observed) | the pre-2.1.200 key set (no `origin`, `slug`, `session_id` …) |
| `unknown-version.jsonl` | 3.0.0 (not in the compatibility table) | a supported prefix followed by an unsupported version |
