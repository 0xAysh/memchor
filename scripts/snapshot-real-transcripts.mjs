#!/usr/bin/env node
/**
 * Copies the developer's real agent transcripts into the git-ignored `.real-transcripts/`
 * so the opt-in real-history tests run against a fixed local snapshot:
 *
 *   .real-transcripts/claude/projects/<project>/<session>.jsonl   (usable as CLAUDE_CONFIG_DIR)
 *   .real-transcripts/pi/sessions/<project>/<session>.jsonl
 *   .real-transcripts/codex/{sessions/YYYY/MM/DD,archived_sessions}/rollout-*.jsonl   (usable as CODEX_HOME)
 *
 * Only `*.jsonl` transcripts are copied: never Claude settings or memory, never Pi's
 * auth.json, settings or models, never Codex's auth.json, config.toml, SQLite state or
 * session_index.jsonl (it lives outside the two rollout directories). Refuses to run unless git confirms the destination is
 * ignored, so the snapshot cannot be committed by accident.
 *
 * Usage: npm run snapshot:transcripts   (CLAUDE_CONFIG_DIR / PI_AGENT_DIR / CODEX_HOME override the sources)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dest = join(repo, ".real-transcripts");
try {
  // Probe a file path inside: a directory-only pattern cannot match a directory that does not exist yet.
  execFileSync("git", ["check-ignore", "--quiet", join(dest, "claude", "probe.jsonl")], { cwd: repo });
} catch {
  process.stderr.write(`refusing: ${dest} is not git-ignored\n`);
  process.exit(1);
}

const sources = [
  { name: "claude", from: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), to: join(dest, "claude", "projects") },
  { name: "pi", from: join(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions"), to: join(dest, "pi", "sessions") },
  ...["sessions", "archived_sessions"].map((dir) => ({
    name: `codex ${dir}`,
    from: join(process.env.CODEX_HOME || join(homedir(), ".codex"), dir),
    to: join(dest, "codex", dir),
  })),
];

for (const { name, from, to } of sources) {
  if (!existsSync(from)) {
    process.stderr.write(`${name}: ${from} not found, skipped\n`);
    continue;
  }
  rmSync(to, { recursive: true, force: true }); // replace the previous snapshot of this source only
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const target = join(to, relative(from, path));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(path, target, { preserveTimestamps: true });
        files++;
        bytes += statSync(path).size;
      }
    }
  };
  walk(from);
  process.stderr.write(`${name}: ${files} transcripts (${(bytes / 1e6).toFixed(1)} MB) → ${relative(repo, to)}\n`);
}
