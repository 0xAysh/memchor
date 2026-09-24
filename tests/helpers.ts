import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach } from "vitest";
import { MemchorError } from "../src/errors.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A fresh temporary directory, removed after the current test. */
export function tempDir(prefix = "memchor-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Registers a teardown callback (e.g. closing a Memory) for the current test. */
export function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Memchor Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Memchor Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git init` a repository with one commit on `branch`. */
export function initRepo(options: { branch?: string; commit?: boolean } = {}): string {
  const dir = tempDir("memchor-repo-");
  git(dir, "init", "--quiet", `--initial-branch=${options.branch ?? "main"}`);
  if (options.commit ?? true) {
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "--quiet", "-m", "initial");
  }
  return dir;
}

/** Every path under `root` (excluding `.git`) with its size and mtime, for "nothing was written" checks. */
export function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(full);
      } else {
        const st = statSync(full);
        out.push(`${relative(root, full)}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Runs `fn` and returns the MemchorError it throws; fails the test if it does not throw one. */
export function catchMemchorError(fn: () => unknown): MemchorError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemchorError) return error;
    throw error;
  }
  throw new Error("expected a MemchorError but the call succeeded");
}
