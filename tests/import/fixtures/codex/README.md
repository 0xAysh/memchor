# Codex rollout fixtures

Hand-written JSONL in the shape Codex writes to
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` (or flat under
`archived_sessions/`). Every line keeps the real key set of its item type for that creator
version (observed on local rollouts and on rollouts written by the bundled
`codex-cli 0.148.0-alpha.21` in a temporary `CODEX_HOME`, 2026-09); all content, ids, paths and
hashes are synthetic. `base_instructions` is a placeholder: the real field holds Codex's whole
system prompt.

Nothing here is copied or derived from a real rollout, and none ever should be: rollouts hold
account ids, file contents and credentials. To check the importer against real local history,
snapshot it into the git-ignored `.real-transcripts/` (`npm run snapshot:transcripts`, which
copies only `*.jsonl` rollouts); `tests/import/real-history.test.ts` then runs against it locally.

Placeholders, substituted by `renderCodexFixture` in `tests/import/fixtures.ts`:

| Placeholder | Replaced with |
|---|---|
| `{{CWD}}` | the test's Git worktree (absolute path) |
| `{{CWD2}}` | a second directory the thread moves to (`cwd-change.jsonl`) |
| `{{THREAD}}` | the thread id (also the file name's id) |
| `{{PARENT}}` | the parent thread id (forks, subagents) |
| `{{SHA}}` | a commit hash |
| `{{WORKSTREAM}}`, `{{RECORD}}` | Memchor ids in Memchor's own output |
| `{{LARGE_OUTPUT}}` | generated at render time |

| File | Creator version | Covers |
|---|---|---|
| `0.142.5/basic.jsonl` | 0.142.5 | developer + contextual user messages, `user_message`/`agent_message` with their `response_item` copies, reasoning, `exec_command` (exit 1 and 0), `apply_patch` (Update + Add), `view_image` with an image output, web search (search, open_page), task/token bookkeeping |
| `0.142.5/memchor-echo.jsonl` | 0.142.5 | Memchor calls in the namespaced (`mcp__memchor`), flat (`mcp__memchor__memory_recall`) and trailing-`__` forms, `mcp_tool_call_end`, another MCP server's tool |
| `0.142.5/injected.jsonl` | 0.142.5 | `<skill>`, `<subagent_notification>`, `<turn_aborted>`, `<recommended_plugins>`, `<user_shell_command>` user blocks |
| `0.142.5/metadata-updates.jsonl` | 0.142.5 | a repeated own-id `session_meta` with a new `git.branch` and `memory_mode`, `turn_aborted`, `thread_rolled_back`, a remote (encrypted) compaction |
| `0.142.5/cwd-change.jsonl` | 0.142.5 | a second turn whose `turn_context.cwd` is `{{CWD2}}` |
| `0.142.5/malformed.jsonl` | 0.142.5 | an unparseable line, an unknown item type, an unknown `event_msg` type, non-JSON `arguments`, a partial trailing line |
| `0.142.5/large-and-sensitive.jsonl` | 0.142.5 | oversized exec output, `cat .env`, `apply_patch` on `.env`, a token in assistant text, `write_stdin` keystrokes |
| `0.142.5/shell-reads.jsonl` | 0.142.5 | shell commands that only print files (`sed -n`, `nl -ba … \| sed -n`, `&&`/`;` chains, `cd`, a sub-directory `workdir`, `bash -lc`/`zsh -lc` wrappers) and ones that do not (a test run, `grep`, `sed -i`, a sed `w`, a redirect, `$…`, `$(…)`, `\|\|`, `$0` arguments). The `shell` (argv) and `shell_command` argument shapes follow `openai/codex` source; local history only has `exec_command` |
| `0.142.5/shell-flags.jsonl` | 0.142.5 | reader options checked letter by letter: harmless clusters and values (`cat -ns`, `head -n40`, `tail -n +20`, `nl -ba -w4`, `less -SN`, `bat --paging=never`, `sed -ne`) and ones that write, run a command or are unknown (`less -So log.txt` in a cluster, `less -O`/`-k`, `less '+!…'`, `more +/…`, `bat --pager`/`--paging=always`, a non-numeric count, `cat -z`, `nl -Q`, `sed -nf`, `sed -en`) |
| `0.142.5/shell-outside.jsonl` | 0.142.5 | shell reads outside the turn's cwd (an absolute `/tmp` log, `../sibling`, after `cd` out), `~/.aws/credentials`, absolute credentials and `.env` files, the worktree's own `.env`, and an `echo` separator before an in-tree read |
| `0.125.0-alpha.3/basic.jsonl` | 0.125.0-alpha.3 (oldest supported) | the pre-0.142 key sets (no `session_id`, item ids, passthrough metadata or `client_id`; `turn_context` with instructions and truncation policy) |
| `0.133.0-alpha.1/subagent.jsonl` | 0.133.0-alpha.1 | a `thread_spawn` subagent (never listed by discovery) |
| `0.148.0-alpha.21/basic.jsonl` | 0.148.0-alpha.21, legacy | `history_mode`, `context_window`, `world_state`, `thread_settings_applied`, `user_message.audio`, the MCP call triple exactly as Codex writes it |
| `0.148.0-alpha.21/local-compaction.jsonl` | 0.148.0-alpha.21, legacy | a local compaction: assistant `response_item` without `agent_message`, `compacted.message` with Codex's summary prefix |
| `0.148.0-alpha.21/fork-parent.jsonl`, `fork.jsonl` | 0.148.0-alpha.21, legacy | a fork (`forked_from_id`) whose file starts with a re-timestamped copy of its parent, then `thread_settings_applied` and its own turn |
| `0.148.0-alpha.21/handoff.jsonl` | 0.148.0-alpha.21, legacy | the Codex side of `tests/handoff/`: a failing `exec_command` and an agent message stating a Claude claim from that run, then a Memchor recall echoing the Claude record and a verbatim repeat of it, and a message contradicting a Claude observation |
| `0.148.0-alpha.21/paginated.jsonl` | 0.148.0-alpha.21, paginated | `history_mode: "paginated"`, `ordinal` on every line, `item_completed` |
| `unknown-version.jsonl` | 0.104.0-alpha.1 (not in the table) | stops at line 1 |
