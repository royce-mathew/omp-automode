import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DENIAL_HISTORY_LIMIT } from "./constants.ts";
import type { AutoModeState, DenialRecord, EffectiveConfig } from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

/** Session entry holding counters, recent denials, and the `/automode on|off` choice. */
export const STATE_ENTRY = "pi-automode-state";

/**
 * The `/automode on|off` choice for a main session and every subagent it
 * spawns. `value` stays undefined until the user picks one, so the configured
 * `enabled` applies.
 */
export type EnabledOverride = { value?: boolean };

// OMP runs the extension factory again for each subagent, so closure state is
// per session and a subagent would otherwise keep blocking after the user ran
// `/automode off` in the main session. Module globals are shared by every
// session in the process. Keyed by session file because that is what a
// subagent's session header names as its parent.
const enabledOverrideBySessionFile = new Map<string, EnabledOverride>();

/**
 * Bind a starting session to its agent tree's override. An OMP subagent shares
 * its parent's live object, so toggling in the main session reaches subagents
 * that are already running. Main sessions, forks, and subagents whose parent
 * is not in this process start from their own persisted choice.
 *
 * In-memory (`--no-session`) parents have no session file to link by; their
 * subagents keep the configured `enabled`, which fails closed.
 */
export function bindEnabledOverride(
  ctx: ExtensionContext,
  persisted: boolean | undefined,
): EnabledOverride {
  // Pi has no subagents and no `agent` field. Forks and `/new` sessions also
  // name a parent session, so only OMP's subagent marker may inherit.
  const agent = "agent" in ctx ? ctx.agent : undefined;
  const isSubagent = typeof agent === "object" && agent !== null &&
    "kind" in agent && agent.kind === "sub";
  const parentFile = isSubagent
    ? ctx.sessionManager.getHeader?.()?.parentSession
    : undefined;
  const override = (parentFile ? enabledOverrideBySessionFile.get(parentFile) : undefined) ??
    { value: persisted };
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (sessionFile) enabledOverrideBySessionFile.set(sessionFile, override);
  return override;
}

/** Unlink a shutting-down session so later sessions cannot adopt its override. */
export function releaseEnabledOverride(
  ctx: ExtensionContext,
  override: EnabledOverride,
): void {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  // Only drop our own binding; another session may have bound this file since.
  if (sessionFile && enabledOverrideBySessionFile.get(sessionFile) === override) {
    enabledOverrideBySessionFile.delete(sessionFile);
  }
}

export function pushDenial(state: AutoModeState, denial: DenialRecord): void {
  state.recentDenials = [
    ...state.recentDenials.slice(-(DENIAL_HISTORY_LIMIT - 1)),
    denial,
  ];
}

/** `config` is the effective config, with any `/automode on|off` choice applied. */
export function statusLine(
  config: EffectiveConfig,
  state: AutoModeState,
): string {
  const circle = config.enabled ? "●" : "○";
  const allowed = state.checkedActions - state.blockedActions;
  const classifier = state.classifierAllowed > 0 || state.classifierDenied > 0
    ? ` ca:${state.classifierAllowed} cd:${state.classifierDenied}`
    : "";
  return `AM ${circle} a:${allowed} d:${state.blockedActions}${classifier}`;
}

/** `config` is the effective config, with any `/automode on|off` choice applied. */
export function statusText(
  config: EffectiveConfig,
  state: AutoModeState,
): string {
  return [
    `enabled: ${config.enabled ? "yes" : "no"}`,
    `classifier: ${config.classifierModel ?? "current session model"}`,
    `classifier reasoning: ${config.classifierReasoningLevel ?? "server default"}`,
    `checked actions: ${state.checkedActions}`,
    `blocked actions: ${state.blockedActions}`,
    `classifier allowed: ${state.classifierAllowed}`,
    `classifier denied: ${state.classifierDenied}`,
    `permissions.deny rules: ${config.permissionDeny.length}`,
    `permissions.ask rules: ${config.permissionAsk.length}`,
    `permissions.allow rules: ${config.permissionAllow.length}`,
    `environment entries: ${config.environment.length}`,
    `allow entries: ${config.allow.length}`,
    `soft_deny entries: ${config.softDeny.length}`,
    `hard_deny entries: ${config.hardDeny.length}`,
    `last decision: ${state.lastDecision ?? "none"}`,
    `last reason: ${state.lastReason ?? "none"}`,
  ].join("\n");
}

export function formatDenials(state: AutoModeState): string {
  if (state.recentDenials.length === 0) return "No recent auto-mode denials.";
  return state.recentDenials
    .slice()
    .reverse()
    .map(
      (denial) =>
        `${
          new Date(denial.timestamp).toLocaleTimeString()
        } ${denial.kind} ${denial.toolName}: ${denial.reason}\n  ${
          truncateMiddle(denial.action, 300)
        }`,
    )
    .join("\n\n");
}

export function actionSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName} ${safeJson(input, 6000)}`;
}

/** Data written under `STATE_ENTRY`. */
export type PersistedState = AutoModeState & { enabledOverride?: boolean };

export function initialState(): AutoModeState {
  return { checkedActions: 0, blockedActions: 0, classifierAllowed: 0, classifierDenied: 0, recentDenials: [] };
}

export function restoreState(ctx: ExtensionContext): {
  state: AutoModeState;
  enabledOverride: boolean | undefined;
} {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      data?: Partial<PersistedState>;
    };
    if (
      entry.type !== "custom" ||
      entry.customType !== STATE_ENTRY ||
      !entry.data
    ) {
      continue;
    }
    return {
      state: {
        lastDecision: entry.data.lastDecision,
        lastReason: entry.data.lastReason,
        checkedActions: entry.data.checkedActions ?? 0,
        blockedActions: entry.data.blockedActions ?? 0,
        classifierAllowed: entry.data.classifierAllowed ?? 0,
        classifierDenied: entry.data.classifierDenied ?? 0,
        recentDenials: Array.isArray(entry.data.recentDenials)
          ? entry.data.recentDenials.slice(-DENIAL_HISTORY_LIMIT)
          : [],
      },
      enabledOverride: entry.data.enabledOverride,
    };
  }
  return { state: initialState(), enabledOverride: undefined };
}
