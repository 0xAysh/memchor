import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { touchesSensitivePath } from "../import/privacy.js";
import type { ExternalRef, Freshness } from "../schemas.js";

/**
 * Applicability of the external references a memory rests on (PRD §11). The repository
 * is the source of truth; memory is only knowledge *about* it. This module answers one
 * question for the records a recall selected: "is what this record saw still what is
 * there?", and hides Git and the filesystem behind two calls:
 *
 * - {@link captureObservations} runs when an agent writes a record or checkpoint: for
 *   each local code reference it notes the worktree's commit, whether the file was dirty,
 *   and a bounded SHA-256 of the file (never the content itself).
 * - {@link checkFreshness} runs at recall/read time for the selected records only, and
 *   labels every reference current / stale / unknown with a reason.
 *
 * Why these signals, and how much each is trusted:
 * - **The file hash is authoritative.** Equal bytes mean the observation still describes
 *   the file; different bytes mean it may not. The whole file is hashed rather than the
 *   cited line range, because line numbers shift with any edit above them and a range
 *   hash would call moved-but-identical code stale or, worse, changed code current.
 *   A whole-file change is a conservative "read it again", which is the safe error.
 * - **Commit + clean state is a shortcut, never a verdict on its own.** When the file was
 *   clean at commit C and is still clean with HEAD at C, Git guarantees the same bytes,
 *   so the file need not be read. This also covers files too large to hash. A dirty or
 *   untracked file, a moved HEAD, or unknown Git state always falls back to the hash.
 * - **Repository identity is physical.** Each workspace (repository) has its own database,
 *   so every stored reference belongs to this repository. A path that resolves outside
 *   the current worktree (another repository, another worktree, a symlink escaping it) is
 *   never read: it is `unknown` / `outside_worktree`.
 * - **Imported transcript references were never fingerprinted.** Hashing the file at
 *   import time would certify whatever version exists *then*, not the one the transcript
 *   saw, so they stay `unknown` / `transcript_reference` and the agent reads live code.
 * - **Documents in the worktree are files.** A `document` reference whose path resolves inside
 *   the worktree (`docs/design.md`) is fingerprinted and checked exactly like code.
 * - **Remote references are historical.** Issues, PRs, URLs and documents behind a URL can
 *   change without any local trace, and Memchor makes no network call, so they are `unknown` /
 *   `remote_unverified` until the agent checks them with its own tools.
 * - **A test result applies to the state it ran against.** A record's `testRun` is stamped with
 *   HEAD and a fingerprint of the working tree (see {@link worktreeFingerprint}); it is current
 *   only while both are unchanged. A run the agent merely reported (no cited tool output that
 *   Memchor captured from the transcript) is an assertion and is never current.
 *
 * Work is bounded: at most {@link FRESHNESS_LIMITS.refsPerCheck} references and
 * {@link FRESHNESS_LIMITS.totalBytes} hashed bytes per call, files over
 * {@link FRESHNESS_LIMITS.fileBytes} are never read, results are cached per call, and Git
 * runs at most twice per call (one path-limited `git status`, one `cat-file` only when a
 * caller-supplied commit must be checked), plus one working-tree `git status` only when a
 * selected record carries a test run. There is no repository-wide scan otherwise.
 */

export const FRESHNESS_LIMITS = {
  refsPerCheck: 64,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const;

export const FRESHNESS_REASONS = [
  /** current: the file's bytes (or its clean state at the observed commit) are unchanged. */
  "unchanged",
  /** stale: the file's bytes differ from what was observed. */
  "changed",
  /** stale: the observed file no longer exists. */
  "missing",
  /** unknown: nothing was fingerprinted when this reference was stored. */
  "not_observed",
  /** unknown: a file a transcript read or edited; its content then was never fingerprinted. */
  "transcript_reference",
  /** unknown: the path resolves outside this worktree (another repository or worktree). */
  "outside_worktree",
  /** unknown: the caller-supplied commit does not exist in this repository. */
  "unknown_commit",
  /** unknown: the file is larger than Memchor hashes and its Git state changed. */
  "too_large",
  /** unknown: the path exists but could not be read as a regular file. */
  "unreadable",
  /** unknown: this recall's validation budget was spent on higher-ranked references. */
  "check_limit",
  /** unknown: issue/PR/URL/document state is historical until verified with the agent's own tools. */
  "remote_unverified",
  /** unknown: an `other` reference Memchor has no way to check. */
  "not_checkable",
] as const;
export type FreshnessReason = (typeof FRESHNESS_REASONS)[number];

export const TEST_RUN_REASONS = [
  /** current: HEAD and the working tree are what the run saw. */
  "same_state",
  /** stale: HEAD moved or the working tree changed since the run. */
  "other_state",
  /** unknown: the working tree could not be fingerprinted then or now (too large, not Git). */
  "not_fingerprinted",
] as const;
export type TestRunReason = (typeof TEST_RUN_REASONS)[number];

/** A test run as stored in a record's applicability: what ran, and the state it ran against. */
export interface StoredTestRun {
  command: string;
  outcome: "passed" | "failed";
  exitCode?: number | undefined;
  /** HEAD when the run was recorded. */
  commit: string | null;
  /** {@link worktreeFingerprint} when the run was recorded. */
  worktree: string | null;
  /** `captured`: the record cites tool output Memchor imported from the host's transcript; `asserted`: the agent's word only. */
  evidence: "captured" | "asserted";
}

/** A test run as presented: whether it still applies to the repository as it is now. */
export type TestRunView = Omit<StoredTestRun, "worktree"> & { applies: Freshness; reason: TestRunReason };

/** A reference as stored: the caller's pointer plus what Memchor observed at write time. */
export interface StoredRef extends ExternalRef {
  /** Memchor-captured: the file had uncommitted or untracked changes when observed. */
  dirty?: boolean;
}

/** A reference as presented: the pointer, when it was observed, and its freshness now. */
export type CheckedRef = Omit<ExternalRef, "observedHash"> & {
  freshness: Freshness;
  reason: FreshnessReason;
};

export interface RecordFreshness {
  /** Worst of the references and the test run (stale > unknown > current); `unknown` when there are none. */
  freshness: Freshness;
  externalRefs: CheckedRef[];
  testRun: TestRunView | null;
  /** What the agent must do before relying on the record; null when every reference is current or there are none. */
  warning: string | null;
}

export interface FreshnessSubject {
  recordId: string;
  refs: readonly StoredRef[];
  /** Imported from a transcript: its code references were never fingerprinted. */
  imported: boolean;
  testRun?: StoredTestRun | undefined;
}

/** Kept short: every stale or unknown item in a pack carries one, and they share the budget with bodies. */
const FRESHNESS_WARNINGS = {
  stale: "Stale: a referenced file changed or is gone. Read the current file before relying on this.",
  unverified: "Unverified: a referenced file may have changed. Read the current file before relying on this.",
  remote: "Historical: issue/PR/URL/document state is as observed then; verify it with your own tools.",
  asserted: "Asserted: the agent reported this test run; Memchor did not capture its output. Rerun the tests before relying on it.",
  testStale: "The tests ran against another commit or working tree; rerun them before relying on this.",
  testUnknown: "The working tree could not be fingerprinted, so this test run may not apply; rerun the tests before relying on it.",
} as const;

const HASH = /^sha256:[0-9a-f]{64}$/;
const REMOTE_KINDS: ReadonlySet<string> = new Set(["issue", "pr", "url", "document"]);
/** A locator with a scheme (`https:`, `file:`) is not a worktree path. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/** Code, and documents that name a path rather than a URL: files Memchor can fingerprint in the worktree. */
function isLocalFile(ref: ExternalRef): boolean {
  return ref.kind === "code" || (ref.kind === "document" && !URL_LIKE.test(ref.path ?? ref.locator));
}
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/**
 * Adds Memchor's own observation to each local code reference the caller did not
 * describe: commit, dirty flag and a bounded content hash, stamped `observedAt` now.
 * A reference the caller pinned (`commit` or `observedHash` given) is kept as supplied,
 * since it may describe a version other than the one on disk. Paths outside the worktree,
 * missing files and sensitive paths (dotenv files, keys) get no fingerprint.
 */
export function captureObservations(worktree: string, refs: readonly ExternalRef[]): StoredRef[] {
  const targets = refs.map((ref) =>
    isLocalFile(ref) && ref.commit === undefined && ref.observedHash === undefined ? worktreePath(worktree, ref.path ?? ref.locator) : null,
  );
  const paths = targets.filter((path): path is string => path !== null && !touchesSensitivePath([path]));
  if (paths.length === 0) return [...refs];
  const state = gitState(worktree, paths);
  const observedAt = new Date().toISOString();
  let budget: number = FRESHNESS_LIMITS.totalBytes;
  return refs.map((ref, index) => {
    const path = targets[index];
    if (path === null || path === undefined || !paths.includes(path)) return ref;
    const content = hashFile(join(worktree, path), Math.min(FRESHNESS_LIMITS.fileBytes, budget));
    if (content.kind === "missing" || content.kind === "unreadable") return ref;
    const captured: StoredRef = { ...ref, observedAt: ref.observedAt ?? observedAt };
    if (content.kind === "hashed") {
      budget -= content.bytes;
      captured.observedHash = content.hash;
    }
    if (state !== null && state.head !== null) {
      captured.commit = state.head;
      captured.dirty = isDirty(state, path);
    }
    return captured.observedHash === undefined && captured.commit === undefined ? ref : captured;
  });
}

/**
 * Labels the references of the given records (the ones a recall selected, in rank
 * order, so the budget goes to the most relevant first). Never throws for Git or
 * filesystem trouble: whatever cannot be checked is `unknown` with a reason.
 */
export function checkFreshness(worktree: string, subjects: readonly FreshnessSubject[]): Map<string, RecordFreshness> {
  const checker = new Checker(worktree, subjects);
  return new Map(subjects.map((subject) => [subject.recordId, checker.record(subject)]));
}

/**
 * A presentation never larger than what {@link checkFreshness} will produce for these
 * references: remote and `other` references get their real (I/O-free) labels, code
 * references the shortest possible ones and no warning. Packing selects records with
 * it before validating, so only records a budget can hold are ever checked, and the
 * real annotations can only shrink the selection, never add an unchecked record.
 */
export function freshnessFloor(refs: readonly StoredRef[], testRun?: StoredTestRun): RecordFreshness {
  const externalRefs = refs.map((ref): CheckedRef => {
    if (isLocalFile(ref)) return { ...present(ref), freshness: "stale", reason: "changed" };
    return { ...present(ref), freshness: "unknown", reason: REMOTE_KINDS.has(ref.kind) ? "remote_unverified" : "not_checkable" };
  });
  return {
    freshness: "stale",
    externalRefs,
    // The shortest real label: "stale"/"other_state" (current and unknown labels are longer).
    testRun: testRun === undefined ? null : { ...presentTestRun(testRun), applies: "stale", reason: "other_state" },
    warning: externalRefs.some((ref) => !isLocalFile(ref)) ? FRESHNESS_WARNINGS.remote : null,
  };
}

/** The worktree fingerprint is Memchor's bookkeeping, not something an agent can use. */
function presentTestRun(run: StoredTestRun): Omit<StoredTestRun, "worktree"> {
  return { command: run.command, outcome: run.outcome, ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }), commit: run.commit, evidence: run.evidence };
}

class Checker {
  private readonly worktree: string;
  private readonly hashes = new Map<string, FileHash>();
  private readonly state: GitState | null;
  private readonly knownCommits: ReadonlySet<string>;
  private refsLeft: number = FRESHNESS_LIMITS.refsPerCheck;
  private bytesLeft: number = FRESHNESS_LIMITS.totalBytes;

  constructor(worktree: string, subjects: readonly FreshnessSubject[]) {
    this.worktree = worktree;
    // Resolve every checkable path first so Git runs once for all of them.
    const paths = new Set<string>();
    const pinned = new Set<string>();
    let budget: number = FRESHNESS_LIMITS.refsPerCheck;
    for (const subject of subjects) {
      for (const ref of subject.refs) {
        if (!isLocalFile(ref) || budget-- <= 0) continue;
        const path = worktreePath(worktree, ref.path ?? ref.locator);
        if (path !== null) paths.add(path);
        if (ref.commit !== undefined && ref.observedHash === undefined && ref.dirty === undefined) pinned.add(ref.commit);
      }
    }
    this.state = paths.size === 0 ? null : gitState(worktree, [...paths]);
    this.knownCommits = pinned.size === 0 ? new Set() : existingCommits(worktree, [...pinned]);
  }

  record(subject: FreshnessSubject): RecordFreshness {
    const externalRefs = subject.refs.map((ref) => {
      const [freshness, reason] = this.ref(ref, subject.imported);
      return { ...present(ref), freshness, reason };
    });
    const testRun = subject.testRun === undefined ? null : this.testRun(subject.testRun);
    // An asserted run counts as unknown whatever the state: the agent's word is not an observation.
    const testFreshness: Freshness | null = testRun === null ? null : testRun.evidence === "asserted" && testRun.applies !== "stale" ? "unknown" : testRun.applies;
    const all = [...externalRefs.map((r) => r.freshness), ...(testFreshness === null ? [] : [testFreshness])];
    const worst: Freshness = all.includes("stale") ? "stale" : all.length === 0 || all.includes("unknown") ? "unknown" : "current";
    const warnings: string[] = [];
    if (externalRefs.some((r) => r.freshness === "stale")) warnings.push(FRESHNESS_WARNINGS.stale);
    if (externalRefs.some((r) => isLocalFile(r) && r.freshness === "unknown")) warnings.push(FRESHNESS_WARNINGS.unverified);
    if (externalRefs.some((r) => !isLocalFile(r))) warnings.push(FRESHNESS_WARNINGS.remote);
    if (testRun?.evidence === "asserted") warnings.push(FRESHNESS_WARNINGS.asserted);
    else if (testRun?.applies === "stale") warnings.push(FRESHNESS_WARNINGS.testStale);
    else if (testRun?.applies === "unknown") warnings.push(FRESHNESS_WARNINGS.testUnknown);
    return { freshness: worst, externalRefs, testRun, warning: warnings.length === 0 ? null : warnings.join(" ") };
  }

  private current: { commit: string | null; worktree: string | null } | undefined;

  private testRun(run: StoredTestRun): TestRunView {
    this.current ??= worktreeFingerprint(this.worktree);
    const view = presentTestRun(run);
    if (run.worktree === null || run.commit === null || this.current.worktree === null || this.current.commit === null) return { ...view, applies: "unknown", reason: "not_fingerprinted" };
    return run.commit === this.current.commit && run.worktree === this.current.worktree
      ? { ...view, applies: "current", reason: "same_state" }
      : { ...view, applies: "stale", reason: "other_state" };
  }

  private ref(ref: StoredRef, imported: boolean): [Freshness, FreshnessReason] {
    if (!isLocalFile(ref)) return ["unknown", REMOTE_KINDS.has(ref.kind) ? "remote_unverified" : "not_checkable"];
    if (this.refsLeft-- <= 0) return ["unknown", "check_limit"];
    const path = worktreePath(this.worktree, ref.path ?? ref.locator);
    if (path === null) return ["unknown", "outside_worktree"];

    const captured = ref.dirty !== undefined;
    const hashed = ref.observedHash !== undefined && HASH.test(ref.observedHash);
    const observed = captured || hashed;
    const unobserved = (): [Freshness, FreshnessReason] => {
      if (imported) return ["unknown", "transcript_reference"];
      if (ref.commit !== undefined && !this.knownCommits.has(ref.commit)) return ["unknown", "unknown_commit"];
      return ["unknown", "not_observed"];
    };

    const file = this.hash(path, 0);
    if (file.kind === "missing") return observed ? ["stale", "missing"] : unobserved();
    if (!observed) return unobserved();
    // Same commit, clean then and clean now: Git guarantees the same bytes.
    if (captured && ref.dirty === false && this.state !== null && this.state.head === ref.commit && !isDirty(this.state, path)) {
      return ["current", "unchanged"];
    }
    // Observed without a hash (too large, or over the capture budget) and the shortcut failed.
    if (!hashed) return file.kind === "too_large" && file.size > FRESHNESS_LIMITS.fileBytes ? ["unknown", "too_large"] : ["unknown", "not_observed"];
    const content = this.hash(path, Math.min(FRESHNESS_LIMITS.fileBytes, this.bytesLeft));
    switch (content.kind) {
      case "hashed":
        return content.hash === ref.observedHash ? ["current", "unchanged"] : ["stale", "changed"];
      case "too_large":
        return this.bytesLeft < FRESHNESS_LIMITS.fileBytes && content.size <= FRESHNESS_LIMITS.fileBytes ? ["unknown", "check_limit"] : ["unknown", "too_large"];
      case "missing":
        return ["stale", "missing"];
      case "unreadable":
        return ["unknown", "unreadable"];
    }
  }

  /** Cached per path; `maxBytes` 0 only stats the file. */
  private hash(path: string, maxBytes: number): FileHash {
    const cached = this.hashes.get(path);
    if (cached !== undefined && (cached.kind !== "too_large" || cached.size > maxBytes)) return cached;
    const result = hashFile(join(this.worktree, path), maxBytes);
    if (result.kind === "hashed") this.bytesLeft -= result.bytes;
    this.hashes.set(path, result);
    return result;
  }
}

function present(ref: StoredRef): Omit<CheckedRef, "freshness" | "reason"> {
  // The content hash and dirty flag are Memchor's bookkeeping, not something an agent can use.
  const pointer: StoredRef = { ...ref };
  delete pointer.observedHash;
  delete pointer.dirty;
  return pointer;
}

type FileHash =
  | { kind: "hashed"; hash: string; bytes: number }
  | { kind: "too_large"; size: number }
  | { kind: "missing" }
  | { kind: "unreadable" };

/** SHA-256 of a regular file of at most `maxBytes`, read through one descriptor (no TOCTOU between size and bytes). */
function hashFile(absolute: string, maxBytes: number): FileHash {
  let fd: number;
  try {
    // Non-blocking, so a named pipe or device in the worktree cannot hang recall on open.
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "unreadable" };
    if (stat.size > maxBytes) return { kind: "too_large", size: stat.size };
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    // The file grew past its stat while being read: report the new size, never a partial hash.
    if (read > stat.size) return { kind: "too_large", size: read };
    return { kind: "hashed", hash: `sha256:${createHash("sha256").update(buffer.subarray(0, read)).digest("hex")}`, bytes: read };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The worktree-relative path a reference points at, or null when it resolves outside the
 * worktree. Symlinks are resolved (for the longest existing prefix), so a link that
 * escapes the worktree is outside it; `..` segments cannot climb out either.
 */
function worktreePath(worktree: string, pointer: string): string | null {
  const absolute = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
  const rel = relative(worktree, realPrefix(absolute));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  // Git's own directory is not worktree content.
  if (segments[0] === ".git") return null;
  return segments.join("/");
}

function realPrefix(absolute: string): string {
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

interface GitState {
  head: string | null;
  /** Worktree-relative paths (directories end in "/") Git reports as changed, untracked or ignored. */
  unclean: Set<string>;
}

function isDirty(state: GitState, path: string): boolean {
  if (state.unclean.has(path)) return true;
  // An ignored or untracked directory is reported once, as "dir/".
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (state.unclean.has(path.slice(0, slash + 1))) return true;
  }
  return false;
}

/**
 * HEAD and the unclean subset of `paths`, from one path-limited `git status` (Git
 * stats only these paths). Ignored files count as unclean: Git does not track them, so
 * "clean at commit C" would promise nothing about their bytes. Null when Git fails,
 * which disables the commit shortcut (the hash still decides).
 */
function gitState(worktree: string, paths: readonly string[]): GitState | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignored=matching", "--", ...paths],
      { cwd: worktree, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  const state: GitState = { head: null, unclean: new Set() };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.startsWith("# branch.oid ")) {
      const oid = field.slice("# branch.oid ".length);
      state.head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
    } else if (field.startsWith("1 ")) {
      state.unclean.add(field.split(" ").slice(8).join(" "));
    } else if (field.startsWith("2 ")) {
      state.unclean.add(field.split(" ").slice(9).join(" "));
      state.unclean.add(fields[++i] ?? ""); // the rename's original path
    } else if (field.startsWith("u ")) {
      state.unclean.add(field.split(" ").slice(10).join(" "));
    } else if (field.startsWith("? ") || field.startsWith("! ")) {
      state.unclean.add(field.slice(2));
    }
  }
  return state;
}

/**
 * HEAD and a fingerprint of the working tree: "clean", or the SHA-256 of every changed or
 * untracked path (ignored files excluded) with the hash of its current bytes. Bounded like
 * freshness checks: a changed file over 1 MiB, or more than 8 MiB of changes, or Git failing,
 * gives a null fingerprint (a test run then cannot be said to apply). Nothing is written.
 */
export function worktreeFingerprint(worktree: string): { commit: string | null; worktree: string | null } {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignored=no"], {
      cwd: worktree,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return { commit: null, worktree: null };
  }
  const fields = out.split("\0");
  const head = fields.find((field) => field.startsWith("# branch.oid "))?.slice("# branch.oid ".length) ?? null;
  const commit = head !== null && /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  // Each entry and the path whose bytes it names (porcelain v2; a rename's original path is the next field).
  const entries: { line: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.startsWith("1 ")) entries.push({ line: field, path: field.split(" ").slice(8).join(" ") });
    else if (field.startsWith("2 ")) entries.push({ line: `${field}\0${fields[++i] ?? ""}`, path: field.split(" ").slice(9).join(" ") });
    else if (field.startsWith("u ")) entries.push({ line: field, path: field.split(" ").slice(10).join(" ") });
    else if (field.startsWith("? ")) entries.push({ line: field, path: field.slice(2) });
  }
  if (entries.length === 0) return { commit, worktree: "clean" };
  entries.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  const digest = createHash("sha256");
  let budget: number = FRESHNESS_LIMITS.totalBytes;
  for (const { line, path } of entries) {
    digest.update(line).update("\0");
    const content = hashFile(join(worktree, path), Math.min(FRESHNESS_LIMITS.fileBytes, budget));
    if (content.kind === "too_large") return { commit, worktree: null };
    if (content.kind === "hashed") budget -= content.bytes;
    digest.update(content.kind === "hashed" ? content.hash : content.kind).update("\0");
  }
  return { commit, worktree: `sha256:${digest.digest("hex")}` };
}

/** Which of the given commit ids name a commit in this repository (one `cat-file` for all). */
function existingCommits(worktree: string, commits: readonly string[]): Set<string> {
  const valid = commits.filter((commit) => /^[0-9a-f]{4,64}$/i.test(commit));
  if (valid.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["cat-file", "--batch-check=%(objecttype)"], {
      cwd: worktree,
      env: GIT_ENV,
      encoding: "utf8",
      input: valid.map((commit) => `${commit}^{commit}\n`).join(""),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = out.split("\n");
    return new Set(valid.filter((_commit, index) => lines[index] === "commit"));
  } catch {
    return new Set();
  }
}
