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
 *
 * 1. an existing binding for this worktree wins, regardless of the current branch
 *    (a branch is a label, not an identity);
 * 2. otherwise an *active* workstream whose label equals the current branch is adopted
 *    (e.g. a re-created worktree for the same branch); two or more such candidates is
 *    `scope_ambiguous` — Memchor never picks one;
 * 3. otherwise a new workstream labelled with the branch is created.
 *
 * Runs in one IMMEDIATE transaction so two processes bootstrapping the same new
 * worktree concurrently produce one workstream and one binding, not two.
 */
export function bindScope(db: Db, location: WorkspaceLocation, host: string, hostSessionId: string | undefined): BoundScope {
  return writeTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id, label, repository_key, root_commit, continuation_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(location.workspaceId, location.label, location.repositoryKey, location.rootCommit, randomBytes(32), now);
    const workspace = db.prepare("SELECT label, continuation_secret FROM workspaces WHERE id = ?").get(location.workspaceId) as
      | { label: string; continuation_secret: Buffer }
      | undefined;
    if (workspace === undefined) {
      throw new MemchorError("storage_unavailable", "This workspace database belongs to a different workspace.", {
        details: { workspaceId: location.workspaceId },
      });
    }

    let createdWorkstream = false;
    let workstream = db
      .prepare(
        `SELECT w.id, w.label FROM worktree_bindings b JOIN workstreams w ON w.id = b.workstream_id
         WHERE b.worktree_path = ?`,
      )
      .get(location.worktree) as { id: string; label: string } | undefined;

    if (workstream === undefined) {
      const candidates = db
        .prepare("SELECT id, label FROM workstreams WHERE lifecycle = 'active' AND label = ? ORDER BY created_at, id")
        .all(location.branch) as { id: string; label: string }[];
      if (candidates.length > 1) {
        throw new MemchorError(
          "scope_ambiguous",
          `More than one active workstream is labelled "${location.branch}" and this worktree is not bound to any of them. Memchor will not guess.`,
          { details: { worktree: location.worktree, branch: location.branch, candidates } },
        );
      }
      workstream = candidates[0];
      if (workstream === undefined) {
        workstream = { id: `wst_${randomUUID().replaceAll("-", "")}`, label: location.branch };
        db.prepare("INSERT INTO workstreams (id, label, created_at) VALUES (?, ?, ?)").run(workstream.id, workstream.label, now);
        createdWorkstream = true;
      }
      db.prepare("INSERT INTO worktree_bindings (worktree_path, workstream_id, bound_at) VALUES (?, ?, ?)").run(
        location.worktree,
        workstream.id,
        now,
      );
    }

    const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
    db.prepare(
      "INSERT INTO sessions (id, host, host_session_id, workstream_id, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, host, hostSessionId ?? null, workstream.id, now);

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
