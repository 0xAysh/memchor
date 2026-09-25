import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolKind } from "./normalized-event.js";

/**
 * Recognises shell commands that only print files (`sed -n '40,87p' src/a.ts`, `nl -ba a.ts |
 * sed -n '1,40p'`, `cat -n a.ts 2>/dev/null | head -50`, …), so an adapter can class them like
 * the host's own file-read tool: the output is a file's content, which the importer keeps as a
 * reference only (PRD §8.3). Agents read code through the shell far more often than through a
 * read tool, so without this their file contents would be kept as tool-output passages.
 *
 * The parse is deliberately narrow and never evaluates anything. A command is a pure read only
 * when every part of it is understood: a reader from {@link READERS} with options from its
 * allow-list, reading files inside the event's working directory, `cd`, or an `echo`
 * separator, joined by `|`, `&&`, `;` or newlines, optionally inside one `bash|sh|zsh -c`
 * wrapper. What an `echo` prints goes with the file content (the importer stores the call as
 * its tool and first path, not the command), a price paid for recognising `echo '---'`
 * between reads. Anything else (an expansion, a substitution, a redirect other than `2>/dev/null` /
 * `2>&1`, `||`, a subshell, an unknown option, `sed -i`, a sed script that does more than print,
 * a search such as `grep`) makes the whole command "not a pure read", and the importer keeps its
 * output as a bounded passage, exactly as before. A wrong "not a read" costs nothing new; a
 * wrong "read" would only drop output, never keep file content.
 */

/**
 * What a value-taking option accepts: `count` is a number (optionally signed, fractional or with
 * a unit suffix: `-n +20`, `-c 1K`, `-s 0.5`), `text` any literal word, a list exactly those words.
 */
type Value = "count" | "text" | readonly string[];

/**
 * A command that prints files and nothing else, as an allow-list of its options: anything not
 * listed (an unknown letter anywhere in a cluster such as `-So`, an unknown long option, a
 * value of the wrong kind) makes the command not a pure read. Listing only what is known to be
 * harmless fails closed: `less -o/-O file` writes a log, `less -k file` loads key bindings,
 * `bat --pager …` runs a command line, and each could hide in a cluster or behind a new flag.
 */
interface Reader {
  /** Short options that take no value. */
  flags: string;
  /** Short options that take a value: the rest of the cluster (`-n40`) or the next word. */
  values: Readonly<Record<string, Value>>;
  /** Long options: null takes no value; otherwise the value, as `--name=v` or `--name v`. */
  long: Readonly<Record<string, Value | null>>;
  /** `-20` is a line count (head, tail, more). */
  numeric?: true;
  /** A `+…` word is a command the pager runs at start (`+G`, `+/re`, `+!cmd`), not a file. */
  pager?: true;
}

const TEXT = "text" as const;
const COUNT = "count" as const;
const BAT: Reader = {
  flags: "pnAPuf",
  values: { l: TEXT, r: TEXT, H: TEXT, m: TEXT },
  long: {
    plain: null,
    number: null,
    "show-all": null,
    unbuffered: null,
    "force-colorization": null,
    style: TEXT,
    language: TEXT,
    "line-range": TEXT,
    "highlight-line": TEXT,
    "map-syntax": TEXT,
    theme: TEXT,
    tabs: COUNT,
    wrap: ["auto", "never", "character"],
    color: ["auto", "never", "always"],
    decorations: ["auto", "never", "always"],
    "italic-text": ["always", "never"],
    "terminal-width": TEXT,
    "file-name": TEXT,
    // Any other paging mode starts the pager; `--pager` names a command line to run.
    paging: ["never"],
  },
};
const READERS: Readonly<Record<string, Reader>> = {
  cat: {
    flags: "AbeEnstTuv",
    values: {},
    long: { number: null, "number-nonblank": null, "show-all": null, "show-ends": null, "show-tabs": null, "show-nonprinting": null, "squeeze-blank": null },
  },
  head: { flags: "qv", values: { n: COUNT, c: COUNT }, long: { lines: COUNT, bytes: COUNT, quiet: null, silent: null, verbose: null }, numeric: true },
  tail: {
    flags: "fFqvr",
    values: { n: COUNT, c: COUNT, b: COUNT, s: COUNT },
    long: { lines: COUNT, bytes: COUNT, follow: null, retry: null, quiet: null, silent: null, verbose: null, pid: COUNT, "sleep-interval": COUNT, "max-unchanged-stats": COUNT },
    numeric: true,
  },
  nl: {
    flags: "p",
    values: { b: TEXT, d: TEXT, f: TEXT, h: TEXT, i: COUNT, l: COUNT, n: TEXT, s: TEXT, v: COUNT, w: COUNT },
    long: {
      "body-numbering": TEXT,
      "section-delimiter": TEXT,
      "footer-numbering": TEXT,
      "header-numbering": TEXT,
      "line-increment": COUNT,
      "join-blank-lines": COUNT,
      "number-format": TEXT,
      "number-separator": TEXT,
      "starting-line-number": COUNT,
      "number-width": COUNT,
      "no-renumber": null,
    },
  },
  // Not -o/-O (write a log file), -k (load key bindings), -t/-T (follow a tags file), -f (open special files).
  less: {
    flags: "aBcCdeEFgGiIJKLmMnNqQrRsSuUwWX~",
    values: { b: COUNT, h: COUNT, j: TEXT, p: TEXT, P: TEXT, x: TEXT, y: COUNT, z: COUNT, "#": COUNT },
    long: {
      "chop-long-lines": null,
      "LINE-NUMBERS": null,
      "line-numbers": null,
      "RAW-CONTROL-CHARS": null,
      "raw-control-chars": null,
      "quit-if-one-screen": null,
      "quit-at-eof": null,
      "QUIT-AT-EOF": null,
      "no-init": null,
      "ignore-case": null,
      "IGNORE-CASE": null,
      "squeeze-blank-lines": null,
      "no-lessopen": null,
      tabs: TEXT,
      pattern: TEXT,
    },
    pager: true,
  },
  more: { flags: "dlfpcsu", values: { n: COUNT }, long: {}, numeric: true, pager: true },
  bat: BAT,
  batcat: BAT,
};
const COUNT_VALUE = /^[+-]?\d+(?:\.\d+)?[A-Za-z]{0,3}$/;

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
/** sed's short options that neither write nor load a script, and `-e <script>`. */
const SED_SHORT = { flags: "nErsuz", values: { e: "text" } } as const;
/** One sed address: a line number, `$`, or a /regex/ (no flags). */
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
/** A sed command that only prints a range: `12p`, `1,200p`, `/start/,/end/p`, `10,+5p`, `0~4p`. */
const SED_PRINT = new RegExp(String.raw`^(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|\+\d+|~\d+))?|\d+~\d+)?\s*p$`);

type Word = { word: string; glob: boolean };
type Token = Word | { op: "|" | "&&" | ";" };

/**
 * The absolute paths a command reads, when it is a pure file read; null otherwise (including
 * a command it cannot fully parse). `command` is a shell string or an argv array (Codex's
 * `shell` tool); relative paths resolve against `cwd` and any `cd` before them, and every one
 * must be inside `root`. A path given as a glob is a read but has no single path, so it is
 * left out of the list.
 */
export function shellFileReads(command: string | readonly string[], cwd: string, root: string, depth = 0): string[] | null {
  if (depth > 2) return null;
  let tokens: Token[] | null;
  if (typeof command === "string") tokens = tokenize(command);
  else tokens = command.map((word) => ({ word, glob: false }));
  if (tokens === null || tokens.length === 0) return null;

  // `bash -lc '<script>'`: the script is the command (no further arguments, which would become $0…).
  const first = tokens[0];
  if (first !== undefined && "word" in first && SHELLS.has(basename(first.word))) {
    const script = unwrapShell(tokens);
    return script === null ? null : shellFileReads(script, cwd, root, depth + 1);
  }

  const paths: string[] = [];
  let base = cwd;
  let reads = false;
  const segments = split(tokens);
  if (segments === null) return null;
  for (const pipeline of segments) {
    for (let i = 0; i < pipeline.length; i++) {
      const words = pipeline[i] ?? [];
      const name = words[0];
      if (name === undefined) return null;
      if (name.glob) return null;
      if (name.word === "cd" || name.word === "echo") {
        // Neither prints file content; in a pipeline either would feed something else, so reject.
        if (pipeline.length > 1) return null;
        if (words.some((w) => w.glob)) return null;
        if (name.word === "cd") {
          if (words.length !== 2) return null;
          base = resolve(base, words[1]?.word ?? "");
        }
        continue;
      }
      const read = readerPaths(name.word, words.slice(1));
      if (read === null) return null;
      // The head of a pipeline must name a file; later stages only filter what it printed.
      if (i === 0 && read.literal.length === 0 && read.globs.length === 0) return null;
      if (read.literal.length > 0 || read.globs.length > 0) reads = true;
      const resolved = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
      // Output read from outside the working tree is not a file Memchor can reference (the
      // importer keeps only in-tree paths), so it stays bounded command output instead of
      // disappearing. A glob's directory is checked the same way (its pattern resolves as a name).
      if (![...read.literal, ...read.globs].every((path) => within(resolved(path), root))) return null;
      for (const path of read.literal) paths.push(resolved(path));
    }
  }
  return reads ? [...new Set(paths)] : null;
}

/**
 * Paths and kind of a shell tool call run in `cwd`: a pure read of files inside `root` (the
 * event's working directory) is `artifact_access` (its output is stored as a reference only,
 * like the host's read tool); anything else is `other`.
 */
export function shellCall(command: string | readonly unknown[] | null, cwd: string, root: string): { paths: string[]; toolKind: ToolKind } {
  let reads: string[] | null = null;
  if (typeof command === "string") reads = shellFileReads(command, cwd, root);
  else if (command !== null && command.every((c): c is string => typeof c === "string")) reads = shellFileReads(command, cwd, root);
  return reads === null ? { paths: [], toolKind: "other" } : { paths: reads, toolKind: "artifact_access" };
}

/** Whether `path` is `root` or below it (both absolute, compared lexically: no filesystem access). */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The script of `bash|sh|zsh [-l] -c <script>` (flags may be combined, e.g. `-lc`), or null. */
function unwrapShell(tokens: Token[]): string | null {
  let sawC = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || !("word" in token) || token.glob) return null;
    if (!sawC) {
      if (!/^-[a-z]+$/.test(token.word)) return null;
      if (token.word.includes("c")) sawC = true;
      continue;
    }
    return i === tokens.length - 1 ? token.word : null;
  }
  return null;
}

/** Tokens → pipelines (`;`/`&&`-separated) of commands (`|`-separated) of words. */
function split(tokens: Token[]): Word[][][] | null {
  const out: Word[][][] = [];
  let pipeline: Word[][] = [];
  let words: Word[] = [];
  for (const token of tokens) {
    if ("word" in token) {
      words.push(token);
      continue;
    }
    if (token.op === "|") {
      if (words.length === 0) return null;
      pipeline.push(words);
      words = [];
      continue;
    }
    if (words.length > 0) pipeline.push(words);
    else if (pipeline.length > 0) return null; // `a | ;`
    if (pipeline.length > 0) out.push(pipeline);
    pipeline = [];
    words = [];
  }
  if (words.length > 0) pipeline.push(words);
  else if (pipeline.length > 0) return null;
  if (pipeline.length > 0) out.push(pipeline);
  return out;
}

/** The file operands of one reader invocation, or null when it is not a known pure read. */
function readerPaths(name: string, args: Word[]): { literal: string[]; globs: string[] } | null {
  let operands: Word[] | null;
  if (name === "sed") operands = sedOperands(args);
  else {
    const reader = READERS[name];
    operands = reader === undefined ? null : readerOperands(args, reader);
  }
  if (operands === null) return null;
  // `-` is stdin: in a pipeline it filters what came before, like no operand at all.
  return { literal: operands.filter((o) => !o.glob && o.word !== "-").map((o) => o.word), globs: operands.filter((o) => o.glob).map((o) => o.word) };
}

function readerOperands(args: Word[], reader: Reader): Word[] | null {
  const operands: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    if (arg.word === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (reader.pager === true && arg.word.startsWith("+")) return null;
    if (!arg.word.startsWith("-") || arg.word === "-") {
      operands.push(arg);
      continue;
    }
    if (arg.glob) return null;
    if (reader.numeric === true && /^-\d+$/.test(arg.word)) continue;
    // The value an option takes: inline, else the next word (which is then consumed).
    const valueOf = (inline: string | null): string | null => {
      if (inline !== null) return inline;
      const next = args[++i];
      return next === undefined || next.glob ? null : next.word;
    };
    if (arg.word.startsWith("--")) {
      const eq = arg.word.indexOf("=");
      const name = arg.word.slice(2, eq === -1 ? undefined : eq);
      if (!Object.hasOwn(reader.long, name)) return null;
      const kind = reader.long[name] ?? null;
      if (kind === null) {
        if (eq !== -1) return null;
        continue;
      }
      if (!accepts(kind, valueOf(eq === -1 ? null : arg.word.slice(eq + 1)))) return null;
      continue;
    }
    if (!shortCluster(arg.word.slice(1), reader, valueOf)) return null;
  }
  return operands;
}

/**
 * Checks every letter of a short-option cluster (`-So`, `-n40`, `-ba`): each must be a known
 * flag, until one that takes a value, which takes the rest of the cluster or the next word.
 */
function shortCluster(cluster: string, reader: Pick<Reader, "flags" | "values">, valueOf: (inline: string | null) => string | null): boolean {
  for (let j = 0; j < cluster.length; j++) {
    const letter = cluster.charAt(j);
    const kind = Object.hasOwn(reader.values, letter) ? reader.values[letter] : undefined;
    if (kind !== undefined) return accepts(kind, valueOf(j + 1 < cluster.length ? cluster.slice(j + 1) : null));
    if (!reader.flags.includes(letter)) return false;
  }
  return true;
}

function accepts(kind: Value, value: string | null): boolean {
  if (value === null) return false;
  if (kind === "text") return true;
  if (kind === "count") return COUNT_VALUE.test(value);
  return kind.includes(value);
}

/**
 * `sed -n '<print commands>' [files]`: -n (so only the selected lines print), every script
 * command a print, and no option that writes or loads a script (`-i`, `-f`, `w`).
 */
function sedOperands(args: Word[]): Word[] | null {
  const scripts: string[] = [];
  const operands: Word[] = [];
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    const word = arg.word;
    if (word === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      operands.push(arg);
      continue;
    }
    if (arg.glob) return null;
    if (word === "--expression") {
      const script = args[++i];
      if (script === undefined || script.glob) return null;
      scripts.push(script.word);
    } else if (word.startsWith("--expression=")) {
      scripts.push(word.slice("--expression=".length));
    } else if (word === "--quiet" || word === "--silent") {
      quiet = true;
    } else if (/^-[^-]/.test(word)) {
      // A cluster such as `-ne '1,5p'`: flags up to an `e`, whose script is the rest or the next word.
      const valueOf = (inline: string | null): string | null => {
        const next = inline === null ? args[++i] : undefined;
        const script = inline ?? (next === undefined || next.glob ? null : next.word);
        if (script !== null) scripts.push(script);
        return script;
      };
      if (!shortCluster(word.slice(1), SED_SHORT, valueOf)) return null;
      if ((word.split("e", 1)[0] ?? "").includes("n")) quiet = true;
    } else if (!["--posix", "--debug", "--regexp-extended", "--null-data", "--unbuffered", "--separate"].includes(word)) {
      return null;
    }
  }
  // Without -e, the first operand is the script.
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined || script.glob) return null;
    scripts.push(script.word);
  }
  return quiet && scripts.every(isPrintScript) ? operands : null;
}

function isPrintScript(script: string): boolean {
  const commands = script.split(/[;\n]/).map((c) => c.trim()).filter((c) => c !== "");
  return commands.length > 0 && commands.every((c) => SED_PRINT.test(c));
}

/**
 * Words and operators of a command, with quoting applied; null for anything whose meaning
 * depends on evaluation (expansions, substitutions, subshells, backgrounding, `||`,
 * redirects other than discarding or merging stderr) or that is unterminated.
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let glob = false;
  const end = (): void => {
    if (inWord) tokens.push({ word, glob });
    word = "";
    inWord = false;
    glob = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === " " || c === "\t") {
      end();
    } else if (c === "\n" || c === ";") {
      end();
      tokens.push({ op: ";" });
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return null;
      word += text.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text.charAt(j);
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1] ?? "")) {
          j++;
          if (text[j] !== "\n") word += text.charAt(j);
        } else {
          word += d;
        }
      }
      if (j >= text.length) return null;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= text.length) return null;
      i++;
      if (text[i] !== "\n") {
        word += text.charAt(i);
        inWord = true;
      }
    } else if (c === "|") {
      if (text[i + 1] === "|" || text[i + 1] === "&") return null;
      end();
      tokens.push({ op: "|" });
    } else if (c === "&") {
      if (text[i + 1] !== "&") return null;
      end();
      tokens.push({ op: "&&" });
      i++;
    } else if (c === ">" || c === "<") {
      // Only `2>/dev/null` and `2>&1` (stderr discarded or merged): the command still just prints.
      if (c !== ">" || word !== "2" || glob) return null;
      const rest = /^>\s*(\/dev\/null|&1)(?=$|[\s;|&])/.exec(text.slice(i));
      if (rest === null) return null;
      word = "";
      inWord = false;
      i += rest[0].length - 1;
    } else if ("$`(){}!#~".includes(c) && !(c === "#" && inWord) && !(c === "~" && inWord)) {
      return null;
    } else {
      if (c === "*" || c === "?" || c === "[") glob = true;
      word += c;
      inWord = true;
    }
  }
  end();
  return tokens;
}
