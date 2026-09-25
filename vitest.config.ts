import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * On macOS `/usr/bin/git` is an xcrun shim that costs ~100 ms per spawn under test
 * load. Putting the real binary (the same git the shim would run) first on PATH keeps
 * the Git-heavy suites fast without changing what the product executes.
 */
function pathWithRealGit(): string | undefined {
  const path = process.env["PATH"];
  if (process.platform !== "darwin") return path;
  try {
    const git = execFileSync("xcrun", ["--find", "git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return git === "" ? path : [dirname(git), path].filter(Boolean).join(delimiter);
  } catch {
    return path;
  }
}

const PATH = pathWithRealGit();
/** Tests never read the developer's real Claude Code or Codex history unless a test passes its own directory. */
const CLAUDE_CONFIG_DIR = join(tmpdir(), "memchor-tests-no-claude-config");
const CODEX_HOME = join(tmpdir(), "memchor-tests-no-codex-home");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: { CLAUDE_CONFIG_DIR, CODEX_HOME, ...(PATH === undefined ? {} : { PATH }) },
    // Storage tests open real SQLite files and spawn `git` and server processes; give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
