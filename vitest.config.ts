import { execFileSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
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

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    ...(PATH === undefined ? {} : { env: { PATH } }),
    // Storage tests open real SQLite files and spawn `git` and server processes; give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
