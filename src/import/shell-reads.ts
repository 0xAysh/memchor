import { basename, isAbsolute, resolve } from "node:path";
import type { ToolKind } from "./normalized-event.js";

/**
 * Recognises shell commands that only print files (`sed -n '40,87p' src/a.ts`, `nl -ba a.ts |
 * sed -n '1,40p'`, `cat -n a.ts 2>/dev/null | head -50`, …), so an adapter can class them like
 * the host's own file-read tool: the output is a file's content, which the importer keeps as a
 * reference only (PRD §8.3). Agents read code through the shell far more often than through a
 * read tool, so without this their file contents would be kept as tool-output passages.
 *
 * The parse is deliberately narrow and never evaluates anything. A command is a pure read only
 * when every part of it is understood: a reader from {@link READERS} with its options, `cd`, or
 * an `echo` separator, joined by `|`, `&&`, `;` or newlines, optionally inside one `bash|sh|zsh
 * -c` wrapper. Anything else (an expansion, a substitution, a redirect other than `2>/dev/null` /
 * `2>&1`, `||`, a subshell, an unknown option, `sed -i`, a sed script that does more than print,
 * a search such as `grep`) makes the whole command "not a pure read", and the importer keeps its
 * output as a bounded passage, exactly as before. A wrong "not a read" costs nothing new; a
 * wrong "read" would only drop output, never keep file content.
 */

/**
 * Commands that print files and nothing else, with the options that take a separate argument
 * (so that argument is not mistaken for a file). Any other option is a flag. `sed` has its own
 * rules ({@link sedOperands}); `grep`/`rg` are searches, not reads, and are not here.
 */
const BAT_ARGUMENTS = ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style", "--paging", "--theme", "--tabs", "--wrap", "--color", "--decorations", "-m", "--map-syntax", "--file-name", "--terminal-width", "--italic-text", "--pager"];
const READERS: Record<string, ReadonlySet<string>> = {
  cat: new Set(),
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "-s", "-b", "--lines", "--bytes", "--sleep-interval", "--pid", "--max-unchanged-stats"]),
  nl: new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]),
  less: new Set(["-b", "-h", "-j", "-p", "-t", "-T", "-x", "-y", "-z", "-P", "-#"]),
  more: new Set(["-n", "-p"]),
  bat: new Set(BAT_ARGUMENTS),
  batcat: new Set(BAT_ARGUMENTS),
};
/** `less -o/-O file` copies its input to a log file: a write. */
const WRITING_OPTIONS = new Set(["-o", "-O", "--log-file", "--LOG-FILE"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
/** One sed address: a line number, `$`, or a /regex/ (no flags). */
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
/** A sed command that only prints a range: `12p`, `1,200p`, `/start/,/end/p`, `10,+5p`, `0~4p`. */
const SED_PRINT = new RegExp(String.raw`^(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|\+\d+|~\d+))?|\d+~\d+)?\s*p$`);

type Word = { word: string; glob: boolean };
type Token = Word | { op: "|" | "&&" | ";" };

/**
 * The absolute paths a command reads, when it is a pure file read; null otherwise (including
 * a command it cannot fully parse). `command` is a shell string or an argv array (Codex's
 * `shell` tool); relative paths resolve against `cwd` and any `cd` before them. A path given as
 * a glob is a read but has no single path, so it is left out of the list.
 */
export function shellFileReads(command: string | readonly string[], cwd: string, depth = 0): string[] | null {
  if (depth > 2) return null;
  let tokens: Token[] | null;
  if (typeof command === "string") tokens = tokenize(command);
  else tokens = command.map((word) => ({ word, glob: false }));
  if (tokens === null || tokens.length === 0) return null;

  // `bash -lc '<script>'`: the script is the command (no further arguments, which would become $0…).
  const first = tokens[0];
  if (first !== undefined && "word" in first && SHELLS.has(basename(first.word))) {
    const script = unwrapShell(tokens);
    return script === null ? null : shellFileReads(script, cwd, depth + 1);
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
      if (i === 0 && read.literal.length === 0 && !read.glob) return null;
      if (read.literal.length > 0 || read.glob) reads = true;
      for (const path of read.literal) paths.push(isAbsolute(path) ? path : resolve(base, path));
    }
  }
  return reads ? [...new Set(paths)] : null;
}

/**
 * Paths and kind of a shell tool call: a pure file read is `artifact_access` (its output is
 * stored as a reference only, like the host's read tool); anything else is `other`.
 */
export function shellCall(command: string | readonly unknown[] | null, cwd: string): { paths: string[]; toolKind: ToolKind } {
  let reads: string[] | null = null;
  if (typeof command === "string") reads = shellFileReads(command, cwd);
  else if (command !== null && command.every((c): c is string => typeof c === "string")) reads = shellFileReads(command, cwd);
  return reads === null ? { paths: [], toolKind: "other" } : { paths: reads, toolKind: "artifact_access" };
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
function readerPaths(name: string, args: Word[]): { literal: string[]; glob: boolean } | null {
  let operands: Word[] | null;
  if (name === "sed") operands = sedOperands(args);
  else {
    const withArgument = READERS[name];
    operands = withArgument === undefined ? null : readerOperands(args, withArgument);
  }
  if (operands === null) return null;
  // `-` is stdin: in a pipeline it filters what came before, like no operand at all.
  return { literal: operands.filter((o) => !o.glob && o.word !== "-").map((o) => o.word), glob: operands.some((o) => o.glob) };
}

function readerOperands(args: Word[], withArgument: ReadonlySet<string>): Word[] | null {
  const operands: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    if (arg.word === "--") return [...operands, ...args.slice(i + 1)];
    // `-20` (head/tail line count) and `+20` (less/more start line) are counts, not files.
    if (/^[-+]\d+$/.test(arg.word)) continue;
    if (!arg.word.startsWith("-") || arg.word === "-") {
      operands.push(arg);
      continue;
    }
    if (arg.glob) return null;
    const long = arg.word.startsWith("--");
    const flag = long ? (arg.word.split("=", 1)[0] ?? "") : arg.word.slice(0, 2);
    const inline = long ? arg.word.includes("=") : arg.word.length > 2;
    if (WRITING_OPTIONS.has(flag)) return null;
    if (withArgument.has(flag) && !inline) i++;
  }
  return operands;
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
    if (word === "-e" || word === "--expression") {
      const script = args[++i];
      if (script === undefined || script.glob) return null;
      scripts.push(script.word);
    } else if (word.startsWith("--expression=")) {
      scripts.push(word.slice("--expression=".length));
    } else if (word === "--quiet" || word === "--silent") {
      quiet = true;
    } else if (/^-[nErsuz]+$/.test(word)) {
      if (word.includes("n")) quiet = true;
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
