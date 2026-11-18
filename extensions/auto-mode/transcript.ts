import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEvidenceSources, type SessionEvidenceSource } from "./session-tree.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const MAX_USER_ENTRY_TOKENS = 1000;
const MAX_TOOL_ENTRY_TOKENS = 1000;
const MAX_RECENT_TOOL_ENTRIES = 40;
const CHARS_PER_APPROX_TOKEN = 4;

type TranscriptEntry = {
  index: number;
  order: number;
  timestamp?: number;
  kind: "user" | "delegation" | "tool";
  text: string;
};

export type ClassifierTranscriptBudgets = {
  maxUserTokens: number;
  maxToolTokens: number;
};

/** Session entry holding user answers captured from OMP's built-in ask tool. */
export const ASK_ANSWER_ENTRY = "pi-automode-ask-answer";

export type AskAnswer = { question: string; answer: string };

type AskAnswerEntry = { toolCallId: string; answers: AskAnswer[] };

type AskQuestionResult = {
  question: string;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
};

function isAskQuestionResult(value: unknown): value is AskQuestionResult {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "question" in value && typeof value.question === "string" &&
    "selectedOptions" in value && Array.isArray(value.selectedOptions) &&
    value.selectedOptions.every((option) => typeof option === "string") &&
    (!("customInput" in value) || value.customInput === undefined ||
      typeof value.customInput === "string") &&
    (!("note" in value) || value.note === undefined || typeof value.note === "string") &&
    (!("timedOut" in value) || value.timedOut === undefined ||
      typeof value.timedOut === "boolean");
}

function isAskAnswer(value: unknown): value is AskAnswer {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "question" in value && typeof value.question === "string" &&
    "answer" in value && typeof value.answer === "string";
}

function isAskAnswerEntry(value: unknown): value is AskAnswerEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "toolCallId" in value && typeof value.toolCallId === "string" &&
    value.toolCallId.length > 0 &&
    "answers" in value && Array.isArray(value.answers) && value.answers.length > 0 &&
    value.answers.every(isAskAnswer);
}

function askAnswer(result: unknown): AskAnswer[] {
  // OMP picks an option itself when an ask times out; that is not user consent.
  if (!isAskQuestionResult(result) || result.timedOut === true) return [];
  const parts: string[] = [];
  if (result.selectedOptions.length > 0) parts.push(result.selectedOptions.join(", "));
  if (result.customInput?.trim()) parts.push(`custom answer: ${result.customInput.trim()}`);
  if (result.note?.trim()) parts.push(`note: ${result.note.trim()}`);
  return parts.length > 0 ? [{ question: result.question, answer: parts.join("; ") }] : [];
}

/** Extract the answers a user gave in an OMP ask result's structured details. */
export function askAnswersFromDetails(details: unknown): AskAnswer[] {
  if (
    typeof details === "object" && details !== null && !Array.isArray(details) &&
    "results" in details && Array.isArray(details.results)
  ) {
    return details.results.flatMap(askAnswer);
  }
  return askAnswer(details);
}

function capturedAskAnswers(source: SessionEvidenceSource): Map<string, AskAnswer[]> {
  const captured = new Map<string, AskAnswer[]>();
  for (const entry of source.branchEntries) {
    if (
      entry.type === "custom" && entry.customType === ASK_ANSWER_ENTRY &&
      isAskAnswerEntry(entry.data)
    ) {
      captured.set(entry.data.toolCallId, entry.data.answers);
    }
  }
  return captured;
}

function flattenUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function collectAssistantToolCalls(content: unknown): Array<{
  name: string;
  input: unknown;
}> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (
        block,
      ): block is {
        type: string;
        name?: string;
        arguments?: unknown;
        input?: unknown;
      } => !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "toolCall" || block.type === "tool_use")
    .map((block) => ({
      name: String(block.name ?? "tool"),
      input: "arguments" in block ? block.arguments : block.input,
    }));
}

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

function truncateToTokenCap(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (approximateTokenCount(text) <= maxTokens) {
    return { text, truncated: false };
  }
  const maxCharacters = Math.max(1, maxTokens * CHARS_PER_APPROX_TOKEN);
  const omittedTokens = Math.max(
    1,
    approximateTokenCount(text) - maxTokens,
  );
  const marker = `<truncated approx_tokens="${omittedTokens}" />`;
  if (marker.length >= maxCharacters) {
    return { text: marker.slice(0, maxCharacters), truncated: true };
  }

  const retainedCharacters = maxCharacters - marker.length;
  const prefixCharacters = Math.ceil(retainedCharacters * 0.65);
  const suffixCharacters = retainedCharacters - prefixCharacters;
  return {
    text: `${text.slice(0, prefixCharacters)}${marker}${
      suffixCharacters > 0 ? text.slice(-suffixCharacters) : ""
    }`,
    truncated: true,
  };
}

function finiteTimestamp(value: unknown): number | undefined {
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : undefined;
  return timestamp !== undefined && Number.isFinite(timestamp)
    ? timestamp
    : undefined;
}

function collectTranscriptEntries(
  source: SessionEvidenceSource,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const askAnswers = capturedAskAnswers(source);

  for (const [index, entry] of source.contextEntries.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      attribution?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
      timestamp?: unknown;
    };
    const timestamp = finiteTimestamp(message.timestamp) ??
      finiteTimestamp(entry.timestamp);
    if (message.role === "user") {
      const kind = message.attribution === "agent"
        ? "delegation"
        : message.attribution === undefined || message.attribution === "user"
        ? "user"
        : undefined;
      const text = flattenUserContent(message.content).trim();
      if (text && kind && (!source.inherited || kind === "user")) {
        entries.push({ index, order: 0, timestamp, kind, text });
      }
      continue;
    }
    // Tool output stays excluded. A captured ask answer counts only while its
    // result remains in context, so branches and compaction drop it too.
    if (message.role === "toolResult") {
      const answers = message.toolName === "ask" && message.isError !== true &&
          typeof message.toolCallId === "string"
        ? askAnswers.get(message.toolCallId) ?? []
        : [];
      for (const [order, { question, answer }] of answers.entries()) {
        entries.push({
          index,
          order,
          timestamp,
          kind: "user",
          text: `Answered ask question "${question}": ${answer}`,
        });
      }
      continue;
    }
    if (source.inherited || message.role !== "assistant") continue;

    for (const [order, toolCall] of collectAssistantToolCalls(
      message.content,
    ).entries()) {
      entries.push({
        index,
        order,
        timestamp,
        kind: "tool",
        text: `${toolCall.name}: ${safeJson(toolCall.input, 8000)}`,
      });
    }
  }

  return entries;
}

function selectUserEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const users = entries.filter((entry) => entry.kind !== "tool");
  if (users.length === 0) return { selected: [], omitted: false };

  const humans = users.flatMap((entry, index) =>
    entry.kind === "user" ? [index] : []
  );
  const anchors = new Set([
    humans.at(-1),
    humans[0],
    users.length - 1,
    0,
  ].filter((index): index is number => index !== undefined));
  const priorityAnchors = humans.length > 0
    ? new Set([humans.at(-1)!, humans[0]!])
    : anchors;
  const anchorShare = Math.min(
    MAX_USER_ENTRY_TOKENS,
    Math.floor(maxTokens / priorityAnchors.size),
  );
  const reservations = new Map(
    [...priorityAnchors].map((index) => [
      index,
      Math.min(anchorShare, approximateTokenCount(users[index]!.text)),
    ]),
  );
  let reservedTokens = [...reservations.values()].reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
  const selectedEntries = new Map<number, TranscriptEntry>();
  let usedTokens = 0;
  let truncated = false;

  const include = (index: number, reserved = 0): void => {
    if (selectedEntries.has(index)) return;
    const entry = users[index];
    if (!entry) return;
    const available = maxTokens - usedTokens - reserved;
    if (available <= 0) return;
    const result = truncateToTokenCap(
      entry.text,
      Math.min(MAX_USER_ENTRY_TOKENS, available),
    );
    selectedEntries.set(index, { ...entry, text: result.text });
    usedTokens += approximateTokenCount(result.text);
    truncated ||= result.truncated;
  };

  // Keep human approvals and revocations ahead of delegated task text when
  // a small budget cannot retain every intent anchor.
  for (const index of anchors) {
    reservedTokens -= reservations.get(index) ?? 0;
    include(index, reservedTokens);
  }
  for (let index = users.length - 2; index > 0; index -= 1) {
    include(index);
  }

  return {
    selected: [...selectedEntries.values()],
    omitted: selectedEntries.size < users.length || truncated,
  };
}

function selectToolEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const tools = entries.filter((entry) => entry.kind === "tool");
  const selected: TranscriptEntry[] = [];
  let usedTokens = 0;

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RECENT_TOOL_ENTRIES) break;
    const entry = tools[index];
    if (!entry) continue;
    const truncated = truncateToTokenCap(
      entry.text,
      Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens),
    );
    const tokens = approximateTokenCount(truncated.text);
    if (usedTokens + tokens > maxTokens) continue;
    selected.push({ ...entry, text: truncated.text });
    usedTokens += tokens;
  }

  selected.reverse();
  return {
    selected,
    omitted: selected.length < tools.length || tools.some((entry) =>
      approximateTokenCount(entry.text) >
        Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens)
    ),
  };
}

function mergeTranscriptSources(sources: TranscriptEntry[][]): TranscriptEntry[] {
  const positions = sources.map(() => 0);
  const merged: TranscriptEntry[] = [];
  while (true) {
    let nextSource = -1;
    let nextEntry: TranscriptEntry | undefined;
    for (const [sourceIndex, entries] of sources.entries()) {
      const entry = entries[positions[sourceIndex]!];
      if (!entry) continue;
      // Undated heads use root-to-leaf source order, before dated heads.
      if (entry.timestamp === undefined) {
        nextSource = sourceIndex;
        nextEntry = entry;
        break;
      }
      if (!nextEntry || entry.timestamp < nextEntry.timestamp!) {
        nextSource = sourceIndex;
        nextEntry = entry;
      }
    }
    if (!nextEntry) return merged;
    positions[nextSource]! += 1;
    nextEntry.index = merged.length;
    merged.push(nextEntry);
  }
}

/** Retain human intent from live parents without promoting delegated tasks to consent. */
export function buildClassifierTranscript(
  ctx: ExtensionContext,
  budgets: ClassifierTranscriptBudgets,
): string {
  // Only source heads compete by time; branch order wins over clock regressions.
  const entries = mergeTranscriptSources(
    sessionEvidenceSources(ctx).map((source) => collectTranscriptEntries(source)),
  );
  const users = selectUserEntries(entries, budgets.maxUserTokens);
  const tools = selectToolEntries(entries, budgets.maxToolTokens);
  const selected = [...users.selected, ...tools.selected].sort(
    (left, right) => left.index - right.index || left.order - right.order,
  );
  const records = selected.map((entry) =>
    JSON.stringify({ kind: entry.kind, content: entry.text })
  );
  if (users.omitted || tools.omitted) {
    records.push(JSON.stringify({ kind: "omitted" }));
  }
  return records.join("\n");
}

export function loadedContextFromSystemPromptOptions(options: unknown): string {
  const contextFiles = (
    options as
      | { contextFiles?: Array<{ path?: string; content?: string }> }
      | undefined
  )?.contextFiles;
  if (!Array.isArray(contextFiles)) return "";
  return contextFiles
    .map(
      (file) =>
        `# ${file.path ?? "context"}\n${
          truncateMiddle(file.content ?? "", 4000)
        }`,
    )
    .join("\n\n");
}
