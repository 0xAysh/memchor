import { closeSync, type Dirent, openSync, readdirSync, readSync } from "node:fs";

/**
 * Line-oriented reading of host JSONL transcripts, shared by the adapters. Byte offsets are
 * the importer's cursor positions, so lines are located by bytes, never by decoded length.
 */

const READ_CHUNK = 1 << 20;
/** A single entry larger than this (e.g. a pasted multi-megabyte image) is skipped unparsed. */
export const MAX_LINE_BYTES = 32 << 20;

export interface Line {
  start: number;
  end: number;
  /** null when the line exceeded MAX_LINE_BYTES and was skipped unread. */
  text: string | null;
}

/**
 * Complete, newline-terminated lines from `from` until at least `maxBytes` are consumed
 * (always at least one line when one is complete). The unterminated tail of a file that is
 * still being written is never returned, so it is read again once finished.
 */
export function readLines(path: string, from: number, maxBytes: number): Line[] {
  const lines: Line[] = [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return lines;
  }
  try {
    const buffer = Buffer.alloc(Math.min(READ_CHUNK, Math.max(maxBytes, 4096)));
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    let lineStart = from;
    let position = from;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, position);
      if (n === 0) break;
      let cursor = 0;
      while (cursor < n) {
        const newline = buffer.indexOf(10, cursor);
        const stop = newline === -1 || newline >= n ? n : newline;
        if (!skipping) {
          pending.push(Buffer.from(buffer.subarray(cursor, stop)));
          pendingBytes += stop - cursor;
          if (pendingBytes > MAX_LINE_BYTES) {
            skipping = true;
            pending = [];
          }
        }
        if (stop === n) {
          cursor = n;
          break;
        }
        const end = position + stop + 1;
        lines.push({ start: lineStart, end, text: skipping ? null : Buffer.concat(pending).toString("utf8") });
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = end;
        cursor = stop + 1;
        if (end - from >= maxBytes) return lines;
      }
      position += n;
    }
    return lines;
  } finally {
    closeSync(fd);
  }
}

/** A parsed JSONL entry (or nested object); adapters read only the fields they document. */
export type JsonObject = Record<string, unknown>;

/** The value as an object, or an empty one when it is missing or not an object. */
export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Any JSON value, or null when the text is not JSON. */
export function parseAny(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A JSON object, or null when the text is not JSON or not an object (a damaged or foreign line). */
export function parseObject(text: string): JsonObject | null {
  const value = parseAny(text);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** A directory's entries, or none when it is missing or unreadable (a host that never ran, a retention sweep). */
export function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
