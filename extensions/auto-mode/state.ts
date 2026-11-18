import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_ERROR_HISTORY_LIMIT, DENIAL_HISTORY_LIMIT } from "./constants.ts";
import { restoreCreatedPaths } from "./provenance.ts";
import type { EnabledOverride } from "./session-tree.ts";
import type {
  AgentIdentity,
  AutoModeState,
  ClassifierErrorRecord,
  DenialRecord,
  EffectiveConfig,
  EnabledSource,
} from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

/** Session entry holding counters, recent denials, created paths, and the `/automode on|off` choice. */
export const STATE_ENTRY = "pi-automode-state";


export function pushDenial(state: AutoModeState, denial: DenialRecord): void {
  state.recentDenials = [
    ...state.recentDenials.slice(-(DENIAL_HISTORY_LIMIT - 1)),
    denial,
  ];
}

export function pushClassifierError(
  state: AutoModeState,
  error: ClassifierErrorRecord,
): void {
  state.recentClassifierErrors = [
    ...state.recentClassifierErrors.slice(-(CLASSIFIER_ERROR_HISTORY_LIMIT - 1)),
    error,
  ];
}

/**
 * Where the effective `enabled` value came from. `/automode on|off` wins over
 * config. A choice the session did not make itself was inherited from the
 * agent that spawned it.
 */
export function enabledSource(
  config: EffectiveConfig,
  override: EnabledOverride,
  sessionId: string | undefined,
): EnabledSource {
  if (override.value === undefined) return config.enabledSource ?? "default";
  return override.owner !== undefined && override.owner !== sessionId
    ? "parent"
    : "override";
}

/** The host's identity for the running agent. Pi has no `ctx.agent`, so this is OMP-only. */
export function agentIdentity(ctx: ExtensionContext): AgentIdentity | undefined {
  const agent: unknown = "agent" in ctx ? ctx.agent : undefined;
  if (typeof agent !== "object" || agent === null) return undefined;
  const { kind, id, name, depth } = agent as Record<string, unknown>;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    id: typeof id === "string" ? id : undefined,
    name: typeof name === "string" ? name : undefined,
    depth: typeof depth === "number" ? depth : undefined,
  };
}

/** Icon for themes that expose no glyphs, such as Pi's. */
export const FALLBACK_STATUS_ICON = "●";

/** The slice of an OMP theme used to pick the status icon. Pi themes have neither field. */
export type StatusTheme = {
  cmd?: { shield?: string };
  icon?: { auto?: string };
};

/**
 * OMP's `cmd.shield` glyph follows the symbol preset (unicode, nerd). The ascii
 * preset leaves it empty, so fall back to `icon.auto`, then to a plain glyph.
 */
export function statusIcon(theme: StatusTheme | undefined): string {
  return theme?.cmd?.shield || theme?.icon?.auto || FALLBACK_STATUS_ICON;
}

/**
 * One compact segment: `<icon> auto`, `<icon> auto · N blocked`, `<icon> off`,
 * or `<icon> checking…` while a classifier call is in flight. `config` is the
 * effective config, with any `/automode on|off` choice applied.
 */
export function statusLine(
  config: EffectiveConfig,
  state: AutoModeState,
  icon: string,
  checking = false,
): string {
  if (!config.enabled) return `${icon} off`;
  if (checking) return `${icon} checking…`;
  if (state.blockedActions > 0) return `${icon} auto · ${state.blockedActions} blocked`;
  return `${icon} auto`;
}

/**
 * `config` is the effective config, with any `/automode on|off` choice applied.
 * `classifier` describes the resolved classifier model; it falls back to the
 * configured selector when the caller cannot resolve one.
 */
export function statusText(
  config: EffectiveConfig,
  state: AutoModeState,
  classifier = config.classifierModel ?? "current session model",
): string {
  return [
    `enabled: ${config.enabled ? "yes" : "no"}`,
    `classifier: ${classifier}`,
    `classifier strategy: ${config.classifierStrategy}${
      config.classifierStrategy === "hybrid"
        ? ` (judge confidence ${config.judgeConfidence})`
        : ""
    }`,
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
    `last decision kind: ${state.lastDecisionKind ?? "none"}`,
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
  return {
    checkedActions: 0,
    blockedActions: 0,
    classifierAllowed: 0,
    classifierDenied: 0,
    recentDenials: [],
    recentClassifierErrors: [],
    createdPaths: [],
  };
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
        lastDecisionKind: entry.data.lastDecisionKind,
        checkedActions: entry.data.checkedActions ?? 0,
        blockedActions: entry.data.blockedActions ?? 0,
        classifierAllowed: entry.data.classifierAllowed ?? 0,
        classifierDenied: entry.data.classifierDenied ?? 0,
        recentDenials: Array.isArray(entry.data.recentDenials)
          ? entry.data.recentDenials.slice(-DENIAL_HISTORY_LIMIT)
          : [],
        recentClassifierErrors: Array.isArray(entry.data.recentClassifierErrors)
          ? entry.data.recentClassifierErrors.slice(-CLASSIFIER_ERROR_HISTORY_LIMIT)
          : [],
        createdPaths: restoreCreatedPaths(entry.data.createdPaths),
      },
      enabledOverride: entry.data.enabledOverride,
    };
  }
  return { state: initialState(), enabledOverride: undefined };
}
