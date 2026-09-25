import { createHmac, timingSafeEqual } from "node:crypto";
import { MemchorError } from "../errors.js";
import { estimateTokens } from "../schemas.js";
import { clipToBytes } from "./search.js";

/**
 * Budgeted packing and continuation tokens for recall.
 *
 * Budget accounting: the budget covers the whole pack as the client receives it, the UTF-8
 * length of its JSON serialisation: scope, checkpoint, items, omissions, notice,
 * continuation and the budget object itself. `usedBytes` is that length. The envelope is
 * measured first (see {@link planPage}); entries fill what it leaves. A budget too small
 * for the envelope alone, or for the envelope with its bounded list of records too large to
 * return ({@link LISTED_OVERSIZED}), gets a pack with no entries that says so: the only pack
 * that can be larger than its budget, since scope (and an ambiguity question) is never cut.
 */

export const ITEM_EXCERPT_BYTES = 1_000;

/**
 * A continuation may take at most this fraction (1/n) of the budget. Tokens carry their
 * sequence (≤ 500 seqs, ~2.5 KB) and are paid for in the agent's context like any other
 * bytes, so a small budget carries a shorter sequence rather than a token bigger than its entries.
 */
const CONTINUATION_SHARE = 4;

export interface ContinuationState {
  workspaceId: string;
  workstreamId: string;
  query: string | null;
  kinds: string[] | null;
  /** The not-yet-returned part of the sequence frozen at page 1, as record seqs in rank order. */
  remaining: number[];
  /** Eligible matches the sequence does not carry (beyond the cap, or dropped to fit a budget); reported, never returned. */
  beyondCap: number;
}

/**
 * Seals continuation state with an HMAC keyed by a per-workspace secret, so a token
 * cannot be forged, edited, or replayed in another workspace/workstream. The token
 * carries the frozen remainder of the ranked sequence itself, so later pages neither
 * re-rank (bm25 statistics drift as others write) nor need server-side state. The
 * workspace and workstream are bound by the signature instead of being carried, which
 * keeps the token (part of every budget) short.
 */
export function sealContinuation(secret: Buffer, state: ContinuationState): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 3,
      q: state.query,
      k: state.kinds,
      r: state.remaining.map((seq) => seq.toString(36)).join(","),
      x: state.beyondCap,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, state, payload)}`;
}

/** Verifies and decodes a token for this scope; anything else (including another scope's token) is `invalid_input`. */
export function openContinuation(secret: Buffer, token: string, scope: { workspaceId: string; workstreamId: string }): ContinuationState {
  const invalid = (why: string): MemchorError =>
    new MemchorError("invalid_input", `The continuation is not valid here (${why}). Start a new recall without it.`, {
      details: { reason: "invalid_continuation" },
    });
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) throw invalid("malformed");
  const expected = Buffer.from(sign(secret, scope, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid("signature mismatch, or issued for another scope");
  const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    v: number;
    q: string | null;
    k: string[] | null;
    r: string;
    x: number;
  };
  if (state.v !== 3) throw invalid("unsupported version");
  return {
    workspaceId: scope.workspaceId,
    workstreamId: scope.workstreamId,
    query: state.q,
    kinds: state.k,
    remaining: state.r === "" ? [] : state.r.split(",").map((seq) => parseInt(seq, 36)),
    beyondCap: state.x,
  };
}

function sign(secret: Buffer, scope: { workspaceId: string; workstreamId: string }, payload: string): string {
  return createHmac("sha256", secret).update(`${scope.workspaceId}\u0000${scope.workstreamId}\u0000${payload}`).digest("base64url");
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

/**
 * A page reports at most this many records as too large for its budget (`exceeds_budget`,
 * listed by id), fewer when a small budget cannot also hold the continuation; the next
 * oversized record waits for the continuation's page. Bounding the list bounds the envelope,
 * so {@link planPage} can reserve it up front: an unbounded list grew with every record a
 * shrinking room pushed out, and starved pages whose bare envelope fitted.
 */
export const LISTED_OVERSIZED = 5;

/** Record ids are fixed-length (`rec_` + 32 hex), so this measures a listed id exactly. */
const ID_SHAPE = `rec_${"0".repeat(32)}`;

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
 * Entry bytes for one page. `room` leaves space for the page's continuation; `maxRoom` is
 * everything the envelope leaves. The entry that leads a page may use `maxRoom` (its
 * continuation then carries less), so no entry that fits beside the envelope is ever
 * reported as too large merely because a continuation was reserved.
 */
export interface Room {
  room: number;
  maxRoom: number;
  /** Most records this page reports as oversized (1…{@link LISTED_OVERSIZED}). */
  listed: number;
  /** Bytes that list adds to the envelope (see {@link packWithinBudget}'s fallback). */
  listing: number;
}

/**
 * Greedy packing in rank order. The checkpoint (if any) goes first. Packing stops at the
 * first item that does not fit, so the pack is always a prefix of the ranked sequence
 * and the continuation resumes exactly there. An entry too large for even an empty
 * page's whole room is skipped and reported by id instead of blocking the sequence, up to
 * `listed` per page.
 */
export function packPage<C, I>({ room, maxRoom, listed }: Room, checkpoint: Packable<C> | null, candidates: readonly Packable<I>[]): PackedPage<C, I> {
  let usedBytes = 0;
  const oversized: string[] = [];
  let packedCheckpoint: C | null = null;
  if (checkpoint !== null) {
    const fitted = fit(checkpoint, maxRoom);
    if (fitted === null) oversized.push(checkpoint.recordId);
    else {
      packedCheckpoint = fitted.entry;
      usedBytes += fitted.bytes;
    }
  }
  const items: I[] = [];
  let consumed = 0;
  for (const candidate of candidates) {
    const leadsPage = packedCheckpoint === null && items.length === 0;
    let fitted = fit(candidate, (leadsPage ? maxRoom : room) - usedBytes);
    const sourceBytes = Math.min(candidate.maxExcerptBytes, Buffer.byteLength(candidate.source, "utf8"));
    if (fitted !== null && !leadsPage && fitted.excerptBytes < Math.min(MIN_USEFUL_EXCERPT_BYTES, sourceBytes)) fitted = null;
    if (fitted !== null) {
      items.push(fitted.entry);
      usedBytes += fitted.bytes;
      consumed++;
      continue;
    }
    if (leadsPage || fit(candidate, maxRoom) === null) {
      if (oversized.length >= listed) break;
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

/** What {@link planPage} and {@link packWithinBudget} need from a whole result. */
export interface Envelope {
  continuation: string | null;
  budget: { usedBytes: number; usedTokens: number };
}

/**
 * Builds the whole result for a page: its continuation carries at most `carry` of the
 * sequence the page leaves (the rest is reported as not carried); `starved` marks a budget
 * too small for any entry. Must be pure: it is called repeatedly while measuring.
 */
export type Assemble<C, I, P extends Envelope> = (page: PackedPage<C, I>, carry: number, starved: boolean) => P;

export const EMPTY_PAGE: PackedPage<never, never> = { checkpoint: null, items: [], consumed: 0, usedBytes: 0, oversized: [] };

/**
 * Measures the envelope before any entry is packed: the result with no entries and no
 * continuation, the continuation the whole sequence would need (capped at the budget's
 * {@link CONTINUATION_SHARE}), and how many oversized ids fit beside that continuation (at
 * least one, so a page of oversized records still advances the sequence). Null when the
 * budget cannot hold even the bare envelope.
 */
export function planPage<C, I, P extends Envelope>(maxBytes: number, assemble: Assemble<C, I, P>, remainingAfter: (page: PackedPage<C, I>) => number): Room | null {
  const bytes = (oversized: number, carry: number): number =>
    measured(assemble({ ...EMPTY_PAGE, oversized: Array<string>(oversized).fill(ID_SHAPE) }, carry, false)).budget.usedBytes;
  const bare = bytes(0, 0);
  const maxRoom = maxBytes - bare;
  if (maxRoom <= 0) return null;
  const carry = carryWithin(maxBytes, assemble, EMPTY_PAGE, remainingAfter(EMPTY_PAGE));
  let listed = LISTED_OVERSIZED;
  while (listed > 1 && bytes(listed, carry) > maxBytes) listed--;
  return { room: Math.max(0, maxBytes - bytes(0, carry)), maxRoom, listed, listing: Math.max(0, bytes(listed, 0) - bare) };
}

/**
 * Packs the page and returns the whole result within `maxBytes`: entries in `room`, then a
 * continuation carrying as much of the rest as its share of the budget allows. What pushes
 * the result over (a leading entry's continuation, the notice, count digits, oversized ids)
 * shrinks the room and the page is packed again. Should that not settle, the page falls back to
 * what the plan can hold: the checkpoint or leading entry beside its bounded oversized list, and a
 * continuation cut to the bytes left. The result is starved (no entries, says so) only when the
 * budget cannot hold the envelope itself, or the envelope with that page's oversized ids.
 */
export function packWithinBudget<C, I, P extends Envelope>(
  maxBytes: number,
  plan: Room | null,
  checkpoint: Packable<C> | null,
  candidates: readonly Packable<I>[],
  assemble: Assemble<C, I, P>,
  remainingAfter: (page: PackedPage<C, I>) => number,
): P {
  let room = plan;
  for (let attempt = 0; room !== null && room.maxRoom > 0 && attempt < 8; attempt++) {
    const page = packPage(room, checkpoint, candidates);
    const result = measured(assemble(page, carryWithin(maxBytes, assemble, page, remainingAfter(page)), false));
    const over = result.budget.usedBytes - maxBytes;
    if (over <= 0) return result;
    room = { ...room, room: Math.max(0, room.room - over), maxRoom: room.maxRoom - over };
  }
  if (plan !== null) {
    const page = packPage({ ...plan, room: 0, maxRoom: plan.maxRoom - plan.listing }, checkpoint, candidates);
    const fits = (carry: number): P | null => {
      const result = measured(assemble(page, carry, false));
      return result.budget.usedBytes <= maxBytes ? result : null;
    };
    // Largest carry (within the continuation's share) whose whole result fits. `lo` only ever
    // holds 0 or a carry that fitted, and fits(0) is checked below.
    let lo = 0;
    let hi = carryWithin(maxBytes, assemble, page, remainingAfter(page));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid) !== null) lo = mid;
      else hi = mid - 1;
    }
    const result = fits(lo);
    if (result !== null) return result;
  }
  return measured(assemble(EMPTY_PAGE, 0, true));
}

/** The most of `remaining` a continuation can carry within the budget's share (0 = no continuation). */
function carryWithin<C, I, P extends Envelope>(maxBytes: number, assemble: Assemble<C, I, P>, page: PackedPage<C, I>, remaining: number): number {
  const share = Math.floor(maxBytes / CONTINUATION_SHARE);
  const fits = (carry: number): boolean => Buffer.byteLength(JSON.stringify(assemble(page, carry, false).continuation), "utf8") <= share;
  if (fits(remaining)) return remaining;
  let lo = 0;
  let hi = remaining - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Sets `usedBytes` to the length of the result's own serialisation, `budget` included.
 * The length depends on its own digits, so it is iterated to the fixed point (it grows
 * monotonically and settles within a step or two).
 */
function measured<P extends Envelope>(result: P): P {
  let current = result;
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    if (bytes === current.budget.usedBytes) return current;
    current = { ...current, budget: { ...current.budget, ...usage(bytes) } };
  }
  return current;
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
