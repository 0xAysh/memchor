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
  seqMax: number;
  offset: number;
}

/**
 * Seals continuation state with an HMAC keyed by a per-workspace secret, so a token
 * cannot be forged, edited, or replayed in another workspace/workstream.
 */
export function sealContinuation(secret: Buffer, state: ContinuationState): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ws: state.workspaceId, wst: state.workstreamId, q: state.query, k: state.kinds, s: state.seqMax, o: state.offset }),
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
    s: number;
    o: number;
  };
  if (state.v !== 1) throw invalid("unsupported version");
  if (state.ws !== scope.workspaceId || state.wst !== scope.workstreamId) throw invalid("issued for another scope");
  return { workspaceId: state.ws, workstreamId: state.wst, query: state.q, kinds: state.k, seqMax: state.s, offset: state.o };
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
  budgetExhausted: boolean;
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
  let budgetExhausted = false;
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
    budgetExhausted = true;
    break;
  }
  return { checkpoint: packedCheckpoint, items, consumed, usedBytes, oversized, budgetExhausted };
}

export function usage(usedBytes: number): { usedBytes: number; usedTokens: number } {
  return { usedBytes, usedTokens: estimateTokens(usedBytes) };
}
