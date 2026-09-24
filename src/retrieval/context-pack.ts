import { createHmac, timingSafeEqual } from "node:crypto";
import { MemchorError } from "../errors.js";
import { estimateTokens } from "../schemas.js";
import { clipToBytes } from "./search.js";

/**
 * Budgeted packing and continuation tokens for recall.
 *
 * Budget accounting: every packed entry (the checkpoint and each item) is measured as
 * the UTF-8 length of its JSON serialisation; `usedBytes` is their sum and never exceeds
 * `maxBytes`. The fixed envelope (scope, notice, budget, continuation) is not counted.
 */

export const ITEM_EXCERPT_BYTES = 1_000;

export interface ContinuationState {
  workspaceId: string;
  workstreamId: string;
  query: string | null;
  kinds: string[] | null;
  /** The not-yet-returned part of the sequence frozen at page 1, as record seqs in rank order. */
  remaining: number[];
  /** Eligible matches beyond the sequence cap at page 1 (reported, never returned). */
  beyondCap: number;
}

/**
 * Seals continuation state with an HMAC keyed by a per-workspace secret, so a token
 * cannot be forged, edited, or replayed in another workspace/workstream. The token
 * carries the frozen remainder of the ranked sequence itself, so later pages neither
 * re-rank (bm25 statistics drift as others write) nor need server-side state.
 */
export function sealContinuation(secret: Buffer, state: ContinuationState): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      ws: state.workspaceId,
      wst: state.workstreamId,
      q: state.query,
      k: state.kinds,
      r: state.remaining.map((seq) => seq.toString(36)).join(","),
      x: state.beyondCap,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** Verifies and decodes a token for this scope; anything else is `invalid_input`. */
export function openContinuation(secret: Buffer, token: string, scope: { workspaceId: string; workstreamId: string }): ContinuationState {
  const invalid = (why: string): MemchorError =>
    new MemchorError("invalid_input", `The continuation is not valid here (${why}). Start a new recall without it.`, {
      details: { reason: "invalid_continuation" },
    });
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) throw invalid("malformed");
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid("signature mismatch");
  const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    v: number;
    ws: string;
    wst: string;
    q: string | null;
    k: string[] | null;
    r: string;
    x: number;
  };
  if (state.v !== 2) throw invalid("unsupported version");
  if (state.ws !== scope.workspaceId || state.wst !== scope.workstreamId) throw invalid("issued for another scope");
  return {
    workspaceId: state.ws,
    workstreamId: state.wst,
    query: state.q,
    kinds: state.k,
    remaining: state.r === "" ? [] : state.r.split(",").map((seq) => parseInt(seq, 36)),
    beyondCap: state.x,
  };
}

function sign(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export interface Budget {
  maxTokens: number;
  maxBytes: number;
}

/** An entry whose `excerpt` can be shortened to fit; `build` must be pure. */
export interface Packable<T> {
  recordId: string;
  source: string;
  maxExcerptBytes: number;
  build: (excerpt: string, truncated: boolean) => T;
}

export type FitResult<T> = { entry: T; bytes: number; excerptBytes: number } | null;

/** Below this, a clipped excerpt is noise; the item waits for the next page instead (unless it would lead a page). */
const MIN_USEFUL_EXCERPT_BYTES = 120;

/**
 * Largest excerpt (a prefix of `source`, at most `maxExcerptBytes`) whose entry fits in
 * `remaining` bytes; null when the entry does not fit even with an empty excerpt.
 */
export function fit<T>(packable: Packable<T>, remaining: number): FitResult<T> {
  const measure = (excerpt: string): { entry: T; bytes: number; excerptBytes: number } => {
    const entry = packable.build(excerpt, excerpt.length < packable.source.length);
    return { entry, bytes: Buffer.byteLength(JSON.stringify(entry), "utf8"), excerptBytes: Buffer.byteLength(excerpt, "utf8") };
  };
  const full = measure(clipToBytes(packable.source, packable.maxExcerptBytes));
  if (full.bytes <= remaining) return full;
  const empty = measure("");
  if (empty.bytes > remaining) return null;
  // Binary search on the excerpt's UTF-8 budget; JSON escaping makes size non-linear.
  let lo = 0;
  let hi = Math.min(packable.maxExcerptBytes, Buffer.byteLength(packable.source, "utf8"));
  let best = empty;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = measure(clipToBytes(packable.source, mid));
    if (candidate.bytes <= remaining) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export interface PackedPage<C, I> {
  checkpoint: C | null;
  items: I[];
  /** Candidates consumed from the sequence on this page (packed or skipped as oversized). */
  consumed: number;
  usedBytes: number;
  oversized: string[];
}

/**
 * Greedy packing in rank order. The checkpoint (if any) goes first. Packing stops at the
 * first item that does not fit, so the pack is always a prefix of the ranked sequence
 * and the continuation resumes exactly there. An entry too large for even an empty
 * page's whole budget is skipped and reported by id instead of blocking the sequence.
 */
export function packPage<C, I>(budget: Budget, checkpoint: Packable<C> | null, candidates: readonly Packable<I>[]): PackedPage<C, I> {
  let usedBytes = 0;
  const oversized: string[] = [];
  let packedCheckpoint: C | null = null;
  if (checkpoint !== null) {
    const fitted = fit(checkpoint, budget.maxBytes);
    if (fitted === null) oversized.push(checkpoint.recordId);
    else {
      packedCheckpoint = fitted.entry;
      usedBytes += fitted.bytes;
    }
  }
  const items: I[] = [];
  let consumed = 0;
  for (const candidate of candidates) {
    let fitted = fit(candidate, budget.maxBytes - usedBytes);
    const leadsPage = packedCheckpoint === null && items.length === 0;
    const sourceBytes = Math.min(candidate.maxExcerptBytes, Buffer.byteLength(candidate.source, "utf8"));
    if (fitted !== null && !leadsPage && fitted.excerptBytes < Math.min(MIN_USEFUL_EXCERPT_BYTES, sourceBytes)) fitted = null;
    if (fitted !== null) {
      items.push(fitted.entry);
      usedBytes += fitted.bytes;
      consumed++;
      continue;
    }
    if (leadsPage || fit(candidate, budget.maxBytes) === null) {
      oversized.push(candidate.recordId);
      consumed++;
      continue;
    }
    break;
  }
  return { checkpoint: packedCheckpoint, items, consumed, usedBytes, oversized };
}

export function usage(usedBytes: number): { usedBytes: number; usedTokens: number } {
  return { usedBytes, usedTokens: estimateTokens(usedBytes) };
}

/** Appended to an excerpt that was cut to fit, so a clipped body never reads as the whole record. */
export const CUT_MARKER = " [… cut by Memchor to fit the budget; memory_read this recordId for the rest]";

/** At most this many collapsed copies are listed on an item; `corroboration.records` counts them all. */
export const LISTED_COPIES = 5;

/**
 * Records that state one claim from one independent root, collapsed into one entry.
 *
 * A claim is the record body with whitespace normalised; two records share a root when
 * provenance says one repeats the other (see `independentRoots`). A group takes the rank
 * of its first-ranked record but is represented by its earliest one (`observedBefore`): a
 * restatement is always written after the record it cites, so the earliest is the original
 * statement, while a newer copy often ranks first on recency and would otherwise present
 * its own host, kind and attribution as the original's. Records with the same claim but
 * different roots are never folded together: each stays its own entry, and
 * `independentRoots` tells how many distinct observations back the claim.
 */
export interface ClaimGroup<R> {
  representative: R;
  /** Other records with the same claim and root, in rank order. */
  copies: R[];
  /** Distinct roots among the loaded records carrying this claim. */
  independentRoots: number;
  /** Loaded records carrying this claim, across all roots (copies included). */
  records: number;
}

export function groupClaims<R>(
  rows: readonly R[],
  claimOf: (row: R) => string,
  rootOf: (row: R) => string,
  observedBefore: (a: R, b: R) => boolean,
): ClaimGroup<R>[] {
  const byClaim = new Map<string, { roots: Set<string>; records: number }>();
  const byKey = new Map<string, ClaimGroup<R>>();
  const groups: ClaimGroup<R>[] = [];
  for (const row of rows) {
    const claim = claimOf(row);
    const root = rootOf(row);
    const stats = byClaim.get(claim) ?? { roots: new Set<string>(), records: 0 };
    stats.roots.add(root);
    stats.records++;
    byClaim.set(claim, stats);
    const key = `${root}\u0000${claim}`;
    const group = byKey.get(key);
    if (group === undefined) {
      const created: ClaimGroup<R> = { representative: row, copies: [], independentRoots: 0, records: 0 };
      byKey.set(key, created);
      groups.push(created);
    } else if (observedBefore(row, group.representative)) {
      group.copies.unshift(group.representative);
      group.representative = row;
    } else {
      group.copies.push(row);
    }
  }
  for (const group of groups) {
    const stats = byClaim.get(claimOf(group.representative));
    group.independentRoots = stats?.roots.size ?? 1;
    group.records = stats?.records ?? 1;
  }
  return groups;
}

/** The claim a body states, for grouping copies: whitespace-insensitive, otherwise exact. */
export function normalizeClaim(body: string): string {
  return body.trim().replace(/\s+/gu, " ");
}
