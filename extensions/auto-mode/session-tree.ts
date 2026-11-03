import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type EvidenceSessionManager = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getSessionFile"
> & { buildContextEntries?: () => SessionEntry[] };

export type EnabledOverride = { value?: boolean };

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
  parentFile: string | undefined;
  enabledOverride: EnabledOverride;
};

// OMP creates an extension instance per worker, but parent links name session
// files. This process-local tree shares toggles without reading parent files.
const sessionsByFile = new Map<string, LiveSession>();

function parentSessionFile(ctx: ExtensionContext): string | undefined {
  // Pi has no agent marker. Fork headers name parents too, but are not workers.
  const agent = "agent" in ctx ? ctx.agent : undefined;
  const isSubagent = typeof agent === "object" && agent !== null &&
    "kind" in agent && agent.kind === "sub";
  return isSubagent ? ctx.sessionManager.getHeader?.()?.parentSession : undefined;
}

function liveSession(sessionFile: string | undefined): LiveSession | undefined {
  if (!sessionFile) return undefined;
  const session = sessionsByFile.get(sessionFile);
  // Session managers can switch files while an old worker is still running.
  return session?.sessionManager.getSessionFile?.() === sessionFile
    ? session
    : undefined;
}

/** Register a session's live evidence and share only its active parent's toggle. */
export function registerSession(
  ctx: ExtensionContext,
  persistedOverride: boolean | undefined,
): SessionRegistration {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  const parentFile = parentSessionFile(ctx);
  const enabledOverride = liveSession(parentFile)?.enabledOverride ??
    { value: persistedOverride };
  const session: LiveSession = {
    sessionManager: ctx.sessionManager,
    parentFile,
    enabledOverride,
  };
  if (sessionFile) sessionsByFile.set(sessionFile, session);
  return {
    enabledOverride,
    unregister() {
      // A replacement can share our toggle; registration identity owns cleanup.
      if (sessionFile && sessionsByFile.get(sessionFile) === session) {
        sessionsByFile.delete(sessionFile);
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
  let parent = liveSession(parentSessionFile(ctx));
  while (parent) {
    sources.push(evidenceSnapshot(parent.sessionManager, true));
    parent = liveSession(parent.parentFile);
  }
  sources.reverse();
  sources.push(evidenceSnapshot(ctx.sessionManager, false));
  return sources;
}
