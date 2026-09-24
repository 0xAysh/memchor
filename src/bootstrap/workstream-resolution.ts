import { randomBytes, randomUUID } from "node:crypto";
import { MemchorError } from "../errors.js";
import { type Db, writeTransaction } from "../storage/database.js";
import type { WorkspaceLocation } from "./workspace-resolution.js";

export interface BoundScope {
  workspaceId: string;
  workspaceLabel: string;
  workstreamId: string;
  workstreamLabel: string;
  branch: string;
  worktree: string;
  sessionId: string;
  host: string;
  /** Per-workspace key that authenticates recall continuation tokens. */
  continuationSecret: Buffer;
  createdWorkstream: boolean;
}

/**
 * Binds this process to exactly one workstream and opens a session (#18 subset of PRD §9.2):
 * an existing binding for this worktree wins, regardless of the current branch;
 * otherwise a new workstream is created for this worktree. The branch is only its
 * label — "a branch is evidence about a workstream, not the workstream itself" — so a
 * worktree never joins another worktree's workstream by name.
 *
 * Fails closed with `storage_unavailable` when the database belongs to a different
 * workspace or repository identity (e.g. a registry entry pointing at another
 * repository's database); nothing is written in that case.
 *
 * Runs in one IMMEDIATE transaction so two processes bootstrapping the same new
 * worktree concurrently produce one workstream and one binding, not two.
 */
export function bindScope(db: Db, location: WorkspaceLocation, host: string, hostSessionId: string | undefined): BoundScope {
  return writeTransaction(db, () => {
    const now = new Date().toISOString();
    const workspaces = db.prepare("SELECT id, label, repository_key, continuation_secret FROM workspaces").all() as {
      id: string;
      label: string;
      repository_key: string;
      continuation_secret: Buffer;
    }[];
    if (workspaces.length === 0) {
      const secret = randomBytes(32);
      db.prepare(
        "INSERT INTO workspaces (id, label, repository_key, root_commit, continuation_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(location.workspaceId, location.label, location.repositoryKey, location.rootCommit, secret, now);
      workspaces.push({ id: location.workspaceId, label: location.label, repository_key: location.repositoryKey, continuation_secret: secret });
    }
    const workspace = workspaces[0];
    if (workspaces.length !== 1 || workspace === undefined || workspace.id !== location.workspaceId || workspace.repository_key !== location.repositoryKey) {
      throw new MemchorError(
        "storage_unavailable",
        `The database at ${location.dbPath} belongs to a different repository or workspace; refusing to use it for ${location.worktree}.`,
        {
          details: {
            dbPath: location.dbPath,
            expected: { workspaceId: location.workspaceId, repositoryKey: location.repositoryKey },
            found: workspaces.map((w) => ({ workspaceId: w.id, repositoryKey: w.repository_key })),
          },
        },
      );
    }

    let createdWorkstream = false;
    let workstream = findBinding(db, location.worktree);
    if (workstream === null) {
      workstream = { id: `wst_${randomUUID().replaceAll("-", "")}`, label: location.branch };
      db.prepare("INSERT INTO workstreams (id, label, created_at) VALUES (?, ?, ?)").run(workstream.id, workstream.label, now);
      db.prepare("INSERT INTO worktree_bindings (worktree_path, workstream_id, bound_at) VALUES (?, ?, ?)").run(location.worktree, workstream.id, now);
      createdWorkstream = true;
    }

    const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
    db.prepare("INSERT INTO sessions (id, host, host_session_id, workstream_id, started_at) VALUES (?, ?, ?, ?, ?)").run(
      sessionId,
      host,
      hostSessionId ?? null,
      workstream.id,
      now,
    );

    return {
      workspaceId: location.workspaceId,
      workspaceLabel: workspace.label,
      workstreamId: workstream.id,
      workstreamLabel: workstream.label,
      branch: location.branch,
      worktree: location.worktree,
      sessionId,
      host,
      continuationSecret: workspace.continuation_secret,
      createdWorkstream,
    };
  });
}

/** The workstream bound to a worktree, or null. Read-only. */
export function findBinding(db: Db, worktree: string): { id: string; label: string } | null {
  const row = db
    .prepare("SELECT w.id, w.label FROM worktree_bindings b JOIN workstreams w ON w.id = b.workstream_id WHERE b.worktree_path = ?")
    .get(worktree) as { id: string; label: string } | undefined;
  return row ?? null;
}
