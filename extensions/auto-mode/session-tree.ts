import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type EvidenceSessionManager = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getSessionFile" | "getSessionId"
> & { buildContextEntries?: () => SessionEntry[] };

/**
 * The `/automode on|off` choice for a main session and every subagent it
 * spawns. `value` stays undefined until the user picks one, so the configured
 * `enabled` applies.
 */
export type EnabledOverride = {
  value?: boolean;
  /** Session that created this object. Any other session holding it inherited the choice. */
  owner?: string;
};

export type SessionEvidenceSource = {
  contextEntries: readonly SessionEntry[];
  branchEntries: readonly SessionEntry[];
  inherited: boolean;
};

export type SessionRegistration = {
  enabledOverride: EnabledOverride;
  unregister(): void;
};

type LiveSession = {
  sessionManager: EvidenceSessionManager;
  parentKey: string | undefined;
  enabledOverride: EnabledOverride;
};

// OMP creates an extension instance per worker, but parent links name session
// files (task subagents) or session ids (`/tan` clones). This process-local
// tree shares toggles without reading parent files.
const sessionsByKey = new Map<string, LiveSession>();

function sessionKeys(sessionManager: EvidenceSessionManager): string[] {
  return [sessionManager.getSessionFile?.(), sessionManager.getSessionId?.()]
    .filter((key): key is string => typeof key === "string" && key !== "");
}

function parentSessionKey(ctx: ExtensionContext): string | undefined {
  // Pi has no agent marker. Fork headers name parents too, but are not workers.
  const agent = "agent" in ctx ? ctx.agent : undefined;
  const isSubagent = typeof agent === "object" && agent !== null &&
    "kind" in agent && agent.kind === "sub";
  return isSubagent ? ctx.sessionManager.getHeader?.()?.parentSession : undefined;
}

function liveSession(key: string | undefined): LiveSession | undefined {
  if (!key) return undefined;
  const session = sessionsByKey.get(key);
  // Session managers can switch files while an old worker is still running.
  return session && sessionKeys(session.sessionManager).includes(key)
    ? session
    : undefined;
}

/** Register a session's live evidence and share only its active parent's toggle. */
export function registerSession(
  ctx: ExtensionContext,
  persistedOverride: boolean | undefined,
): SessionRegistration {
  const keys = sessionKeys(ctx.sessionManager);
  const parentKey = parentSessionKey(ctx);
  const enabledOverride = liveSession(parentKey)?.enabledOverride ??
    { value: persistedOverride, owner: ctx.sessionManager.getSessionId?.() };
  const session: LiveSession = {
    sessionManager: ctx.sessionManager,
    parentKey,
    enabledOverride,
  };
  for (const key of keys) sessionsByKey.set(key, session);
  return {
    enabledOverride,
    unregister() {
      // A replacement can share our toggle; registration identity owns cleanup.
      for (const key of keys) {
        if (sessionsByKey.get(key) === session) sessionsByKey.delete(key);
      }
    },
  };
}

function evidenceSnapshot(
  sessionManager: EvidenceSessionManager,
  inherited: boolean,
): SessionEvidenceSource {
  const branchEntries = sessionManager.getBranch();
  return {
    contextEntries: sessionManager.buildContextEntries?.() ?? branchEntries,
    branchEntries,
    inherited,
  };
}

/** Read current evidence without exposing live parent contexts to consumers. */
export function sessionEvidenceSources(ctx: ExtensionContext): SessionEvidenceSource[] {
  const sources: SessionEvidenceSource[] = [];
  // Headers are session data; a parent link that loops back must not hang the hook.
  const visited = new Set<EvidenceSessionManager>([ctx.sessionManager]);
  let parent = liveSession(parentSessionKey(ctx));
  while (parent && !visited.has(parent.sessionManager)) {
    visited.add(parent.sessionManager);
    sources.push(evidenceSnapshot(parent.sessionManager, true));
    parent = liveSession(parent.parentKey);
  }
  sources.reverse();
  sources.push(evidenceSnapshot(ctx.sessionManager, false));
  return sources;
}
