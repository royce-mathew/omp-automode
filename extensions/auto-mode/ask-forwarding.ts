import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Dialog title in a session that asks its own user. */
export const ASK_DIALOG_TITLE = "Auto mode permission ask";

/**
 * How long a forwarded dialog stays open. OMP gives a `tool_call` handler 30 s
 * of active work (`extensionHandlers.toolCallTimeoutMs`) and does not pause
 * that budget for a dialog in another session's UI. Past the budget the
 * subagent's call has already failed, so a late answer would go nowhere and
 * the dialog would only hold the parent's input focus.
 */
export const FORWARDED_ASK_TIMEOUT_MS = 25_000;

/**
 * A live session of this process. Subagents look their ancestors up here to
 * ask a question they cannot show themselves.
 */
export type SessionRecord = {
  /** `ctx.agent.id`; undefined where the host has no agent identity (Pi). */
  agentId: string | undefined;
  hasUI: boolean;
  ui: ExtensionContext["ui"];
  /** Session file or id the session header names as parent; subagents only. */
  parent: string | undefined;
};

// Module globals are shared by every session in the process, as with the
// `/automode on|off` override. A session is registered under its file and its
// id because a task subagent's header names its parent by file while a `/tan`
// clone's header names it by id.
const sessionsByKey = new Map<string, SessionRecord>();

function sessionKeys(ctx: ExtensionContext): string[] {
  const keys = [
    ctx.sessionManager.getSessionFile?.(),
    ctx.sessionManager.getSessionId?.(),
  ];
  return keys.filter((key): key is string => typeof key === "string" && key !== "");
}

function agentOf(ctx: ExtensionContext): { kind?: unknown; id?: unknown } | undefined {
  const agent = "agent" in ctx ? ctx.agent : undefined;
  return typeof agent === "object" && agent !== null ? agent : undefined;
}

/** The asking agent's name, when the host provides one. */
export function agentIdOf(ctx: ExtensionContext): string | undefined {
  const id = agentOf(ctx)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The parent named by the session header. Pi has no subagents and no `agent`
 * field, and forks and `/new` sessions also name a parent, so only OMP's
 * subagent marker counts.
 */
function parentOf(ctx: ExtensionContext): string | undefined {
  return agentOf(ctx)?.kind === "sub"
    ? ctx.sessionManager.getHeader?.()?.parentSession
    : undefined;
}

/** Make a starting session findable by its subagents. */
export function registerAskSession(ctx: ExtensionContext): SessionRecord {
  const record: SessionRecord = {
    agentId: agentIdOf(ctx),
    hasUI: ctx.hasUI,
    ui: ctx.ui,
    parent: parentOf(ctx),
  };
  for (const key of sessionKeys(ctx)) {
    sessionsByKey.set(key, record);
  }
  return record;
}

/** Unregister a shutting-down session so its subagents stop asking it. */
export function releaseAskSession(ctx: ExtensionContext, record: SessionRecord): void {
  for (const key of sessionKeys(ctx)) {
    // Only drop our own record; another session may have claimed this key since.
    if (sessionsByKey.get(key) === record) {
      sessionsByKey.delete(key);
    }
  }
}

/**
 * The nearest ancestor session with a UI. A parent that this process does not
 * know, or a chain that ends without a UI, yields `undefined`, and the caller
 * blocks.
 */
export function findAskingAncestor(ctx: ExtensionContext): SessionRecord | undefined {
  const visited = new Set<string>();
  let key = parentOf(ctx);
  while (key !== undefined && !visited.has(key)) {
    visited.add(key);
    const record = sessionsByKey.get(key);
    if (!record || record.hasUI) {
      return record;
    }
    key = record.parent;
  }
  return undefined;
}

/** Title of a dialog shown in an ancestor's UI on behalf of a subagent. */
export function forwardedAskTitle(agentId: string | undefined): string {
  return `${ASK_DIALOG_TITLE} from ${agentId ?? "a subagent"}`;
}

export function askDialogMessage(rule: string, action: string): string {
  return `Rule: ${rule}\n\nAction:\n${action}\n\nAllow this action to continue to auto-mode classification?`;
}

/** Message of a forwarded dialog; tells the user how long the subagent waits. */
export function forwardedAskMessage(rule: string, action: string): string {
  return `${askDialogMessage(rule, action)}\n\nThe asking agent waits ${FORWARDED_ASK_TIMEOUT_MS / 1000} seconds for an answer.`;
}

/** Classifier note for a `permissions.ask` match that no user was asked about. */
export function headlessAskNote(rule: string): string {
  return `A permissions.ask rule (${rule}) matched this action, but this session has no interactive UI, so no user approved it. The user marked actions like this as needing approval. Block it when the policy leaves any doubt.`;
}
