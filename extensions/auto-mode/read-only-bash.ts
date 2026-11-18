import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parse,
  type Node,
  type Redirect,
  type Statement,
  type Word,
} from "../vendor/unbash/dist/parser.js";
import { HOME } from "./constants.ts";
import { isInside, isSafetyControlPath, resolveInputPath, resolvePathForPolicy } from "./paths.ts";
import {
  matchesDeniedPath,
  recursiveSearchMayReachDeniedPath,
} from "./permissions.ts";
import { isInsideReadOnlyRoot, isPlainFilePath } from "./read-only-roots.ts";

/**
 * Deterministic classification of "pure read" shell commands.
 *
 * This is an allowlist over a strict subset of shell syntax: simple commands,
 * pipelines, and `&&`/`||` lists whose words are fully static and whose
 * binaries and flags appear in the tables below. Anything the analyzer does
 * not fully understand is "not read-only" and falls through to the normal
 * permission and classifier pipeline. It is not a sandbox: it only avoids a
 * model call for commands that, as far as this static analysis can tell,
 * cannot write, execute other programs, or reach paths covered by
 * `deniedPaths`.
 */

export const MAX_READ_ONLY_BASH_LENGTH = 16 * 1024;
export const MAX_READ_ONLY_BASH_COMMANDS = 32;
const MAX_SCRIPT_LENGTH = 1024;
const MAX_JQ_FILTER_LENGTH = 4096;

const NULL_DEVICE = "/dev/null";
/** Roots whose files expose process state or devices rather than ordinary data. */
const UNREADABLE_ROOTS = ["/proc", "/dev", "/sys"];
/** Characters that are never literal in an unquoted word. `$` and a leading `~` are handled separately. */
const UNSAFE_UNQUOTED = "*?[{}()`<>|&;\n";
/** Bash expands `~` after `=` and `:` in words shaped like assignments (`a=~/x`), but not in other words (`HEAD~1`). */
const ASSIGNMENT_LIKE_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const CD_BUILTIN = "cd";
/** `scheme://…`, bare or after `=`: the omp shell maps some schemes to files and hosts. */
const URL_ARGUMENT = /(^|=)[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const FILE_WRITE_REDIRECTS = [">", ">>", "&>", "&>>"];
const DESCRIPTOR_TARGET = /^(?:\d+-?|-)$/;

export type ReadOnlyBashPolicy = {
  /** The session working directory. */
  cwd: string;
  deniedPaths: readonly string[];
  /** Directory the bash tool was asked to run in (`cwd` tool argument), absolute. */
  commandCwd?: string;
  /** Extra restriction on every physical path the command touches. */
  scope?: (physicalPath: string) => boolean;
};

export type ReadOnlyBashResult =
  | { readOnly: true; commands: string[] }
  | { readOnly: false; reason: string };

/** Thrown for anything the analyzer cannot prove read-only. */
class Reject extends Error {}

function reject(reason: string): never {
  throw new Reject(reason);
}

type ShellEnv = {
  /** Directory relative paths resolve against, symlinks resolved (what the kernel uses). */
  cwd: string;
  policy: ReadOnlyBashPolicy;
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * `$HOME`/`~` are only trusted when the environment agrees with the resolved
 * home directory and the value survives unquoted word splitting and globbing.
 */
function homeUsable(): boolean {
  return (process.env.HOME === undefined || process.env.HOME === HOME) &&
    !/[\s*?[\]{}\\'"`$]/.test(HOME);
}

/** Length of a `$HOME` / `${HOME}` expansion at `index`, followed by `/`, `"`, or end of text. */
function homeExpansionLength(text: string, index: number): number {
  for (const form of ["${HOME}", "$HOME"]) {
    if (!text.startsWith(form, index)) continue;
    const next = text[index + form.length];
    if (next === undefined || next === "/" || next === '"') return form.length;
  }
  return 0;
}

function partsAreStatic(word: Word): boolean {
  for (const part of word.parts ?? []) {
    // Expansions are vetted by the text scanner, which only accepts `$HOME` and `${HOME}`.
    if (
      part.type === "Literal" || part.type === "SingleQuoted" ||
      part.type === "SimpleExpansion" || part.type === "ParameterExpansion"
    ) {
      continue;
    }
    if (part.type !== "DoubleQuoted") return false;
    for (const child of part.parts) {
      if (
        child.type !== "Literal" && child.type !== "SimpleExpansion" &&
        child.type !== "ParameterExpansion"
      ) {
        return false;
      }
    }
  }
  return true;
}

function decodeDoubleQuoted(
  text: string,
  start: number,
  atWordStart: boolean,
): { value: string; next: number } | undefined {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') return { value, next: index + 1 };
    if (character === "\\") {
      const escaped = text[index + 1];
      if (escaped === undefined || escaped === "\n") return undefined;
      value += "$`\"\\".includes(escaped) ? escaped : `\\${escaped}`;
      index += 2;
    } else if (character === "`") {
      return undefined;
    } else if (character === "$") {
      const home = homeExpansionLength(text, index);
      if (!atWordStart || index !== start + 1 || home === 0 || !homeUsable()) {
        return undefined;
      }
      value += HOME;
      index += home;
    } else {
      value += character;
      index += 1;
    }
  }
  return undefined;
}

/**
 * The exact string the shell passes to the program, or undefined when the word
 * depends on anything but its own text: expansions, globs, braces, tildes
 * other than a leading `~/`, and `$HOME` prefixes that do not match the home
 * directory this extension resolves.
 */
export function decodeStaticWord(word: Word): string | undefined {
  if (!partsAreStatic(word)) return undefined;
  const text = word.text;
  let value = "";
  let index = 0;
  let atWordStart = true;
  if (text.startsWith("~")) {
    if ((text !== "~" && !text.startsWith("~/")) || !homeUsable()) {
      return undefined;
    }
    value = HOME;
    index = 1;
    atWordStart = false;
  }
  if (ASSIGNMENT_LIKE_WORD.test(text) && text.includes("~")) return undefined;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      const escaped = text[index + 1];
      if (escaped === undefined || escaped === "\n") return undefined;
      value += escaped;
      index += 2;
    } else if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return undefined;
      value += text.slice(index + 1, end);
      index = end + 1;
    } else if (character === '"') {
      const quoted = decodeDoubleQuoted(text, index, atWordStart);
      if (!quoted) return undefined;
      value += quoted.value;
      index = quoted.next;
    } else if (character === "$") {
      const home = homeExpansionLength(text, index);
      if (!atWordStart || home === 0 || !homeUsable()) return undefined;
      value += HOME;
      index += home;
    } else if (UNSAFE_UNQUOTED.includes(character)) {
      return undefined;
    } else {
      value += character;
      index += 1;
    }
    atWordStart = false;
  }
  return value;
}

function staticWord(word: Word, what: string): string {
  const value = decodeStaticWord(word);
  if (value === undefined) reject(`${what} is not a static word: ${word.text}`);
  return value;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve `value` the way the kernel does: symlinks are followed segment by
 * segment, so `link/..` leaves the link target's parent instead of being
 * collapsed lexically.
 */
export function resolvePhysicalPath(
  base: string,
  value: string,
): string | undefined {
  let current = value.startsWith("/") ? "/" : base;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = resolvePathForPolicy(join(current, segment));
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function isUnreadableRoot(path: string): boolean {
  if (path === NULL_DEVICE) return false;
  return UNREADABLE_ROOTS.some((root) =>
    path === root || path.startsWith(`${root}/`)
  );
}

/** A recursive walk from `path` would enter a process, device, or kernel tree. */
function reachesUnreadableRoot(path: string): boolean {
  const prefix = path === "/" ? "/" : `${path}/`;
  return UNREADABLE_ROOTS.some((root) => root.startsWith(prefix));
}

function searchScopeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A missing or unreadable scope is treated as a directory so a race cannot fail open.
    return true;
  }
}

/** Apply the read-tool path policy to a path argument. Rejects when it is not provably allowed. */
function checkPath(env: ShellEnv, value: string, recursive: boolean): void {
  if (value === "") reject("empty path argument");
  const { policy } = env;
  const denied = [...policy.deniedPaths];
  const lexical = resolve(env.cwd, value);
  const physical = resolvePhysicalPath(env.cwd, value);
  if (physical === undefined) reject(`path cannot be resolved: ${value}`);
  if (policy.scope && !policy.scope(physical)) {
    reject(`path is outside the permitted read scope: ${physical}`);
  }
  for (const candidate of new Set([lexical, physical])) {
    if (denied.length > 0 && matchesDeniedPath(candidate, denied)) {
      reject(`path denied by policy: ${candidate}`);
    }
    if (isSafetyControlPath(candidate, policy.cwd)) {
      reject(`path is a safety control: ${candidate}`);
    }
    if (isUnreadableRoot(candidate)) {
      reject(`path is a process or device file: ${candidate}`);
    }
    if (recursive && reachesUnreadableRoot(candidate)) {
      reject(`search scope can reach a process or device file: ${candidate}`);
    }
    if (
      recursive && denied.length > 0 && searchScopeIsDirectory(candidate) &&
      recursiveSearchMayReachDeniedPath(candidate, denied)
    ) {
      reject(`search scope can contain a denied path: ${candidate}`);
    }
  }
}

function enterDirectory(env: ShellEnv, value: string): ShellEnv {
  checkPath(env, value, false);
  const physical = resolvePhysicalPath(env.cwd, value);
  if (physical === undefined) reject(`directory cannot be resolved: ${value}`);
  return { ...env, cwd: physical };
}

function findGitRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Repository config that makes read-only subcommands run programs: `status`
 * runs `core.fsmonitor` and clean filters, `diff`/`log -p`/`blame` run textconv
 * and external diff drivers. Includes are not followed, so they count too.
 * Over-matching only sends the command to the classifier.
 */
const GIT_EXECUTING_CONFIG =
  /fsmonitor|pager|external|textconv|filter|command|hookspath|include|alias|editor|program|helper/i;

/** Config files of the repository that contains `cwd`, including a linked worktree's shared config. */
function gitConfigFiles(cwd: string): string[] {
  const dotGit = join(findGitRoot(cwd), ".git");
  if (!existsSync(dotGit)) return [];
  let gitDir = dotGit;
  if (!statSync(dotGit).isDirectory()) {
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (link === undefined) reject("unrecognised .git file");
    gitDir = resolve(dirname(dotGit), link.trim());
  }
  const commonDirFile = join(gitDir, "commondir");
  const commonDir = existsSync(commonDirFile)
    ? resolve(gitDir, readFileSync(commonDirFile, "utf8").trim())
    : gitDir;
  return [join(commonDir, "config"), join(gitDir, "config.worktree")];
}

function rejectExecutingGitConfig(cwd: string): void {
  try {
    for (const file of gitConfigFiles(cwd)) {
      if (existsSync(file) && GIT_EXECUTING_CONFIG.test(readFileSync(file, "utf8"))) {
        reject(`git repository config can run programs: ${file}`);
      }
    }
  } catch (error) {
    if (error instanceof Reject) throw error;
    reject("git repository config cannot be read");
  }
}

// ---------------------------------------------------------------------------
// Argument parsing against a specification
// ---------------------------------------------------------------------------

type ParsedArgs = {
  /** Flags seen, as `-x` or `--name`. */
  flags: Set<string>;
  operands: string[];
  patterns: string[];
  pathValues: string[];
};

type CommandSpec = {
  /** Short flags without a value. */
  flags?: string;
  /** Short flags whose value is the rest of the cluster or the next argument. */
  valueFlags?: string;
  /** Short flags whose value must be attached (`-U3`). */
  attachedFlags?: string;
  /** Short flags whose value may be attached (`-M50%`) and never consumes the next argument. */
  optionalAttachedFlags?: string;
  /** Short flags whose value is a path. */
  pathFlags?: string;
  /** `-5` style numeric flags. */
  numeric?: boolean;
  long?: readonly string[];
  /** Long options with an optional `=value` that never consumes the next argument. */
  longOptional?: readonly string[];
  /** Long options with a required value (`--name=v` or `--name v`). */
  longValue?: readonly string[];
  longPath?: readonly string[];
  /** Long options taking two values (`--arg name value`). */
  longTwoValues?: readonly string[];
  /** Long options taking a name and a path (`--rawfile name file`). */
  longNamePath?: readonly string[];
  operands: "paths" | "strings" | "none";
  /** The first operand is a pattern unless a pattern flag supplied it. */
  pattern?: {
    flags: string;
    long: readonly string[];
    validate?: (value: string) => boolean;
    /** Flags that make the pattern unnecessary (`rg --files`): every operand is then a path. */
    optionalWith?: readonly string[];
    /** Flags that name a file of patterns (`grep -f`): every operand is then a path. */
    fileFlags?: readonly string[];
  };
  maxOperands?: number;
  validateOperand?: (value: string) => boolean;
  /** Rejects any option value matching this pattern. */
  forbiddenValue?: RegExp;
  /** Search `.` when no path operand is given. */
  implicitCwd?: "always" | "when-recursive";
  recursive?: "always" | "flag";
  recursiveFlags?: readonly string[];
  /** Output can contain file contents from the whole repository. */
  repoContent?: boolean;
  validate?: (parsed: ParsedArgs) => boolean;
};

type Cursor = { index: number };

function checkOptionValue(spec: CommandSpec, value: string): void {
  if (spec.forbiddenValue?.test(value)) reject(`option value is not allowed: ${value}`);
}

function parseLongOption(
  spec: CommandSpec,
  arg: string,
  args: readonly string[],
  cursor: Cursor,
  parsed: ParsedArgs,
): void {
  const equals = arg.indexOf("=");
  const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
  const inline = equals < 0 ? undefined : arg.slice(equals + 1);
  const flag = `--${name}`;
  if (inline !== undefined) checkOptionValue(spec, inline);
  const nextValue = (): string => {
    const value = inline ?? args[cursor.index++];
    if (value === undefined) reject(`option ${flag} needs a value`);
    checkOptionValue(spec, value);
    return value;
  };
  if (spec.long?.includes(name)) {
    if (inline !== undefined) reject(`option ${flag} takes no value`);
  } else if (spec.longOptional?.includes(name)) {
    // Optional arguments only attach with `=`.
  } else if (spec.longValue?.includes(name)) {
    const value = nextValue();
    if (spec.pattern?.long.includes(name)) parsed.patterns.push(value);
  } else if (spec.longPath?.includes(name)) {
    parsed.pathValues.push(nextValue());
  } else if (spec.longTwoValues?.includes(name)) {
    if (inline !== undefined) reject(`option ${flag} takes two values`);
    nextValue();
    nextValue();
  } else if (spec.longNamePath?.includes(name)) {
    if (inline !== undefined) reject(`option ${flag} takes two values`);
    nextValue();
    parsed.pathValues.push(nextValue());
  } else {
    reject(`option not allowed: ${arg}`);
  }
  parsed.flags.add(flag);
}

function parseShortCluster(
  spec: CommandSpec,
  arg: string,
  args: readonly string[],
  cursor: Cursor,
  parsed: ParsedArgs,
): void {
  if (spec.numeric && /^-\d+$/.test(arg)) {
    parsed.flags.add("-<n>");
    return;
  }
  for (let position = 1; position < arg.length; position += 1) {
    const character = arg[position];
    parsed.flags.add(`-${character}`);
    if (spec.flags?.includes(character)) continue;
    const rest = arg.slice(position + 1);
    checkOptionValue(spec, rest);
    if (spec.optionalAttachedFlags?.includes(character)) return;
    if (spec.attachedFlags?.includes(character)) {
      if (rest === "") reject(`option -${character} needs an attached value`);
      return;
    }
    const takesValue = spec.valueFlags?.includes(character) ?? false;
    const takesPath = spec.pathFlags?.includes(character) ?? false;
    if (!takesValue && !takesPath) reject(`option not allowed: -${character}`);
    const value = rest !== "" ? rest : args[cursor.index++];
    if (value === undefined) reject(`option -${character} needs a value`);
    checkOptionValue(spec, value);
    if (takesPath) parsed.pathValues.push(value);
    else if (spec.pattern?.flags.includes(character)) parsed.patterns.push(value);
    return;
  }
}

function parseArgs(spec: CommandSpec, args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    flags: new Set(),
    operands: [],
    patterns: [],
    pathValues: [],
  };
  const cursor: Cursor = { index: 0 };
  let endOfOptions = false;
  while (cursor.index < args.length) {
    const arg = args[cursor.index++];
    if (endOfOptions || arg === "-" || !arg.startsWith("-")) {
      parsed.operands.push(arg);
    } else if (arg === "--") {
      endOfOptions = true;
    } else if (arg.startsWith("--")) {
      parseLongOption(spec, arg, args, cursor, parsed);
    } else {
      parseShortCluster(spec, arg, args, cursor, parsed);
    }
  }
  return parsed;
}

function runSpec(
  spec: CommandSpec,
  args: readonly string[],
  env: ShellEnv,
): void {
  const parsed = parseArgs(spec, args);
  if (spec.pattern) {
    const optional = spec.pattern.optionalWith?.some((flag) => parsed.flags.has(flag));
    const fromFile = spec.pattern.fileFlags?.some((flag) => parsed.flags.has(flag));
    if (parsed.patterns.length === 0 && !optional && !fromFile) {
      const first = parsed.operands.shift();
      if (first === undefined) reject("missing pattern or script");
      parsed.patterns.push(first);
    }
    if (spec.pattern.validate && !parsed.patterns.every(spec.pattern.validate)) {
      reject("pattern or script is not allowed");
    }
  }
  if (spec.operands === "none" && parsed.operands.length > 0) {
    reject("command takes no operands");
  }
  if (spec.maxOperands !== undefined && parsed.operands.length > spec.maxOperands) {
    reject("too many operands");
  }
  if (spec.validateOperand && !parsed.operands.every(spec.validateOperand)) {
    reject("operand is not allowed");
  }
  if (spec.validate && !spec.validate(parsed)) {
    reject("flag combination is not allowed");
  }

  const recursive = spec.recursive === "always" ||
    (spec.recursive === "flag" &&
      (spec.recursiveFlags ?? []).some((flag) => parsed.flags.has(flag)));
  for (const value of parsed.pathValues) checkPath(env, value, false);
  if (spec.operands === "paths") {
    const paths = parsed.operands.filter((operand) => operand !== "-");
    for (const value of paths) checkPath(env, value, recursive);
    const implicit = spec.implicitCwd === "always" ||
      (spec.implicitCwd === "when-recursive" && recursive);
    if (paths.length === 0 && implicit) checkPath(env, ".", recursive);
  }
  if (spec.repoContent) {
    checkPath({ ...env, cwd: findGitRoot(env.cwd) }, ".", true);
  }
}

// ---------------------------------------------------------------------------
// sed and jq program validation
// ---------------------------------------------------------------------------

const SED_SUBSTITUTE_FLAGS = "gpiImM0123456789";

/** Index after a `/`-terminated section starting at `start`, or -1 when unterminated. */
function skipSedDelimited(script: string, start: number): number {
  for (let index = start; index < script.length; index += 1) {
    const character = script[index];
    if (character === "\n") return -1;
    if (character === "\\") {
      if (index + 1 >= script.length) return -1;
      index += 1;
    } else if (character === "/") {
      return index + 1;
    }
  }
  return -1;
}

/** Skip an address (`N`, `$`, `/re/`); returns the index after it or -1. */
function skipSedAddress(script: string, start: number): number {
  const first = script[start];
  if (first === "$") return start + 1;
  if (first === "/") return skipSedDelimited(script, start + 1);
  let index = start;
  while (script[index] >= "0" && script[index] <= "9") index += 1;
  return index > start ? index : -1;
}

function skipBlanks(script: string, start: number): number {
  let index = start;
  while (script[index] === " " || script[index] === "\t") index += 1;
  return index;
}

/**
 * Only `p`, `d`, `q`, `=` and `s/re/repl/flags` commands with plain line or
 * regex addresses are accepted. Everything that can write, read other files,
 * execute commands, or branch (`w`, `W`, `r`, `R`, `e`, `!`, `{}`, labels,
 * `s///e`, `s///w`) is rejected.
 */
export function isSimpleSedScript(script: string): boolean {
  if (script.length > MAX_SCRIPT_LENGTH) return false;
  let index = 0;
  let commands = 0;
  while (index < script.length) {
    if (" \t;\n".includes(script[index])) {
      index += 1;
      continue;
    }
    const firstAddress = skipSedAddress(script, index);
    if (firstAddress >= 0) {
      index = firstAddress;
      if (script[index] === ",") {
        index += 1;
        if (script[index] === "+") index += 1;
        const secondAddress = skipSedAddress(script, index);
        if (secondAddress < 0) return false;
        index = secondAddress;
      }
    } else if (script[index] === "/") {
      return false;
    }
    index = skipBlanks(script, index);
    const command = script[index];
    index += 1;
    if (command === "q") {
      while (script[index] >= "0" && script[index] <= "9") index += 1;
    } else if (command === "s") {
      if (script[index] !== "/") return false;
      const afterPattern = skipSedDelimited(script, index + 1);
      if (afterPattern < 0) return false;
      const afterReplacement = skipSedDelimited(script, afterPattern);
      if (afterReplacement < 0) return false;
      index = afterReplacement;
      while (index < script.length && SED_SUBSTITUTE_FLAGS.includes(script[index])) {
        index += 1;
      }
    } else if (command !== "p" && command !== "d" && command !== "=") {
      return false;
    }
    index = skipBlanks(script, index);
    if (index < script.length && script[index] !== ";" && script[index] !== "\n") {
      return false;
    }
    commands += 1;
  }
  return commands > 0;
}

/** jq has no exec, but `env`/`$ENV` expose the process environment and modules read files. */
const JQ_FORBIDDEN =
  /(?<![A-Za-z0-9_$.])(?:env|import|include|modulemeta|get_search_list)(?![A-Za-z0-9_])|\$ENV|\$__prog_args/;

export function isSimpleJqFilter(filter: string): boolean {
  return filter.length <= MAX_JQ_FILTER_LENGTH && !JQ_FORBIDDEN.test(filter);
}

// ---------------------------------------------------------------------------
// Specifications
// ---------------------------------------------------------------------------

const CAT_SPEC: CommandSpec = {
  flags: "AbeEnstTuv",
  long: [
    "show-all", "number-nonblank", "show-ends", "number", "squeeze-blank",
    "show-tabs", "show-nonprinting",
  ],
  operands: "paths",
};

const HEAD_SPEC: CommandSpec = {
  flags: "qvz",
  valueFlags: "nc",
  numeric: true,
  long: ["quiet", "silent", "verbose", "zero-terminated"],
  longValue: ["lines", "bytes"],
  operands: "paths",
};

const WC_SPEC: CommandSpec = {
  flags: "cmlLw",
  long: ["bytes", "chars", "lines", "max-line-length", "words"],
  operands: "paths",
};

const FILE_SPEC: CommandSpec = {
  flags: "bchiLnNprv",
  long: [
    "brief", "dereference", "no-dereference", "mime", "mime-type",
    "mime-encoding", "no-pad", "keep-going", "raw",
  ],
  operands: "paths",
};

const STAT_SPEC: CommandSpec = {
  flags: "LftZ",
  valueFlags: "c",
  long: ["dereference", "file-system", "terse"],
  longValue: ["format", "printf"],
  operands: "paths",
};

const GREP_SPEC: CommandSpec = {
  flags: "aEFGhHiIlLnoPqrsTuUvwxzZbcV",
  valueFlags: "ABCme",
  pathFlags: "f",
  numeric: true,
  long: [
    "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp",
    "ignore-case", "no-ignore-case", "invert-match", "word-regexp",
    "line-regexp", "count", "files-with-matches", "files-without-match",
    "only-matching", "quiet", "silent", "no-messages", "line-number",
    "with-filename", "no-filename", "recursive", "null", "null-data", "text",
    "initial-tab", "byte-offset", "binary", "unix-byte-offsets",
    "line-buffered", "version",
  ],
  longOptional: ["color", "colour"],
  longValue: [
    "after-context", "before-context", "context", "regexp", "max-count",
    "include", "exclude", "exclude-dir", "label", "binary-files",
  ],
  longPath: ["file", "exclude-from"],
  operands: "paths",
  pattern: {
    flags: "e",
    long: ["regexp"],
    fileFlags: ["-f", "--file"],
    optionalWith: ["-V", "--version"],
  },
  implicitCwd: "when-recursive",
  recursive: "flag",
  recursiveFlags: ["-r", "--recursive"],
};

const RG_SPEC: CommandSpec = {
  flags: "iSsFwxvnNHIlcoqUuaPb.0",
  valueFlags: "egtTACBmjMEdr",
  pathFlags: "f",
  long: [
    "ignore-case", "smart-case", "case-sensitive", "fixed-strings",
    "word-regexp", "line-regexp", "invert-match", "line-number",
    "no-line-number", "with-filename", "no-filename", "no-ignore",
    "no-ignore-vcs", "no-ignore-dot", "no-ignore-parent", "no-ignore-global",
    "files-with-matches", "files-without-match", "count", "count-matches",
    "only-matching", "quiet", "multiline", "text", "hidden", "files",
    "pcre2", "no-config", "no-messages", "heading", "no-heading", "column",
    "no-column", "stats", "trim", "vimgrep", "json", "null", "binary",
    "passthru", "one-file-system", "type-list", "version", "unrestricted",
    "multiline-dotall", "crlf", "line-buffered", "block-buffered",
    "no-require-git", "no-unicode",
  ],
  longValue: [
    "color",
    "regexp", "glob", "iglob", "type", "type-not", "after-context",
    "before-context", "context", "max-count", "threads", "max-columns",
    "max-depth", "max-filesize", "encoding", "replace", "sort", "sortr",
    "context-separator", "path-separator", "field-match-separator",
    "field-context-separator", "colors",
  ],
  longPath: ["file", "ignore-file"],
  operands: "paths",
  pattern: {
    flags: "e",
    long: ["regexp"],
    fileFlags: ["-f", "--file"],
    optionalWith: ["--files", "--type-list", "--version"],
  },
  implicitCwd: "always",
  recursive: "always",
};

const SED_SPEC: CommandSpec = {
  flags: "nEr",
  valueFlags: "e",
  long: ["quiet", "silent", "regexp-extended"],
  longValue: ["expression"],
  operands: "paths",
  pattern: { flags: "e", long: ["expression"], validate: isSimpleSedScript },
};

const JQ_SPEC: CommandSpec = {
  flags: "cCrRsSneajM",
  long: [
    "compact-output", "color-output", "monochrome-output", "raw-output",
    "raw-input", "slurp", "sort-keys", "null-input", "exit-status", "ascii-output",
    "join-output", "tab", "seq", "stream",
  ],
  longValue: ["indent"],
  longTwoValues: ["arg", "argjson"],
  longNamePath: ["slurpfile", "rawfile"],
  operands: "paths",
  pattern: { flags: "", long: [], validate: isSimpleJqFilter },
};

const LS_SPEC: CommandSpec = {
  flags: "aAbBcCdfFgGhHiklLmnNopqQrRsStuUvxX1Z",
  valueFlags: "IwT",
  long: [
    "all", "almost-all", "escape", "ignore-backups", "classify", "directory",
    "human-readable", "inode", "dereference", "dereference-command-line",
    "literal", "no-group", "numeric-uid-gid", "quote-name", "recursive",
    "reverse", "size", "group-directories-first", "si", "author", "context",
    "hide-control-chars", "show-control-chars",
  ],
  longOptional: ["color", "hyperlink"],
  longValue: [
    "sort", "time", "format", "time-style", "quoting-style", "indicator-style",
    "hide", "ignore", "width", "tabsize",
  ],
  operands: "paths",
  /** `ls -RL` follows directory symlinks out of the checked scope. */
  validate: (parsed) =>
    !(
      (parsed.flags.has("-R") || parsed.flags.has("--recursive")) &&
      (parsed.flags.has("-L") || parsed.flags.has("--dereference"))
    ),
  implicitCwd: "always",
  recursive: "flag",
  recursiveFlags: ["-R", "--recursive"],
};

const TREE_SPEC: CommandSpec = {
  flags: "adfhipqrstuvxDFNCnJ",
  valueFlags: "LPI",
  long: ["noreport", "dirsfirst", "gitignore", "du", "prune", "si"],
  longOptional: ["charset"],
  operands: "paths",
  implicitCwd: "always",
  recursive: "always",
};

const DU_SPEC: CommandSpec = {
  flags: "abchkmsxSP",
  valueFlags: "dBt",
  long: [
    "summarize", "human-readable", "apparent-size", "total", "all", "bytes",
    "one-file-system", "si", "separate-dirs", "count-links",
  ],
  longOptional: ["time", "max-depth", "block-size", "threshold", "exclude"],
  operands: "paths",
  implicitCwd: "always",
  recursive: "always",
};

const DF_SPEC: CommandSpec = {
  flags: "ahHiklPT",
  valueFlags: "tx",
  long: ["all", "human-readable", "inodes", "local", "portability", "print-type", "si"],
  longOptional: ["output", "type", "exclude-type"],
  operands: "paths",
};

const DATE_SPEC: CommandSpec = {
  flags: "uR",
  valueFlags: "d",
  optionalAttachedFlags: "I",
  pathFlags: "r",
  long: ["utc", "universal", "rfc-email"],
  longValue: ["date", "rfc-3339"],
  longPath: ["reference"],
  longOptional: ["iso-8601"],
  operands: "strings",
  validateOperand: (value) => value.startsWith("+"),
};

const SORT_SPEC: CommandSpec = {
  flags: "bcCdfghiMnRrsuVz",
  valueFlags: "kSt",
  long: [
    "ignore-leading-blanks", "check", "dictionary-order", "ignore-case",
    "general-numeric-sort", "human-numeric-sort", "ignore-nonprinting",
    "month-sort", "numeric-sort", "random-sort", "reverse", "stable", "unique",
    "version-sort", "zero-terminated",
  ],
  longValue: ["key", "field-separator", "buffer-size", "sort"],
  operands: "paths",
};

const UNIQ_SPEC: CommandSpec = {
  flags: "cdDiuz",
  valueFlags: "fsw",
  long: ["count", "repeated", "unique", "ignore-case", "zero-terminated"],
  longOptional: ["all-repeated", "group"],
  longValue: ["skip-fields", "skip-chars", "check-chars"],
  operands: "paths",
  // A second operand names an output file.
  maxOperands: 1,
};

const CUT_SPEC: CommandSpec = {
  flags: "nsz",
  valueFlags: "bcdf",
  long: ["only-delimited", "complement", "zero-terminated"],
  longValue: ["bytes", "characters", "delimiter", "fields", "output-delimiter"],
  operands: "paths",
};

const NL_SPEC: CommandSpec = {
  flags: "p",
  valueFlags: "bdfhilnsvw",
  operands: "paths",
};

const COLUMN_SPEC: CommandSpec = {
  flags: "txe",
  valueFlags: "sco",
  operands: "paths",
};

const DIFF_SPEC: CommandSpec = {
  flags: "abBcdeEfinNpqrstTuwyZ",
  valueFlags: "LUCIFWx",
  pathFlags: "X",
  long: [
    "brief", "report-identical-files", "ignore-case", "ignore-space-change",
    "ignore-all-space", "ignore-blank-lines", "recursive", "new-file", "text",
    "side-by-side", "ed", "normal", "show-c-function", "no-dereference",
    "minimal", "expand-tabs", "initial-tab", "strip-trailing-cr",
  ],
  longOptional: ["unified", "context", "color"],
  longValue: ["label", "width", "exclude", "ignore-matching-lines", "tabsize"],
  longPath: ["exclude-from"],
  operands: "paths",
  maxOperands: 2,
  /** `diff -r` follows directory symlinks unless told not to. */
  validate: (parsed) =>
    parsed.flags.has("--no-dereference") ||
    !(parsed.flags.has("-r") || parsed.flags.has("--recursive")),
  recursive: "flag",
  recursiveFlags: ["-r", "--recursive"],
};

const CMP_SPEC: CommandSpec = {
  flags: "bls",
  valueFlags: "ni",
  long: ["print-bytes", "verbose", "silent", "quiet"],
  longValue: ["bytes", "ignore-initial"],
  operands: "paths",
  maxOperands: 2,
};

const CHECKSUM_SPEC: CommandSpec = {
  flags: "btz",
  long: ["binary", "text", "tag", "zero"],
  operands: "paths",
};

const GIT_DIFF_SHORT_FLAGS = "pusqwbzRaiEFPcrtmW";
/** `%G?` and `%(signature)` make git run gpg. */
const GIT_SIGNATURE_FORMAT = /%G|%\(signature/;

const GIT_LOG_SPEC: CommandSpec = {
  flags: GIT_DIFF_SHORT_FLAGS,
  valueFlags: "n",
  attachedFlags: "SG",
  optionalAttachedFlags: "UMC",
  numeric: true,
  forbiddenValue: /%G/,
  long: [
    "oneline", "shortstat", "numstat", "name-only", "name-status", "patch",
    "no-patch", "graph", "no-decorate", "abbrev-commit", "no-abbrev-commit",
    "all", "first-parent", "merges", "no-merges", "reverse", "date-order",
    "topo-order", "author-date-order", "no-color", "no-ext-diff",
    "no-textconv", "summary", "patch-with-stat", "full-history",
    "simplify-by-decoration", "follow", "cc", "raw", "compact-summary",
    "cached", "staged", "ignore-space-change", "ignore-all-space",
    "ignore-blank-lines", "ignore-space-at-eol", "minimal", "patience",
    "histogram", "function-context", "full-index", "binary", "no-renames",
    "check", "exit-code", "quiet", "left-right", "parents", "children",
    "boundary", "count", "regexp-ignore-case", "extended-regexp",
    "fixed-strings", "perl-regexp", "all-match", "invert-grep", "text",
    "no-prefix", "ignore-cr-at-eol", "no-notes", "no-walk", "do-walk",
    "remove-empty", "cherry-pick", "cherry-mark", "cherry", "left-only",
    "right-only", "ancestry-path", "objects", "no-object-names",
  ],
  longOptional: [
    "branches", "tags", "remotes", "decorate", "stat", "color", "dirstat",
    "word-diff", "color-words", "relative", "find-renames", "find-copies",
    "abbrev", "date", "pretty", "format", "diff-algorithm", "diff-filter",
    "unified", "inter-hunk-context", "submodule", "notes", "encoding",
    "color-moved", "decorate-refs", "decorate-refs-exclude", "glob",
    "exclude", "ignore-submodules", "src-prefix", "dst-prefix", "stat-count",
    "stat-width", "stat-name-width", "ita-invisible-in-index",
  ],
  longValue: [
    "max-count", "skip", "since", "until", "after", "before", "author",
    "committer", "grep", "min-parents", "max-parents",
  ],
  operands: "paths",
  repoContent: true,
};

const GIT_STATUS_SPEC: CommandSpec = {
  flags: "sbz",
  optionalAttachedFlags: "u",
  long: [
    "short", "branch", "long", "no-renames", "show-stash",
    "ahead-behind", "no-ahead-behind", "renames",
  ],
  longOptional: [
    "porcelain", "untracked-files", "ignored", "ignore-submodules", "column",
    "find-renames",
  ],
  operands: "paths",
};

/** Listing forms only: a bare operand would create a branch or tag. */
function operandsRequireListFlag(parsed: ParsedArgs): boolean {
  return parsed.operands.length === 0 || parsed.flags.has("--list") ||
    parsed.flags.has("-l");
}

const GIT_BRANCH_SPEC: CommandSpec = {
  flags: "avrl",
  long: [
    "all", "remotes", "verbose", "list", "show-current", "no-color",
    "no-column", "ignore-case", "omit-empty",
  ],
  longOptional: [
    "color", "column", "abbrev", "format", "sort", "contains", "no-contains",
    "merged", "no-merged", "points-at",
  ],
  forbiddenValue: GIT_SIGNATURE_FORMAT,
  operands: "paths",
  validate: operandsRequireListFlag,
};

const GIT_TAG_SPEC: CommandSpec = {
  flags: "ln",
  long: ["list", "no-color", "no-column", "ignore-case"],
  longOptional: [
    "color", "column", "sort", "format", "contains", "no-contains", "merged",
    "no-merged", "points-at", "abbrev",
  ],
  forbiddenValue: GIT_SIGNATURE_FORMAT,
  operands: "paths",
  validate: operandsRequireListFlag,
};

const GIT_REMOTE_SPEC: CommandSpec = {
  flags: "v",
  long: ["verbose"],
  operands: "none",
};

/** Keys whose values are credentials or commands, never worth printing. */
const GIT_CONFIG_SENSITIVE_KEY =
  /extraheader|credential|token|passw|secret|askpass|signingkey|sshcommand|auth/i;
const GIT_CONFIG_SPEC: CommandSpec = {
  flags: "z",
  long: [
    "get", "local", "global", "system", "worktree", "show-origin",
    "show-scope", "null", "bool", "int", "includes", "no-includes",
  ],
  operands: "strings",
  validate: (parsed) =>
    parsed.operands.length === 1 &&
    !GIT_CONFIG_SENSITIVE_KEY.test(parsed.operands[0]),
};

const GIT_REV_PARSE_SPEC: CommandSpec = {
  flags: "q",
  long: [
    "show-toplevel", "git-dir", "absolute-git-dir", "git-common-dir",
    "is-inside-work-tree", "is-inside-git-dir", "is-bare-repository",
    "show-prefix", "show-cdup", "show-superproject-working-tree", "symbolic",
    "symbolic-full-name", "verify", "revs-only", "no-revs", "no-flags", "flags",
    "all",
  ],
  longOptional: ["abbrev-ref", "short", "branches", "tags", "remotes", "glob"],
  operands: "paths",
};

const GIT_LS_FILES_SPEC: CommandSpec = {
  flags: "cdmoiskzuvt",
  long: [
    "cached", "deleted", "modified", "others", "ignored", "stage", "killed",
    "unmerged", "exclude-standard", "full-name", "error-unmatch", "eol",
    "directory", "no-empty-directory", "deduplicate",
  ],
  longOptional: ["abbrev"],
  operands: "paths",
};

const GIT_LS_TREE_SPEC: CommandSpec = {
  flags: "drtlz",
  long: ["name-only", "name-status", "long", "full-name", "full-tree", "object-only"],
  longOptional: ["abbrev"],
  operands: "paths",
};

const GIT_DESCRIBE_SPEC: CommandSpec = {
  long: ["tags", "all", "long", "always", "broken", "first-parent", "exact-match", "contains"],
  longOptional: ["dirty", "abbrev", "candidates", "match", "exclude"],
  operands: "paths",
};

const GIT_BLAME_SPEC: CommandSpec = {
  flags: "epwlsfnbt",
  valueFlags: "L",
  optionalAttachedFlags: "MC",
  long: [
    "porcelain", "line-porcelain", "incremental", "show-email", "show-name",
    "show-number", "show-stats", "root", "minimal",
  ],
  longOptional: ["abbrev", "date"],
  operands: "paths",
  repoContent: true,
};

const GIT_MERGE_BASE_SPEC: CommandSpec = {
  flags: "a",
  long: ["all", "is-ancestor", "fork-point"],
  operands: "paths",
};

const GIT_REF_LIST_SPEC: CommandSpec = {
  long: ["head", "heads", "tags", "dereference", "verify", "hash"],
  longOptional: ["format", "sort", "count", "contains", "merged", "points-at", "abbrev"],
  forbiddenValue: GIT_SIGNATURE_FORMAT,
  operands: "strings",
};

const GIT_WORKTREE_LIST_SPEC: CommandSpec = {
  flags: "vz",
  long: ["porcelain", "verbose"],
  operands: "none",
};

const GIT_SUBCOMMANDS: Record<string, CommandSpec> = {
  status: GIT_STATUS_SPEC,
  log: GIT_LOG_SPEC,
  show: GIT_LOG_SPEC,
  diff: GIT_LOG_SPEC,
  "rev-list": GIT_LOG_SPEC,
  branch: GIT_BRANCH_SPEC,
  tag: GIT_TAG_SPEC,
  remote: GIT_REMOTE_SPEC,
  config: GIT_CONFIG_SPEC,
  "rev-parse": GIT_REV_PARSE_SPEC,
  "ls-files": GIT_LS_FILES_SPEC,
  "ls-tree": GIT_LS_TREE_SPEC,
  describe: GIT_DESCRIBE_SPEC,
  blame: GIT_BLAME_SPEC,
  "merge-base": GIT_MERGE_BASE_SPEC,
  "for-each-ref": GIT_REF_LIST_SPEC,
  "show-ref": GIT_REF_LIST_SPEC,
};

/** Global options that cannot change what the subcommand executes. */
const GIT_SAFE_GLOBAL_FLAGS = ["--no-pager", "-P", "--no-optional-locks"];

function runGit(args: readonly string[], env: ShellEnv): void {
  let current = env;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (GIT_SAFE_GLOBAL_FLAGS.includes(arg)) continue;
    if (arg !== "-C") break;
    const directory = args[index + 1];
    if (directory === undefined) reject("git -C needs a directory");
    current = enterDirectory(current, directory);
    index += 1;
  }
  rejectExecutingGitConfig(current.cwd);
  const subcommand = args[index];
  if (subcommand === undefined) reject("git needs a subcommand");
  const rest = args.slice(index + 1);
  if (subcommand === "worktree") {
    if (rest[0] !== "list") reject("only `git worktree list` is read-only");
    runSpec(GIT_WORKTREE_LIST_SPEC, rest.slice(1), current);
    return;
  }
  if (!Object.hasOwn(GIT_SUBCOMMANDS, subcommand)) {
    reject(`git subcommand not allowed: ${subcommand}`);
  }
  runSpec(GIT_SUBCOMMANDS[subcommand], rest, current);
}

const FIND_FLAG_PRIMARIES = [
  "-print", "-print0", "-prune", "-depth", "-mount", "-xdev", "-empty",
  "-readable", "-writable", "-executable", "-true", "-false", "-not", "-and",
  "-or", "-a", "-o", "-ls", "-quit", "-nouser", "-nogroup", "-daystart",
  "!", "(", ")", ",",
];
const FIND_VALUE_PRIMARIES = [
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex",
  "-iregex", "-lname", "-ilname", "-type", "-xtype", "-size", "-mtime",
  "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-maxdepth", "-mindepth",
  "-user", "-group", "-perm", "-links", "-inum", "-uid", "-gid", "-fstype",
  "-printf", "-regextype",
];
const FIND_PATH_PRIMARIES = ["-newer", "-anewer", "-cnewer", "-samefile"];
/** `-newerXY`: Y = `t` takes a date string, anything else a reference file. */
const FIND_NEWER_XY = /^-newer[aBcm]([aBcmt])$/;

function runFind(args: readonly string[], env: ShellEnv): void {
  let index = 0;
  const startPaths: string[] = [];
  while (
    index < args.length && !args[index].startsWith("-") &&
    !FIND_FLAG_PRIMARIES.includes(args[index])
  ) {
    startPaths.push(args[index]);
    index += 1;
  }
  for (const path of startPaths) checkPath(env, path, true);
  if (startPaths.length === 0) checkPath(env, ".", true);
  while (index < args.length) {
    const token = args[index];
    index += 1;
    const newer = FIND_NEWER_XY.exec(token);
    if (FIND_FLAG_PRIMARIES.includes(token)) continue;
    if (FIND_VALUE_PRIMARIES.includes(token) || newer?.[1] === "t") {
      if (index >= args.length) reject(`find primary ${token} needs a value`);
      index += 1;
    } else if (FIND_PATH_PRIMARIES.includes(token) || newer) {
      const reference = args[index];
      if (reference === undefined) reject(`find primary ${token} needs a path`);
      checkPath(env, reference, false);
      index += 1;
    } else {
      reject(`find expression not allowed: ${token}`);
    }
  }
}

type Handler = CommandSpec | ((args: readonly string[], env: ShellEnv) => void);

function stringsOnly(flags: string): CommandSpec {
  return { flags, operands: "strings" };
}

/**
 * Allowlisted binaries. Deliberately absent: pagers (`less`, `man`),
 * interpreters (`awk`, `python`, `node`, `bash`), wrappers (`env`, `xargs`,
 * `time`, `timeout`, `nice`, `command`), `tee`, and anything that writes.
 */
const COMMANDS: Record<string, Handler> = {
  ls: LS_SPEC,
  cat: CAT_SPEC,
  head: HEAD_SPEC,
  tail: HEAD_SPEC,
  wc: WC_SPEC,
  file: FILE_SPEC,
  stat: STAT_SPEC,
  pwd: { flags: "LP", operands: "none" },
  echo: stringsOnly("neE"),
  printf: stringsOnly(""),
  true: stringsOnly(""),
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  rg: RG_SPEC,
  sed: SED_SPEC,
  jq: JQ_SPEC,
  find: runFind,
  git: runGit,
  which: stringsOnly("a"),
  type: stringsOnly("afptP"),
  tree: TREE_SPEC,
  du: DU_SPEC,
  df: DF_SPEC,
  date: DATE_SPEC,
  uname: {
    flags: "asnrvmpio",
    long: [
      "all", "kernel-name", "nodename", "kernel-release", "kernel-version",
      "machine", "processor", "hardware-platform", "operating-system",
    ],
    operands: "none",
  },
  id: {
    flags: "gGnrRuzZ",
    long: ["group", "groups", "name", "real", "user", "zero", "context"],
    operands: "strings",
  },
  whoami: { operands: "none" },
  sort: SORT_SPEC,
  uniq: UNIQ_SPEC,
  cut: CUT_SPEC,
  tr: stringsOnly("cCds"),
  nl: NL_SPEC,
  column: COLUMN_SPEC,
  basename: {
    flags: "az",
    valueFlags: "s",
    long: ["multiple", "zero"],
    longValue: ["suffix"],
    operands: "strings",
  },
  dirname: { flags: "z", long: ["zero"], operands: "strings" },
  realpath: {
    flags: "emsLPqz",
    long: [
      "canonicalize-existing", "canonicalize-missing", "no-symlinks", "logical",
      "physical", "quiet", "strip", "zero",
    ],
    longPath: ["relative-to", "relative-base"],
    operands: "paths",
  },
  readlink: {
    flags: "fnemqsvz",
    long: [
      "canonicalize", "no-newline", "canonicalize-existing",
      "canonicalize-missing", "quiet", "silent", "verbose", "zero",
    ],
    operands: "paths",
  },
  diff: DIFF_SPEC,
  cmp: CMP_SPEC,
  md5sum: CHECKSUM_SPEC,
  sha1sum: CHECKSUM_SPEC,
  sha256sum: CHECKSUM_SPEC,
  sha512sum: CHECKSUM_SPEC,
  b2sum: CHECKSUM_SPEC,
};

// ---------------------------------------------------------------------------
// Shell structure
// ---------------------------------------------------------------------------

function checkRedirects(redirects: readonly Redirect[], env: ShellEnv): void {
  for (const redirect of redirects) {
    if (redirect.variableName !== undefined) reject("redirect assigns a descriptor variable");
    if (!redirect.target) reject("redirect without a target");
    const target = staticWord(redirect.target, "redirect target");
    if (FILE_WRITE_REDIRECTS.includes(redirect.operator)) {
      if (target !== NULL_DEVICE) reject(`redirect writes to ${target}`);
    } else if (redirect.operator === ">&") {
      if (target !== NULL_DEVICE && !DESCRIPTOR_TARGET.test(target)) {
        reject(`redirect writes to ${target}`);
      }
    } else if (redirect.operator === "<&") {
      if (!DESCRIPTOR_TARGET.test(target)) reject(`redirect duplicates ${target}`);
    } else if (redirect.operator === "<") {
      checkPath(env, target, false);
    } else {
      reject(`redirect operator not allowed: ${redirect.operator}`);
    }
  }
}

function visitCommand(
  node: Extract<Node, { type: "Command" }>,
  env: ShellEnv,
  names: string[],
): void {
  if (node.prefix.length > 0) reject("environment assignment before command");
  if (!node.name) reject("command without a name");
  const name = staticWord(node.name, "command name");
  if (!Object.hasOwn(COMMANDS, name)) reject(`command not allowed: ${name}`);
  checkRedirects(node.redirects, env);
  const args = node.suffix.map((word) => staticWord(word, "argument"));
  if (args.some((arg) => URL_ARGUMENT.test(arg))) reject("argument is a URL");
  const handler = COMMANDS[name];
  if (typeof handler === "function") handler(args, env);
  else runSpec(handler, args, env);
  names.push(name);
  if (names.length > MAX_READ_ONLY_BASH_COMMANDS) reject("too many commands");
}

function visitPipelineOrCommand(node: Node, env: ShellEnv, names: string[]): void {
  if (node.type === "Command") {
    visitCommand(node, env, names);
    return;
  }
  if (node.type !== "Pipeline") reject(`unsupported shell construct: ${node.type}`);
  if (node.negated || node.time) reject("negated or timed pipeline");
  for (const stage of node.commands) {
    if (stage.type !== "Command") reject(`unsupported pipeline stage: ${stage.type}`);
    visitCommand(stage, env, names);
  }
}

function visitStatement(statement: Statement, env: ShellEnv, names: string[]): void {
  if (statement.background) reject("background execution");
  checkRedirects(statement.redirects, env);
  const node = statement.command;
  if (node.type !== "AndOr") {
    visitPipelineOrCommand(node, env, names);
    return;
  }
  for (const part of node.commands) visitPipelineOrCommand(part, env, names);
}

type LeadingCd = { target: string; chain: Node[] };

/** A first statement of `cd <absolute path>`, alone or heading a pure `&&` list. */
function leadingCd(statement: Statement): LeadingCd | undefined {
  if (statement.background) return undefined;
  const node = statement.command;
  const [head, ...chain] = node.type === "AndOr" ? node.commands : [node];
  if (head.type !== "Command" || !head.name) return undefined;
  if (decodeStaticWord(head.name) !== CD_BUILTIN) return undefined;
  if (node.type === "AndOr" && !node.operators.every((operator) => operator === "&&")) {
    reject("`cd` is only allowed at the head of a pure `&&` list");
  }
  if (head.prefix.length > 0 || head.redirects.length > 0 || head.suffix.length !== 1) {
    reject("`cd` must take exactly one plain argument");
  }
  const target = staticWord(head.suffix[0], "cd target");
  if (!target.startsWith("/")) reject("`cd` needs an absolute path");
  return { target, chain };
}

/**
 * Commands chained to a leading `cd` with `&&` run only after it succeeded, so
 * the new directory applies to them. Later statements run whether or not the
 * `cd` worked, so they are checked in both directories.
 */
function visitScript(statements: readonly Statement[], env: ShellEnv, names: string[]): void {
  const [first, ...rest] = statements;
  const lead = leadingCd(first);
  if (lead === undefined) {
    for (const statement of statements) visitStatement(statement, env, names);
    return;
  }
  checkRedirects(first.redirects, env);
  const inside = enterDirectory(env, lead.target);
  for (const part of lead.chain) visitPipelineOrCommand(part, inside, names);
  for (const statement of rest) {
    visitStatement(statement, env, names);
    visitStatement(statement, inside, []);
  }
}

/**
 * The analyzer policy for one bash tool call. A `cwd` tool argument moves the
 * command to another directory. With `allowInsideWorkingDirectory` on, file
 * tools outside the working directory reach the classifier, so shell reads
 * must stay inside it or inside a read-only root as well.
 */
export function readOnlyBashPolicy(
  settings: {
    deniedPaths: readonly string[];
    allowInsideWorkingDirectory: boolean;
    readOnlyRoots: readonly string[];
  },
  input: Record<string, unknown>,
  cwd: string,
): ReadOnlyBashPolicy | undefined {
  let commandCwd: string | undefined;
  const requested = input.cwd;
  if (requested !== undefined && requested !== null && requested !== "") {
    if (typeof requested !== "string" || !isPlainFilePath(requested)) return undefined;
    commandCwd = resolveInputPath(cwd, requested);
    if (commandCwd === undefined) return undefined;
  }
  const policyCwd = resolvePathForPolicy(cwd) ?? cwd;
  return {
    cwd,
    deniedPaths: settings.deniedPaths,
    commandCwd,
    scope: settings.allowInsideWorkingDirectory
      ? (path) =>
        isInside(path, policyCwd) || isInsideReadOnlyRoot(path, settings.readOnlyRoots)
      : undefined,
  };
}

/**
 * Decide whether `source` is a pure read: only allowlisted binaries with
 * allowlisted flags, static words, no writes, no command execution, and every
 * path argument acceptable to the read-tool path policy.
 */
export function analyzeReadOnlyBash(
  source: string,
  policy: ReadOnlyBashPolicy,
): ReadOnlyBashResult {
  try {
    if (source.length > MAX_READ_ONLY_BASH_LENGTH) reject("command is too long");
    const cwd = resolvePathForPolicy(policy.cwd);
    if (cwd === undefined) reject("working directory cannot be resolved");
    const script = parse(source);
    if (script.errors?.length) reject("command does not parse cleanly");
    if (script.shebang !== undefined) reject("script has a shebang");
    if (script.commands.length === 0) reject("empty command");
    let env: ShellEnv = { cwd, policy };
    if (policy.commandCwd !== undefined) env = enterDirectory(env, policy.commandCwd);
    const names: string[] = [];
    visitScript(script.commands, env, names);
    return { readOnly: true, commands: names };
  } catch (error) {
    return {
      readOnly: false,
      reason: error instanceof Reject
        ? error.message
        : `analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
