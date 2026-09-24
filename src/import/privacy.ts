/**
 * What an imported passage may contain. Host-neutral: applied by the importer to every
 * normalized event, whatever host wrote it.
 *
 * Privacy decisions (PRD §8.3, §14):
 * - Credentials are replaced with `[redacted:<kind>]` before anything is stored. Detection
 *   is pattern-based (well-known token formats and `key = value` assignments of secret-named
 *   keys), so it is best-effort: an unrecognised secret format can get through.
 * - Output of a tool that touched a sensitive path (dotenv files, private keys, credential
 *   stores) is withheld entirely; only the call's summary is kept.
 * - Passages are bounded. A longer text keeps its head and tail with an explicit
 *   `[… N bytes omitted by Memchor …]` marker in between, so nothing is truncated silently.
 */

export const PASSAGE_LIMITS = {
  /** A user or assistant message. */
  messageBytes: 4_000,
  /** A summary the host wrote (compaction, away summary). */
  summaryBytes: 8_000,
  /** A tool's output: enough to see what happened, never a dump. */
  toolOutputBytes: 1_500,
  /** One line describing a tool call. */
  callSummaryBytes: 500,
} as const;

const SECRET_PATTERNS: readonly [kind: string, pattern: RegExp][] = [
  ["private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["api_key", /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["url_credentials", /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi],
];
/** `password=…`, `API_KEY: "…"`, `client_secret = …`: keep the key, redact the value. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|credentials?)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\3/gi;

const SENSITIVE_PATH = /(?:^|[\s/"'=])(?:\.env(?:\.[\w-]+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx|keystore)|credentials(?:\.json)?|\.aws\/credentials|\.ssh\/[\w.-]+|secrets?\.(?:ya?ml|json|toml))(?=$|[\s"'`;|&)])/i;

export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const [kind, pattern] of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions++;
      return `[redacted:${kind}]`;
    });
  }
  out = out.replace(SECRET_ASSIGNMENT, (match: string, key: string, sep: string, quote: string, value: string) => {
    if (value.startsWith("[redacted:")) return match;
    redactions++;
    return `${key}${sep}${quote}[redacted:secret]${quote}`;
  });
  return { text: out, redactions };
}

/** Whether a tool call's summary or paths name a file whose content must never be stored. */
export function touchesSensitivePath(texts: readonly string[]): boolean {
  return texts.some((text) => SENSITIVE_PATH.test(text));
}

/** Head and tail of `text` within `maxBytes` UTF-8 bytes, with an explicit omission marker. */
export function boundPassage(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, omittedBytes: 0 };
  const headBytes = Math.floor(maxBytes * 0.75);
  const tailBytes = maxBytes - headBytes;
  const head = prefixWithin(text, headBytes);
  const tail = suffixWithin(text, tailBytes);
  const omitted = total - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return { text: `${head}\n[… ${omitted.toLocaleString("en-US")} bytes omitted by Memchor …]\n${tail}`, omittedBytes: omitted };
}

function prefixWithin(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function suffixWithin(text: string, maxBytes: number): string {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    // Step back one code point (two code units for a surrogate pair).
    let from = start - 1;
    if (isLowSurrogate(text.charCodeAt(from)) && from > 0 && isHighSurrogate(text.charCodeAt(from - 1))) from--;
    const size = Buffer.byteLength(text.slice(from, start), "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = from;
  }
  return text.slice(start);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
