import { basename } from "node:path";
import {
  parse,
  type ArithmeticExpression,
  type Node,
  type ParseError,
  type ParsedScript,
  type Redirect,
  type TestExpression,
  type Word,
  type WordPart,
} from "../vendor/unbash/dist/parser.js";

export type BashAnalysisError = {
  message: string;
  pos?: number;
};

export type BashRedirectAnalysis = {
  operator: Redirect["operator"];
  target?: string;
  targetDynamic: boolean;
  fileDescriptor?: number;
  variableName?: string;
  heredoc: boolean;
};

export type EffectiveCommand = {
  name?: string;
  args: string[];
  argTexts: string[];
  argTildeExpansions: boolean[];
  unresolvedTransparentDispatch: boolean;
};

export type BashCommandAnalysis = {
  raw: string;
  text: string;
  name?: string;
  words: string[];
  args: string[];
  argTexts: string[];
  effectiveCommand: EffectiveCommand;
  redirects: BashRedirectAnalysis[];
  redirectTargets: string[];
  dynamic: boolean;
  dynamicName: boolean;
  dynamicShellScript: boolean;
  pos: number;
  end: number;
};

export type BashAnalysis = {
  source: string;
  commands: BashCommandAnalysis[];
  redirects: BashRedirectAnalysis[];
  redirectTargets: string[];
  structure: string[];
  allowStructureSafe: boolean;
  errors: BashAnalysisError[];
};

export type BashParser = (source: string) => ParsedScript;

export const MAX_BASH_SOURCE_LENGTH = 1024 * 1024;
const MAX_NESTED_SHELL_DEPTH = 16;

function parseError(error: ParseError): BashAnalysisError {
  return { message: error.message, pos: error.pos };
}

function parserException(error: unknown): BashAnalysisError {
  return {
    message: `Bash parser failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function containsUnquotedBracketExpression(text: string, start: number): boolean {
  let index = start + 1;
  if (text[index] === "!" || text[index] === "^") index += 1;
  let hasMember = false;
  if (text[index] === "]") {
    hasMember = true;
    index += 1;
  }
  let quote: "'" | '"' | "$'" | undefined;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") {
          if (index + 1 < text.length) {
            hasMember = true;
            index += 1;
          }
        } else if (character === "'") quote = undefined;
        else hasMember = true;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
        else hasMember = true;
      }
      continue;
    }
    if (character === "\\") {
      if (index + 1 < text.length) {
        hasMember = true;
        index += 1;
      }
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "]") return hasMember;
    hasMember = true;
  }
  return false;
}

export function hasUnquotedPathnameExpansion(text: string): boolean {
  let quote: "'" | '"' | "$'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") index += 1;
        else if (character === "'") quote = undefined;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "*" || character === "?") return true;
    if (
      character === "[" &&
      containsUnquotedBracketExpression(text, index)
    ) {
      return true;
    }
  }
  return false;
}

function wordParts(word: Word): WordPart[] {
  return word.parts ?? [];
}

function wordIsStatic(word: Word): boolean {
  const parts = wordParts(word);
  if (parts.length === 0) return true;
  return parts.every(partIsStatic);
}

function wordHasTildeExpansion(word: Word): boolean {
  if (!word.text.startsWith("~")) return false;
  for (const character of word.text.slice(1)) {
    if (character === "/") return true;
    if (["\\", "'", '"', "$", "`"].includes(character)) return false;
  }
  return true;
}

function partIsStatic(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "DoubleQuoted":
      return part.parts.every((child) => child.type === "Literal");
    case "LocaleString":
    case "SimpleExpansion":
    case "ParameterExpansion":
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "ExtendedGlob":
    case "BraceExpansion":
      return false;
  }
}

function commandName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return basename(value).toLowerCase();
}

type CommandInvocation = {
  name?: string;
  argumentWords: Word[];
  unresolvedTransparentDispatch: boolean;
  pathnameExpandedExecutable?: Word;
};

function unwrapTransparentCommandOnce(
  name: string | undefined,
  argumentWords: Word[],
): CommandInvocation {
  if (
    name !== "command" && name !== "exec" && name !== "env" &&
    name !== "builtin"
  ) {
    return { name, argumentWords, unresolvedTransparentDispatch: false };
  }

  let index = 0;
  let optionsEnded = false;
  while (index < argumentWords.length) {
    const word = argumentWords[index];
    if (!word || !wordIsStatic(word)) {
      return {
        argumentWords: [],
        unresolvedTransparentDispatch: true,
      };
    }
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }

    if (name === "builtin" && !optionsEnded && value.startsWith("-")) {
      return { argumentWords: [], unresolvedTransparentDispatch: true };
    }

    if (name === "command" && !optionsEnded) {
      if (value === "-p") {
        index += 1;
        continue;
      }
      if (value === "-v" || value === "-V" || value.startsWith("-")) {
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
    }

    if (name === "exec" && !optionsEnded) {
      if (value === "-a") {
        const optionValue = argumentWords[index + 1];
        if (!optionValue || !wordIsStatic(optionValue)) {
          return { argumentWords: [], unresolvedTransparentDispatch: true };
        }
        index += 2;
        continue;
      }
      if (/^-[cl]+$/.test(value)) {
        index += 1;
        continue;
      }
      if (value.startsWith("-")) {
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
    }

    if (name === "env") {
      if (!optionsEnded && value.startsWith("-")) {
        if (
          value === "-i" ||
          value === "--ignore-environment" ||
          value === "-0" ||
          value === "--null" ||
          value === "-v" ||
          value === "--debug"
        ) {
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(value)) {
          const optionValue = argumentWords[index + 1];
          if (!optionValue || !wordIsStatic(optionValue)) {
            return { argumentWords: [], unresolvedTransparentDispatch: true };
          }
          index += 2;
          continue;
        }
        if (value.startsWith("--unset=") || value.startsWith("--chdir=")) {
          index += 1;
          continue;
        }
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
      if (/^[^=]+=/.test(value)) {
        index += 1;
        continue;
      }
    }

    if (hasUnquotedPathnameExpansion(word.text)) {
      return {
        argumentWords: [],
        unresolvedTransparentDispatch: true,
        pathnameExpandedExecutable: word,
      };
    }

    return {
      name: commandName(value),
      argumentWords: argumentWords.slice(index + 1),
      unresolvedTransparentDispatch: false,
    };
  }

  return { argumentWords: [], unresolvedTransparentDispatch: true };
}

function effectiveCommandInvocation(
  name: string | undefined,
  argumentWords: Word[],
): CommandInvocation {
  let invocation: CommandInvocation = {
    name,
    argumentWords,
    unresolvedTransparentDispatch: false,
  };
  for (let depth = 0; depth < MAX_NESTED_SHELL_DEPTH; depth += 1) {
    const next = unwrapTransparentCommandOnce(
      invocation.name,
      invocation.argumentWords,
    );
    if (next.unresolvedTransparentDispatch) return next;
    if (
      next.name === invocation.name &&
      next.argumentWords === invocation.argumentWords
    ) {
      return next;
    }
    invocation = next;
  }
  return { argumentWords: [], unresolvedTransparentDispatch: true };
}

type NestedShell = {
  name?: string;
  source?: string;
  hasScriptArgument: boolean;
};

function nestedShell(invocation: CommandInvocation): NestedShell | undefined {
  if (invocation.unresolvedTransparentDispatch) {
    return { hasScriptArgument: true };
  }
  if (invocation.name === "eval") {
    return {
      name: "eval",
      source:
        invocation.argumentWords.length > 0 &&
          invocation.argumentWords.every(wordIsStatic)
        ? invocation.argumentWords.map((word) => word.value).join(" ")
        : undefined,
      hasScriptArgument: invocation.argumentWords.length > 0,
    };
  }
  if (invocation.name !== "bash" && invocation.name !== "sh") {
    return undefined;
  }
  const commandOptionIndex = invocation.argumentWords.findIndex((word) =>
    /^-[^-]*c/.test(word.value)
  );
  if (commandOptionIndex < 0) return undefined;
  const scriptWord = invocation.argumentWords[commandOptionIndex + 1];
  return {
    name: invocation.name,
    source: scriptWord && wordIsStatic(scriptWord) ? scriptWord.value : undefined,
    hasScriptArgument: true,
  };
}

function exhaustiveNode(_node: never): never {
  throw new Error(`Unsupported unbash AST node: ${JSON.stringify(_node)}`);
}

/** Analyze Bash tool input or permission-pattern text without executing it. */
export function analyzeBash(
  source: string,
  parser: BashParser = parse,
  sourceKind: "command" | "permission-pattern" = "command",
): BashAnalysis {
  const analysis: BashAnalysis = {
    source,
    commands: [],
    redirects: [],
    redirectTargets: [],
    structure: [],
    allowStructureSafe: true,
    errors: [],
  };
  if (source.length > MAX_BASH_SOURCE_LENGTH) {
    analysis.errors.push({
      message:
        `Bash input length ${source.length} exceeds ${MAX_BASH_SOURCE_LENGTH}`,
    });
    return analysis;
  }

  function analyzeRedirect(redirect: Redirect): BashRedirectAnalysis {
    return {
      operator: redirect.operator,
      target: redirect.target?.value,
      targetDynamic: !!redirect.target && !wordIsStatic(redirect.target),
      fileDescriptor: redirect.fileDescriptor,
      variableName: redirect.variableName,
      heredoc: redirect.operator === "<<" || redirect.operator === "<<-",
    };
  }

  function visitRedirect(
    redirect: Redirect,
    currentSource: string,
    depth: number,
  ): string | undefined {
    const redirectAnalysis = analyzeRedirect(redirect);
    analysis.redirects.push(redirectAnalysis);
    analysis.structure.push(
      `redirect:${redirect.fileDescriptor ?? ""}:${redirect.variableName ?? ""}:${redirect.operator}:${redirectAnalysis.heredoc ? "heredoc" : "file"}`,
    );
    if (redirect.target) visitWord(redirect.target, currentSource, depth);
    if (redirect.body) visitWord(redirect.body, currentSource, depth);
    const target = redirect.target?.value;
    if (target) analysis.redirectTargets.push(target);
    return target;
  }

  function visitPart(
    part: WordPart,
    currentSource: string,
    depth: number,
  ): void {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        if (part.value.includes("\0")) {
          analysis.errors.push({
            message: "Decoded NUL in a Bash word part is unsupported",
          });
        }
        return;
      case "SimpleExpansion":
        return;
      case "DoubleQuoted":
      case "LocaleString":
        for (const child of part.parts) visitPart(child, currentSource, depth);
        return;
      case "ParameterExpansion":
        for (const indexPart of part.indexParts ?? []) {
          visitPart(indexPart, currentSource, depth);
        }
        if (part.operand) visitWord(part.operand, currentSource, depth);
        if (part.slice) {
          visitWord(part.slice.offset, currentSource, depth);
          if (part.slice.length) {
            visitWord(part.slice.length, currentSource, depth);
          }
        }
        if (part.replace) {
          visitWord(part.replace.pattern, currentSource, depth);
          visitWord(part.replace.replacement, currentSource, depth);
        }
        return;
      case "CommandExpansion":
      case "ProcessSubstitution":
        analysis.structure.push(
          `part:${part.type}:${part.type === "ProcessSubstitution" ? part.operator : ""}`,
        );
        if (part.script) {
          visitScript(part.script, part.script.source ?? currentSource, depth);
        }
        return;
      case "ArithmeticExpansion":
        if (part.expression) {
          visitArithmetic(part.expression, currentSource, depth);
        }
        return;
      case "ExtendedGlob":
      case "BraceExpansion":
        for (const nestedPart of part.parts ?? []) {
          visitPart(nestedPart, currentSource, depth);
        }
        return;
    }
  }

  function visitWord(word: Word, currentSource: string, depth: number): void {
    if (word.value.includes("\0")) {
      analysis.errors.push({
        message: "Decoded NUL in a Bash word is unsupported",
        pos: word.pos,
      });
      return;
    }
    for (const part of wordParts(word)) {
      visitPart(part, currentSource, depth);
    }
  }

  function visitArithmetic(
    expression: ArithmeticExpression,
    currentSource: string,
    depth: number,
  ): void {
    switch (expression.type) {
      case "ArithmeticBinary":
        visitArithmetic(expression.left, currentSource, depth);
        visitArithmetic(expression.right, currentSource, depth);
        return;
      case "ArithmeticUnary":
        visitArithmetic(expression.operand, currentSource, depth);
        return;
      case "ArithmeticTernary":
        visitArithmetic(expression.test, currentSource, depth);
        visitArithmetic(expression.consequent, currentSource, depth);
        visitArithmetic(expression.alternate, currentSource, depth);
        return;
      case "ArithmeticGroup":
        visitArithmetic(expression.expression, currentSource, depth);
        return;
      case "ArithmeticWord":
        for (const part of expression.parts ?? []) {
          visitPart(part, currentSource, depth);
        }
        return;
      case "ArithmeticCommandExpansion":
        analysis.structure.push("part:ArithmeticCommandExpansion");
        if (expression.script) {
          visitScript(
            expression.script,
            expression.script.source ?? currentSource,
            depth,
          );
        }
        return;
    }
  }

  function visitTest(
    expression: TestExpression,
    currentSource: string,
    depth: number,
  ): void {
    switch (expression.type) {
      case "TestUnary":
        visitWord(expression.operand, currentSource, depth);
        return;
      case "TestBinary":
        visitWord(expression.left, currentSource, depth);
        visitWord(expression.right, currentSource, depth);
        return;
      case "TestLogical":
        visitTest(expression.left, currentSource, depth);
        visitTest(expression.right, currentSource, depth);
        return;
      case "TestNot":
        visitTest(expression.operand, currentSource, depth);
        return;
      case "TestGroup":
        visitTest(expression.expression, currentSource, depth);
        return;
    }
  }

  function nodeStructureToken(node: Node): string {
    switch (node.type) {
      case "Command":
        return `node:Command:${node.prefix.length}:${node.redirects.length}`;
      case "Pipeline":
        return `node:Pipeline:${node.negated ? "negated" : "plain"}:${node.time ? "time" : "plain"}:${node.operators.join(",")}`;
      case "AndOr":
        return `node:AndOr:${node.operators.join(",")}`;
      case "If":
        return `node:If:${node.else?.type ?? "none"}`;
      case "For":
      case "Select":
        return `node:${node.type}:${node.wordlist.length}`;
      case "ArithmeticFor":
        return `node:ArithmeticFor:${node.initialize ? 1 : 0}:${node.test ? 1 : 0}:${node.update ? 1 : 0}`;
      case "While":
        return `node:While:${node.kind}`;
      case "Function":
        return `node:Function:${node.redirects.length}`;
      case "Subshell":
      case "BraceGroup":
      case "TestCommand":
      case "ArithmeticCommand":
        return `node:${node.type}`;
      case "CompoundList":
        return `node:CompoundList:${node.commands.length}`;
      case "Case":
        return `node:Case:${node.items.map((item) => item.terminator ?? "none").join(",")}`;
      case "Coproc":
        return `node:Coproc:${node.redirects.length}`;
      case "Statement":
        return `node:Statement:${node.background ? "background" : "foreground"}:${node.redirects.length}`;
      default:
        return exhaustiveNode(node);
    }
  }

  function visitNode(node: Node, nodeSource: string, depth: number): void {
    analysis.structure.push(nodeStructureToken(node));
    if (
      node.type === "For" ||
      node.type === "Select" ||
      node.type === "ArithmeticFor" ||
      node.type === "Function" ||
      node.type === "Case" ||
      node.type === "Coproc" ||
      node.type === "TestCommand" ||
      node.type === "ArithmeticCommand"
    ) {
      analysis.allowStructureSafe = false;
    }
    switch (node.type) {
      case "Command": {
        const prefixWords = node.prefix.map((prefix) => prefix.text);
        const commandWords = node.name ? [node.name, ...node.suffix] : node.suffix;
        const renderedWords = [
          ...prefixWords,
          ...commandWords.map((word) => word.text),
        ];
        const values = [
          ...prefixWords,
          ...commandWords.map((word) => word.value),
        ];
        const redirects = node.redirects.map(analyzeRedirect);
        const redirectTargets = redirects
          .map((redirect) => redirect.target)
          .filter((target): target is string => !!target);
        const pathnameExpandedName = node.name &&
          hasUnquotedPathnameExpansion(node.name.text) ? node.name : undefined;
        const normalizedName = pathnameExpandedName
          ? undefined
          : commandName(node.name?.value);
        const invocation: CommandInvocation = pathnameExpandedName
          ? {
            argumentWords: [],
            unresolvedTransparentDispatch: true,
            pathnameExpandedExecutable: pathnameExpandedName,
          }
          : effectiveCommandInvocation(normalizedName, node.suffix);
        if (
          invocation.pathnameExpandedExecutable &&
          sourceKind === "command"
        ) {
          analysis.errors.push({
            message:
              "Executable pathname expansion cannot be resolved for deterministic safety checks",
            pos: invocation.pathnameExpandedExecutable.pos,
          });
        }
        const wrapper = nestedShell(invocation);
        const wrapperSource = wrapper?.source;
        analysis.commands.push({
          raw: nodeSource.slice(node.pos, node.end),
          text: renderedWords.join(" "),
          name: normalizedName,
          words: values,
          args: node.suffix.map((word) => word.value),
          argTexts: node.suffix.map((word) => word.text),
          effectiveCommand: {
            name: invocation.name,
            args: invocation.argumentWords.map((word) => word.value),
            argTexts: invocation.argumentWords.map((word) => word.text),
            argTildeExpansions:
              invocation.argumentWords.map(wordHasTildeExpansion),
            unresolvedTransparentDispatch:
              invocation.unresolvedTransparentDispatch,
          },
          redirects,
          redirectTargets,
          dynamic: !!pathnameExpandedName ||
            commandWords.some((word) => !wordIsStatic(word)),
          dynamicName: !!pathnameExpandedName ||
            (!!node.name && !wordIsStatic(node.name)),
          dynamicShellScript:
            !!wrapper?.hasScriptArgument && wrapperSource === undefined,
          pos: node.pos,
          end: node.end,
        });

        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth);
        }
        if (node.name) visitWord(node.name, nodeSource, depth);
        for (const prefix of node.prefix) {
          if (prefix.value) visitWord(prefix.value, nodeSource, depth);
          for (const word of prefix.array ?? []) {
            visitWord(word, nodeSource, depth);
          }
          for (const part of prefix.indexParts ?? []) {
            visitPart(part, nodeSource, depth);
          }
        }
        for (const word of node.suffix) visitWord(word, nodeSource, depth);

        if (wrapperSource !== undefined) {
          analysis.structure.push(`wrapper:${wrapper?.name ?? normalizedName}`);
          if (depth >= MAX_NESTED_SHELL_DEPTH) {
            analysis.errors.push({
              message: `Nested shell depth exceeds ${MAX_NESTED_SHELL_DEPTH}`,
            });
          } else {
            try {
              visitScript(parser(wrapperSource), wrapperSource, depth + 1);
            } catch (error) {
              analysis.errors.push(parserException(error));
            }
          }
        }
        return;
      }
      case "Pipeline":
      case "AndOr":
        for (const command of node.commands) visitNode(command, nodeSource, depth);
        return;
      case "If":
        visitNode(node.clause, nodeSource, depth);
        visitNode(node.then, nodeSource, depth);
        if (node.else) visitNode(node.else, nodeSource, depth);
        return;
      case "For":
      case "Select":
        visitWord(node.name, nodeSource, depth);
        for (const word of node.wordlist) {
          visitWord(word, nodeSource, depth);
        }
        visitNode(node.body, nodeSource, depth);
        return;
      case "ArithmeticFor":
        if (node.initialize) visitArithmetic(node.initialize, nodeSource, depth);
        if (node.test) visitArithmetic(node.test, nodeSource, depth);
        if (node.update) visitArithmetic(node.update, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "While":
        visitNode(node.clause, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "Function":
        visitWord(node.name, nodeSource, depth);
        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth);
        }
        visitNode(node.body, nodeSource, depth);
        return;
      case "Subshell":
      case "BraceGroup":
        visitNode(node.body, nodeSource, depth);
        return;
      case "CompoundList":
        for (const statement of node.commands) {
          visitNode(statement, nodeSource, depth);
        }
        return;
      case "Case":
        visitWord(node.word, nodeSource, depth);
        for (const item of node.items) {
          for (const pattern of item.pattern) {
            visitWord(pattern, nodeSource, depth);
          }
          visitNode(item.body, nodeSource, depth);
        }
        return;
      case "Coproc":
        if (node.name) visitWord(node.name, nodeSource, depth);
        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth);
        }
        visitNode(node.body, nodeSource, depth);
        return;
      case "TestCommand":
        visitTest(node.expression, nodeSource, depth);
        return;
      case "ArithmeticCommand":
        if (node.expression) {
          visitArithmetic(node.expression, nodeSource, depth);
        }
        return;
      case "Statement":
        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth);
        }
        visitNode(node.command, nodeSource, depth);
        return;
      default:
        exhaustiveNode(node);
    }
  }

  function visitScript(
    script: ParsedScript,
    scriptSource: string,
    depth: number,
  ): void {
    analysis.structure.push(`script:${script.commands.length}`);
    for (const error of script.errors ?? []) analysis.errors.push(parseError(error));
    for (const statement of script.commands) {
      visitNode(statement, scriptSource, depth);
    }
  }

  try {
    visitScript(parser(source), source, 0);
  } catch (error) {
    analysis.errors.push(parserException(error));
  }

  return analysis;
}
