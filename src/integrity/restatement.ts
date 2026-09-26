/**
 * Verbatim restatement: the one text-based lineage signal Memchor uses. A text restates a
 * record when it contains the record's whole body, or one of its sentences of at least
 * {@link MIN_RESTATED_CHARS} characters, ignoring case and whitespace. Paraphrases are never
 * matched: they cannot be told apart from new observations without guessing.
 *
 * Used by the importer (an agent message repeating echoed memory is `derived_from` it) and by
 * lifecycle changes (a checkpoint that repeats a corrected claim without citing it is quarantined).
 */

/**
 * Shortest normalised text that counts as a restatement. A shorter sentence ("Tests pass.",
 * "Done.") recurs by itself, so containing it says nothing about copying.
 */
export const MIN_RESTATED_CHARS = 40;

export function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** The texts whose verbatim appearance marks a copy of a record: its whole body and each long-enough sentence. */
export function restatable(body: string): string[] {
  const pieces = [body, ...body.split(/\n+|(?<=[.!?])\s+/u)].map(normalizeForEcho).filter((piece) => piece.length >= MIN_RESTATED_CHARS);
  return [...new Set(pieces)];
}

/** Whether `text` contains one of `pieces` (from {@link restatable}). */
export function restates(text: string, pieces: readonly string[]): boolean {
  if (pieces.length === 0) return false;
  const said = normalizeForEcho(text);
  return pieces.some((piece) => said.includes(piece));
}
