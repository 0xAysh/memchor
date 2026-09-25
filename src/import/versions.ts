import type { CompatibilityRow } from "./normalized-event.js";

/**
 * Host version ordering for compatibility tables. Hosts ship `X.Y.Z` releases and
 * `X.Y.Z-<pre>` pre-releases (Codex: `0.148.0-alpha.21`, `0.149.0-alpha.7.1`). Semver
 * precedence is used: a pre-release sorts below its release, and pre-release identifiers
 * compare numerically when numeric and lexically otherwise, so `alpha.21 < beta.1 < rc.1`.
 * Splitting on "." alone would read `0.148.0-beta.21` as equal to `0.148.0-alpha.21` and
 * admit a build nobody has checked. Anything that is not a version sorts below everything.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : -1) : 1;
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `version` falls in one of the table's [from, below) rows. */
export function inCompatibility(version: string, rows: readonly CompatibilityRow[]): boolean {
  return parse(version) !== null && rows.some((row) => compareVersions(version, row.from) >= 0 && compareVersions(version, row.below) < 0);
}

function parse(version: string): { core: number[]; pre: string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split(".") };
}
