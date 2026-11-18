import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  classifierReasoningForConfig,
  defaultClassifyAction,
  serializeClassifierAction,
} from "./classifier.ts";
import { describeClassifierModel } from "./classifier-models.ts";
import {
  createHubEntry,
  globalHubRegistry,
  type HubEntry,
  hubAgentIdentity,
} from "./agent-hub.ts";
import {
  agentIdOf,
  ASK_DIALOG_TITLE,
  askDialogMessage,
  findAskingAncestor,
  FORWARDED_ASK_TIMEOUT_MS,
  forwardedAskMessage,
  forwardedAskTitle,
  headlessAskNote,
  registerAskSession,
  releaseAskSession,
  type SessionRecord,
} from "./ask-forwarding.ts";
import { classifierCooldowns } from "./classifier-fallback.ts";
import { analyzeBash, type BashAnalysis } from "./bash.ts";
import {
  embeddedNote,
  evalClassifierHints,
  evalHardDeny,
  matchesAllowedEvalPatterns,
  permissionTargets,
  prepareEvalChecks,
  type EvalChecks,
} from "./eval-checks.ts";
import {
  AUTO_MODE_GUIDANCE,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  EVAL_TOOL,
  PATH_BEARING_TOOLS,
  READ_ONLY_TOOLS,
} from "./constants.ts";
import {
  type GlobalConfigPreparation,
  loadEffectiveConfigWithDiagnostics,
  prepareGlobalConfig,
  writeGlobalSetting,
} from "./config.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import {
  resolveConfigLocations,
  selectLegacyGlobalConfigPath,
} from "./locations.ts";
import {
  createLogger,
  decisionStage,
  newDecisionId,
  resolveLogPath,
  type Logger,
} from "./log.ts";
import { loadOmpBridge } from "./omp.ts";
import {
  chooseClassifierModel,
  validateClassifierSelection,
} from "./model-choice.ts";
import {
  describeSavedSetting,
  describeSettingsWithoutUi,
  runSettingsMenu,
  SETTING_LABELS,
  type SettingsMenuHost,
  type SettingsSnapshot,
} from "./settings-menu.ts";
import {
  matchesAllowedToolPatterns,
  matchesDeniedPath,
  matchesToolPattern,
  matchingBashCommandText,
  recursiveSearchMayReachDeniedPath,
} from "./permissions.ts";
import { analyzeReadOnlyBash, readOnlyBashPolicy } from "./read-only-bash.ts";
import { isInsideReadOnlyRoot, isPlainFilePath } from "./read-only-roots.ts";
import {
  describeActiveControls,
  extractInputPath,
  isInside,
  isProtectedPath,
  isSafetyControlPath,
  registerOmpAgentDir,
  resolvePathForPolicy,
  resolveToolInputPath,
  resolveToolInputPaths,
} from "./paths.ts";
import {
  claimsForToolCall,
  confirmCreations,
  MAX_PENDING_CREATIONS,
  type PendingCreation,
  recordCreatedPaths,
  snapshotCreations,
} from "./provenance.ts";
import {
  actionSummary,
  agentIdentity,
  enabledSource,
  formatDenials,
  initialState,
  type PersistedState,
  pushClassifierError,
  pushDenial,
  restoreState,
  STATE_ENTRY,
  statusIcon,
  statusLine,
  type StatusTheme,
  statusText,
} from "./state.ts";
import { deniedGrepResultFiles, narrowGrepSearch } from "./search-scope.ts";
import { gateUrlSchemePath } from "./url-schemes.ts";
import {
  type EnabledOverride,
  registerSession,
  type SessionRegistration,
} from "./session-tree.ts";
import {
  ASK_ANSWER_ENTRY,
  askAnswersFromDetails,
  loadedContextFromSystemPromptOptions,
} from "./transcript.ts";
import type {
  AgentIdentity,
  AutoModeState,
  ClassifierFailure,
  ClassifierReasoningLog,
  ClassifierStage,
  ClassifyAction,
  ClassifyResult,
  ConfigLoadResult,
  DecisionKind,
  DenialRecord,
  EffectiveConfig,
  SettingUpdate,
} from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const INSPECT_TOOL = "automode_inspect";
const INSPECTION_ALLOW_REASON = "Extension-owned read-only inspection tool";
/** A reason may already end its sentence; the unavailable notice adds its own. */
const TRAILING_PERIODS = /\.+$/;
const INSPECTION_ACTIONS = ["status", "config", "defaults", "denials"] as const;
type InspectionAction = (typeof INSPECTION_ACTIONS)[number];

function matchedCommandSummary(command: string | undefined): string | undefined {
  return command ? truncateMiddle(command, 500) : undefined;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const EXTENSION_PATH = canonicalPath(fileURLToPath(import.meta.url));
const EXTENSION_ENTRY_PATH = canonicalPath(
  resolve(dirname(EXTENSION_PATH), "../auto-mode.ts"),
);

export function modelVisibleConfigDiagnostics(
  diagnostics: string[],
): string[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.replace(
      /invalid JSON \([\s\S]*\)$/,
      "invalid JSON (parser details omitted from model-visible output)",
    )
  );
}

/**
 * Append the auto-mode guidance to a system prompt, or return `undefined` when
 * the prompt already carries it. Pi passes one string; OMP passes an array of
 * blocks and takes the same shape back. A `/tan` clone starts from its
 * parent's already-extended prompt, so the guidance must not be added twice.
 */
export function withAutoModeGuidance(
  systemPrompt: string | readonly string[],
): string | string[] | undefined {
  if (typeof systemPrompt === "string") {
    return systemPrompt.includes(AUTO_MODE_GUIDANCE)
      ? undefined
      : `${systemPrompt}\n\n${AUTO_MODE_GUIDANCE}`;
  }
  return systemPrompt.some((block) => block.includes(AUTO_MODE_GUIDANCE))
    ? undefined
    : [...systemPrompt, AUTO_MODE_GUIDANCE];
}

function projectIsTrusted(
  ctx: { isProjectTrusted?: () => boolean },
): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : false;
}

export type PiAutomodeOptions = {
  /** Override config loading in tests. Runtime code uses Pi-owned disk settings. */
  loadConfig?: (cwd: string, projectTrusted: boolean) => EffectiveConfig;
  /** Override classifier calls in tests so unit tests never need a real LLM/API key. */
  classifyAction?: ClassifyAction;
  /** Override classifier-model persistence in tests. Takes precedence over `saveSetting` for that key. */
  saveClassifierModel?: (classifierModel: string) => void;
  /** Override global setting persistence in tests. Runtime code writes the active global config. */
  saveSetting?: (update: SettingUpdate) => void;
  /** Override global config migration and path selection in tests. */
  prepareGlobalConfig?: () => GlobalConfigPreparation;
  /** Override the application-owned observability log root in tests. */
  logRoot?: string;
  /** Override the observability log clock in tests. */
  now?: () => Date;
  /** Override Bash analysis in tests. Runtime code uses unbash. */
  analyzeBash?: typeof analyzeBash;
};

type LogCtx = {
  logger: Logger;
  decisionId: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
  /** When the tool call reached the hook, for `durationMs`. */
  startedAt: number;
  agent?: AgentIdentity;
  /** Set once the classifier ran: the stage that produced the decision. */
  classifierStage?: ClassifierStage;
  /** Set when the classifier failed closed. */
  failure?: ClassifierFailure;
  /** Model the classifier actually called, as `provider/id`. */
  resolvedModel?: string;
};

/** Append one `decision` entry with the call's timing, stage, agent, and failure details. */
function appendDecision(
  ctx: ExtensionContext,
  logCtx: LogCtx,
  decision: {
    tool: string;
    summary: string;
    kind: DecisionKind;
    outcome: "allow" | "block";
    reason: string;
  },
): void {
  if (!logCtx.logger.enabled) return;
  const { agent } = logCtx;
  logCtx.logger.append({
    type: "decision",
    ts: new Date().toISOString(),
    decisionId: logCtx.decisionId,
    sessionId: ctx.sessionManager.getSessionId?.(),
    cwd: ctx.cwd,
    ...decision,
    classifierModel: logCtx.classifierModel,
    reasoning: logCtx.reasoning,
    durationMs: Date.now() - logCtx.startedAt,
    stage: decisionStage(decision.kind, logCtx.classifierStage),
    agent: agent && { id: agent.id, name: agent.name, kind: agent.kind },
    hasUI: ctx.hasUI,
    errorKind: logCtx.failure?.kind,
    retryAfterMs: logCtx.failure?.retryAfterMs,
  });
}

/** Append ccusage-compatible usage and optional classifier I/O entries. */
function logClassifierIo(decision: ClassifyResult, log: LogCtx): void {
  log.failure = decision.failure;
  log.classifierStage = decision.io?.attempts.at(-1)?.stage ?? decision.failure?.stage;
  log.resolvedModel = decision.io?.model;
  if (decision.reasoning) log.reasoning = decision.reasoning;
  if (decision.io) log.reasoning = decision.io.reasoning;
  if (!log.logger.enabled || !decision.io) return;

  for (const attempt of decision.io.attempts) {
    const response = attempt.response;
    if (!response) continue;
    log.logger.append({
      type: "message",
      timestamp: new Date(response.timestamp).toISOString(),
      message: {
        role: "assistant",
        model: response.model,
        usage: response.usage,
      },
    });
  }

  if (!log.logger.classifierIo) return;
  log.logger.append({
    type: "classifier",
    ts: new Date().toISOString(),
    decisionId: log.decisionId,
    model: decision.io.model,
    reasoning: decision.io.reasoning,
    prompt: decision.io.prompt,
    attempts: decision.io.attempts,
    durationMs: decision.io.durationMs,
    parsed: {
      decision: decision.decision,
      tier: decision.tier,
      reason: decision.reason,
    },
  });
}

/** Create a Pi extension instance. Default export uses production dependencies. */
export function createPiAutomode(options: PiAutomodeOptions = {}) {
  const classify = options.classifyAction ?? defaultClassifyAction;
  const now = options.now ?? (() => new Date());

  return function piAutomode(pi: ExtensionAPI) {
    const locations = resolveConfigLocations(pi);
    if (locations.agentDir !== undefined) {
      registerOmpAgentDir(locations.agentDir);
    }
    const logRoot = options.logRoot ?? locations.logRoot;
    const globalConfig = options.prepareGlobalConfig?.() ??
      (options.loadConfig
        ? {
          status: "current" as const,
          activePath: locations.globalConfigPath,
        }
        : prepareGlobalConfig({
          currentPath: locations.globalConfigPath,
          legacyPath: selectLegacyGlobalConfigPath(locations),
        }));
    const loadConfigWithDiagnostics = (
      cwd: string,
      projectTrusted: boolean,
    ): ConfigLoadResult => {
      const result = options.loadConfig
        ? {
          config: options.loadConfig(cwd, projectTrusted),
          diagnostics: [],
        }
        : loadEffectiveConfigWithDiagnostics(
          cwd,
          projectTrusted,
          globalConfig.activePath,
          locations.projectConfigDirs,
        );
      return globalConfig.diagnostic
        ? {
          ...result,
          diagnostics: [...result.diagnostics, globalConfig.diagnostic],
        }
        : result;
    };
    const persistSetting = options.saveSetting ??
      ((update: SettingUpdate) =>
        writeGlobalSetting(update, globalConfig.activePath));
    const saveSetting = (update: SettingUpdate): void => {
      if (globalConfig.writeBlockedReason) {
        throw new Error(globalConfig.writeBlockedReason);
      }
      if (update.key === "classifierModel" && options.saveClassifierModel) {
        options.saveClassifierModel(update.value);
        return;
      }
      persistSetting(update);
    };
    let loadResult = loadConfigWithDiagnostics(process.cwd(), false);
    let config: EffectiveConfig = loadResult.config;
    let configDiagnostics: string[] = loadResult.diagnostics;
    let state: AutoModeState = initialState();
    let enabledOverride: EnabledOverride = {};
    let sessionRegistration: SessionRegistration | undefined;
    let loadedContext = "";
    /** Classifier calls awaiting a model response; parallel tool calls can overlap. */
    let classifierCallsInFlight = 0;
    let hubEntry: HubEntry | undefined;
    let globalConfigNoticeShown = false;
    let sessionRecord: SessionRecord | undefined;
    // Dialogs this session has open in an ancestor's UI, closed on shutdown.
    const pendingAsks = new Set<AbortController>();
    // How the per-session state above was set up. OMP never emits
    // `session_start` for `/tan` clones, so a session that gets a hook call
    // first is initialised by `ensureSession` instead.
    let sessionInit: "session-start" | "first-use" | undefined;

    function initialiseSession(
      ctx: ExtensionContext,
      source: "session-start" | "first-use",
    ): void {
      loadResult = loadConfigWithDiagnostics(ctx.cwd, projectIsTrusted(ctx));
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      const restored = restoreState(ctx);
      state = restored.state;
      pendingCreations.clear();
      sessionRegistration?.unregister();
      sessionRegistration = registerSession(ctx, restored.enabledOverride);
      enabledOverride = sessionRegistration.enabledOverride;
      // Register on both start paths: a `/tan` clone's subagents also look
      // their ancestors up in these registries.
      sessionRecord = registerAskSession(ctx);
      // The Agent Hub entry is made here too, so a `/tan` clone shows up as
      // `Tan-<id>-automode` although it never gets `session_start`.
      hubEntry?.dispose();
      hubEntry = undefined;
      const agent = hubAgentIdentity(ctx);
      const registry = agent ? globalHubRegistry(pi) : undefined;
      if (agent && registry) {
        hubEntry = createHubEntry(registry, agent);
      }
      sessionInit = source;
    }

    function ensureSession(ctx: ExtensionContext): void {
      if (!sessionInit) {
        initialiseSession(ctx, "first-use");
      }
    }
    // Creating calls that were allowed and are still running, by tool call id.
    const pendingCreations = new Map<string, PendingCreation>();

    function effectiveConfig(): EffectiveConfig {
      return {
        ...config,
        enabled: enabledOverride.value ?? config.enabled,
      };
    }

    function findTool(name: string) {
      try {
        return pi.getAllTools().find((tool) => tool.name === name);
      } catch {
        // OMP leaves runtime actions unwired in sessions that never got
        // `session_start`; a tool that cannot be found is not ours.
        return undefined;
      }
    }

    function ownsInspectionTool(): boolean {
      const tool = findTool(INSPECT_TOOL);
      if (!tool) return false;
      const sourcePath = canonicalPath(tool.sourceInfo.path);
      return sourcePath === EXTENSION_PATH || sourcePath === EXTENSION_ENTRY_PATH;
    }

    /** Whether the named tool is OMP's built-in, not an extension tool of the same name. */
    function ownsBuiltinTool(name: string): boolean {
      return pi.getAllTools().find((tool) => tool.name === name)
        ?.sourceInfo.path === `<builtin:${name}>`;
    }

    /** Revised `grep` input per tool call: denied paths excluded from the search. */
    const narrowedSearchInputs = new Map<string, Record<string, unknown>>();

    function persist(): void {
      // Without `session_start` OMP never wired this session's runtime
      // actions, so `appendEntry` throws; the state stays in memory.
      if (sessionInit === "first-use") {
        return;
      }
      pi.appendEntry(STATE_ENTRY, {
        ...state,
        enabledOverride: enabledOverride.value,
      } satisfies PersistedState);
    }

    function updateUi(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;
      const cfg = effectiveConfig();
      const text = statusLine(
        cfg,
        state,
        statusIcon(ctx.ui.theme as StatusTheme | undefined),
        classifierCallsInFlight > 0,
      );
      ctx.ui.setStatus(
        "pi-automode",
        cfg.enabled
          ? ctx.ui.theme.fg("accent", text)
          : ctx.ui.theme.fg("dim", text),
      );
    }

    function configSourcesReport() {
      return {
        runtime: locations.runtime,
        agentDir: locations.agentDir,
        global: globalConfig.activePath,
        ...loadResult.sources,
      };
    }

    async function classifierLabel(ctx: ExtensionContext): Promise<string> {
      return describeClassifierModel(
        ctx,
        effectiveConfig(),
        await loadOmpBridge(),
      );
    }

    function inspectAutomode(
      action: InspectionAction,
      ctx: ExtensionContext,
      classifier: string,
    ): unknown {
      const cfg = effectiveConfig();
      if (action === "status") {
        return {
          status: statusText(cfg, {
            ...state,
            lastReason: "omitted from model-visible inspection",
          }, classifier),
          state: {
            enabledOverride: enabledOverride.value,
            lastDecision: state.lastDecision,
            lastDecisionKind: state.lastDecisionKind,
            checkedActions: state.checkedActions,
            blockedActions: state.blockedActions,
            classifierAllowed: state.classifierAllowed,
            classifierDenied: state.classifierDenied,
            // Typed kind, time, and model only; provider error text and
            // payloads never reach the model.
            recentClassifierErrors: state.recentClassifierErrors.slice().reverse(),
          },
          enabledSource: enabledSource(
            cfg,
            enabledOverride,
            ctx.sessionManager.getSessionId?.(),
          ),
          agent: agentIdentity(ctx),
          hasUI: ctx.hasUI,
        };
      }
      if (action === "config") {
        return {
          config: cfg,
          configSources: configSourcesReport(),
          classifier,
          logFile: resolveLogPath(
            ctx.sessionManager.getSessionFile?.(),
            ctx.sessionManager.getSessionDir?.() ?? "",
            ctx.sessionManager.getSessionId?.() ?? "unknown",
            ctx.cwd,
            logRoot,
            now(),
          ),
          diagnostics: modelVisibleConfigDiagnostics(configDiagnostics),
        };
      }
      if (action === "defaults") {
        return {
          environment: DEFAULT_ENVIRONMENT,
          allow: DEFAULT_ALLOW,
          protectedPaths: DEFAULT_PROTECTED_PATHS,
          soft_deny: DEFAULT_SOFT_DENY,
          hard_deny: DEFAULT_HARD_DENY,
        };
      }
      const denials = state.recentDenials.slice().reverse().map((denial) => ({
        timestamp: denial.timestamp,
        kind: denial.kind,
        toolName: denial.toolName,
      }));
      return {
        summary: denials.length === 0
          ? "No recent auto-mode denials."
          : `${denials.length} recent auto-mode denial(s). Reasons and action payloads are omitted.`,
        denials,
      };
    }

    function blockedToolReason(denial: DenialRecord): string {
      const cause = denial.kind === "classifier-unavailable"
        ? `${denial.reason.replace(TRAILING_PERIODS, "")}. This is not a policy denial: auto mode could not review the action.`
        : denial.reason;
      return `[pi-automode] Action blocked; the tool did not run. ${cause} Do not claim success, rely on effects from this call, or attempt an equivalent workaround. Report the block to the user before continuing with dependent work. Independent work can continue.`;
    }

    function block(
      ctx: ExtensionContext,
      denial: DenialRecord,
      logCtx: LogCtx,
    ): { block: true; reason: string } {
      state.blockedActions += 1;
      state.lastDecision = "block";
      state.lastReason = denial.reason;
      state.lastDecisionKind = denial.kind;
      pushDenial(state, denial);
      if (
        (denial.kind === "classifier" || denial.kind === "classifier-unavailable") &&
        logCtx.failure
      ) {
        // Typed fields only: `failure.message` is provider text and stays out
        // of what `automode_inspect` shows the model.
        const { kind, stage, retryAfterMs } = logCtx.failure;
        pushClassifierError(state, {
          kind,
          ...(stage === undefined ? {} : { stage }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          timestamp: denial.timestamp,
          model: logCtx.resolvedModel ?? logCtx.classifierModel,
        });
      }
      persist();
      updateUi(ctx);
      hubEntry?.decided("block", denial.toolName, denial.action);
      appendDecision(ctx, logCtx, {
        tool: denial.toolName,
        summary: denial.action,
        kind: denial.kind,
        outcome: "block",
        reason: denial.reason,
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto mode blocked ${denial.toolName}: ${denial.reason}`,
          "warning",
        );
      }
      return {
        block: true,
        reason: blockedToolReason(denial),
      };
    }

    function allow(
      ctx: ExtensionContext,
      kind: DecisionKind,
      reason: string,
      toolName: string,
      summary: string,
      logCtx: LogCtx,
    ): undefined {
      state.lastDecision = "allow";
      state.lastReason = reason;
      state.lastDecisionKind = kind;
      persist();
      updateUi(ctx);
      hubEntry?.decided("allow", toolName, summary);
      appendDecision(ctx, logCtx, {
        tool: toolName,
        summary,
        kind,
        outcome: "allow",
        reason,
      });
      return undefined;
    }

    pi.on("session_start", (_event, ctx) => {
      initialiseSession(ctx, "session-start");
      if (
        ctx.hasUI &&
        globalConfig.notification &&
        !globalConfigNoticeShown
      ) {
        ctx.ui.notify(
          globalConfig.notification,
          globalConfig.status === "migrated" ? "info" : "warning",
        );
        globalConfigNoticeShown = true;
      }
      updateUi(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      hubEntry?.dispose();
      hubEntry = undefined;
      sessionRegistration?.unregister();
      sessionRegistration = undefined;
      sessionInit = undefined;
      if (sessionRecord) {
        releaseAskSession(ctx, sessionRecord);
      }
      for (const pending of pendingAsks) {
        pending.abort();
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      ensureSession(ctx);
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      loadedContext = loadedContextFromSystemPromptOptions(
        event.systemPromptOptions,
      );
      const guided = withAutoModeGuidance(event.systemPrompt);
      if (guided === undefined) return undefined;
      // OMP accepts back the block array it passes in; Pi's typings only
      // know the string form.
      return { systemPrompt: guided as string };
    });

    pi.on("tool_result", (event, ctx) => {
      // A narrowed grep must not report a denied file. If OMP did not honour the
      // exclusions, or the result does not list its files, drop the result.
      if (narrowedSearchInputs.delete(event.toolCallId) && !event.isError) {
        const denied = deniedGrepResultFiles(
          event.details,
          ctx.cwd,
          effectiveConfig().deniedPaths,
        );
        if (denied === undefined || denied.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: "[pi-automode] The search result was dropped because it could not be verified against deniedPaths.",
            }],
            isError: true,
          };
        }
      }
      if (event.toolName !== "ask" || event.isError || event.parentToolCallId) return undefined;
      // Only OMP's built-in ask shows the question to the user. A same-named
      // extension tool could invent an answer, so it never counts as consent.
      const sourceInfo: { path: string; source?: string } | undefined = pi.getAllTools()
        .find(({ name }) => name === "ask")?.sourceInfo;
      if (sourceInfo?.source !== "builtin" || sourceInfo.path !== "<builtin:ask>") return undefined;
      const answers = askAnswersFromDetails(event.details);
      if (answers.length > 0) {
        pi.appendEntry(ASK_ANSWER_ENTRY, { toolCallId: event.toolCallId, answers });
      }
      return undefined;
    });

    pi.on("tool_result", (event) => {
      const pending = pendingCreations.get(event.toolCallId);
      if (!pending) return undefined;
      pendingCreations.delete(event.toolCallId);
      if (event.isError === true) return undefined;
      const output = event.content
        .flatMap((part) => part.type === "text" ? [part.text] : [])
        .join("\n");
      const created = confirmCreations(pending, output);
      if (created.length === 0) return undefined;
      state.createdPaths = recordCreatedPaths(state.createdPaths, created);
      persist();
      return undefined;
    });

    async function evaluateToolCall(event: ToolCallEvent, ctx: ExtensionContext) {
      // Enforcement order:
      // 1. permission deny/ask rules,
      // 2. deterministic hard-deny checks that never consult the model,
      // 3. extension-owned read-only inspection tool,
      // 4. deterministic path denials,
      // 5. accepted ask rules force classifier review and skip all allow tiers,
      // 6. inside-CWD, permissions.allow, read-only-root, and read-only allow tiers,
      // 7. read-only bash allow tier (`allowReadOnlyBash`),
      // 8. classifier for every remaining action, fail-closed on setup/parse errors.
      ensureSession(ctx);
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;

      const startedAt = Date.now();
      const input = event.input as Record<string, unknown>;
      const summary = actionSummary(event.toolName, input);
      const logCtx: LogCtx = {
        logger: createLogger({
          enabled: cfg.log.enabled,
          classifierIo: cfg.log.classifierIo,
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          sessionDir: ctx.sessionManager.getSessionDir?.() ?? "",
          sessionCwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId?.() ?? "unknown",
          logRoot,
          now: now(),
        }),
        decisionId: newDecisionId(),
        classifierModel: cfg.classifierModel,
        reasoning: classifierReasoningForConfig(cfg.classifierReasoningLevel),
        startedAt,
        agent: agentIdentity(ctx),
      };

      if (ctx.signal?.aborted) {
        state.checkedActions += 1;
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: "Cancelled",
          action: summary,
          kind: "setup",
        }, logCtx);
      }

      const isOwnedInspection = event.toolName === INSPECT_TOOL &&
        ownsInspectionTool();
      let bashAnalysis: BashAnalysis | undefined;
      if (event.toolName === "bash") {
        const source = typeof input.command === "string" ? input.command : "";
        try {
          bashAnalysis = (options.analyzeBash ?? analyzeBash)(source);
        } catch (error) {
          bashAnalysis = {
            source,
            commands: [],
            redirects: [],
            writeRedirectTargets: [],
            groupWriteRedirectTargets: [],
            structure: [],
            allowStructureSafe: false,
            errors: [{
              message: `Bash analysis failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }],
          };
        }
      }
      const evalChecks: EvalChecks | undefined = event.toolName === EVAL_TOOL
        ? prepareEvalChecks(input, options.analyzeBash ?? analyzeBash)
        : undefined;
      const targets = permissionTargets(event.toolName, input, bashAnalysis, evalChecks);
      if (!isOwnedInspection) state.checkedActions += 1;

      for (const pattern of cfg.permissionDeny) {
        const target = targets.find((candidate) =>
          matchesToolPattern(
            pattern,
            candidate.toolName,
            candidate.input,
            ctx.cwd,
            "match",
            candidate.bashAnalysis,
          )
        );
        if (target) {
          const matchedCommand = matchedCommandSummary(
            matchingBashCommandText(pattern, target.bashAnalysis),
          );
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Blocked by permissions.deny: ${pattern.raw}${embeddedNote(target)}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
            action: summary,
            kind: "permissions.deny",
          }, logCtx);
        }
      }

      let askRequiresClassifier = false;
      const classifierNotes: string[] = [];
      for (const pattern of cfg.permissionAsk) {
        const target = targets.find((candidate) =>
          matchesToolPattern(
            pattern,
            candidate.toolName,
            candidate.input,
            ctx.cwd,
            "match",
            candidate.bashAnalysis,
          )
        );
        if (!target) {
          continue;
        }
        const matchedCommand = matchedCommandSummary(
          matchingBashCommandText(pattern, target.bashAnalysis),
        );
        const blockAsk = (reason: string) => {
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        };
        let allowed: boolean;
        let timedOut = false;
        if (ctx.hasUI) {
          allowed = await ctx.ui.confirm(ASK_DIALOG_TITLE, askDialogMessage(pattern.raw, summary), {
            signal: ctx.signal,
          });
        } else if (cfg.headlessAsk === "classifier") {
          askRequiresClassifier = true;
          classifierNotes.push(headlessAskNote(pattern.raw));
          continue;
        } else {
          const ancestor = cfg.headlessAsk === "parent"
            ? findAskingAncestor(ctx)
            : undefined;
          if (!ancestor) {
            return blockAsk(
              `Matched permissions.ask (${pattern.raw})${embeddedNote(target)}${
                matchedCommand ? ` for command: ${matchedCommand}` : ""
              } but no UI is available${
                cfg.headlessAsk === "parent" ? " here or in a parent session" : ""
              }`,
            );
          }
          const dialog = new AbortController();
          pendingAsks.add(dialog);
          const deadline = setTimeout(() => {
            timedOut = true;
            dialog.abort();
          }, FORWARDED_ASK_TIMEOUT_MS);
          try {
            allowed = await ancestor.ui.confirm(
              forwardedAskTitle(agentIdOf(ctx)),
              forwardedAskMessage(pattern.raw, summary),
              {
                signal: ctx.signal
                  ? AbortSignal.any([ctx.signal, dialog.signal])
                  : dialog.signal,
              },
            );
          } catch (error) {
            // Fail closed: an ancestor whose UI is gone cannot approve.
            return blockAsk(
              `Could not ask the parent session about permissions.ask (${pattern.raw}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            clearTimeout(deadline);
            pendingAsks.delete(dialog);
          }
        }
        if (!allowed) {
          return blockAsk(
            `${
              timedOut
                ? `No answer from the parent session within ${FORWARDED_ASK_TIMEOUT_MS / 1000}s for permissions.ask`
                : "Declined permissions.ask"
            }: ${pattern.raw}${embeddedNote(target)}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
          );
        }
        askRequiresClassifier = true;
      }

      const deterministicReason = deterministicHardDeny(
        event.toolName,
        input,
        ctx.cwd,
        bashAnalysis,
      ) ?? (evalChecks ? evalHardDeny(evalChecks, ctx.cwd) : undefined);
      if (deterministicReason) {
        if (isOwnedInspection) state.checkedActions += 1;
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: deterministicReason,
          action: summary,
          kind: "deterministic-hard-deny",
        }, logCtx);
      }

      if (isOwnedInspection && !askRequiresClassifier) {
        // Inspection is not a decision about state: counters, the last
        // decision, and persisted state stay untouched. It is still logged so
        // the log shows every tool call auto mode let through.
        appendDecision(ctx, logCtx, {
          tool: event.toolName,
          summary,
          kind: "read-only",
          outcome: "allow",
          reason: INSPECTION_ALLOW_REASON,
        });
        return undefined;
      }
      if (isOwnedInspection) state.checkedActions += 1;

      // Deterministic path gate for file tools.
      //
      // `deniedPaths` always applies: a matching path is hard-denied before any
      // classifier or fast path, so secrets and system dirs never reach the
      // model. `allowInsideWorkingDirectory` adds a deterministic silent-allow
      // tier for file tools whose resolved path is inside the working
      // directory, and routes outside-CWD file access to the classifier
      // (bypassing the read-only fast path so reads outside the tree are
      // reviewed too).
      //
      // The gate is skipped entirely when both features are off, so the
      // default configuration costs no extra filesystem calls.
      let readOnlyFastPath =
        !askRequiresClassifier &&
        !cfg.classifyReadOnlyTools &&
        READ_ONLY_TOOLS.has(event.toolName);

      // `scheme://` entries are not filesystem paths. Judge them before any
      // path resolution so `xd://propose` is not read as `<cwd>/xd:/propose`.
      const urlGate = PATH_BEARING_TOOLS.has(event.toolName) &&
          typeof input.path === "string"
        ? gateUrlSchemePath(event.toolName, input.path, {
          deviceDispatch: ownsBuiltinTool("write"),
        })
        : undefined;
      if (urlGate) {
        const deniedUrl = urlGate.decisions.find(({ entry }) =>
          matchesDeniedPath(entry, cfg.deniedPaths)
        );
        if (deniedUrl) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Path denied by policy: ${deniedUrl.entry}`,
            action: summary,
            kind: "deterministic-path-deny",
          }, logCtx);
        }
        if (urlGate.decisions.some(({ action }) => action === "classify")) {
          readOnlyFastPath = false;
        }
      }
      if (
        (cfg.deniedPaths.length > 0 || cfg.allowInsideWorkingDirectory ||
          cfg.readOnlyRoots.length > 0) &&
        PATH_BEARING_TOOLS.has(event.toolName)
      ) {
        const inputPath = urlGate
          ? urlGate.pathEntries.length > 0
            ? urlGate.pathEntries.join(";")
            : undefined
          : extractInputPath(event.toolName, input);
        if (inputPath !== undefined) {
          // omp's read and grep address more than the literal string
          // (selectors, queries, path lists), so every path the call can
          // reach is checked.
          const targets = resolveToolInputPaths(
            event.toolName,
            ctx.cwd,
            inputPath,
          ).map((resolved) => ({
            resolved,
            policyPath: resolvePathForPolicy(resolved) ?? resolved,
          }));
          for (const { resolved, policyPath } of targets) {
            const denied =
              cfg.deniedPaths.length > 0 &&
              (matchesDeniedPath(resolved, cfg.deniedPaths) ||
                matchesDeniedPath(policyPath, cfg.deniedPaths));
            if (denied) {
              return block(ctx, {
                timestamp: Date.now(),
                toolName: event.toolName,
                reason: `Path denied by policy: ${policyPath}`,
                action: summary,
                kind: "deterministic-path-deny",
              }, logCtx);
            }
            let recursiveSearch =
              event.toolName === "grep" || event.toolName === "find";
            if (recursiveSearch) {
              try {
                recursiveSearch = statSync(policyPath).isDirectory();
              } catch {
                // A missing search root will fail in the tool. Treat it as a
                // directory here so a denied scope cannot fail open in a race.
              }
            }
            const deniedSearchScope =
              recursiveSearch &&
              cfg.deniedPaths.length > 0 &&
              (recursiveSearchMayReachDeniedPath(resolved, cfg.deniedPaths) ||
                recursiveSearchMayReachDeniedPath(
                  policyPath,
                  cfg.deniedPaths,
                ));
            if (deniedSearchScope) {
              // OMP's built-in grep reads `!glob` list entries as exclusions, so a
              // search that can reach a denied path runs without those files.
              // Anything else, or a pattern the exclusions cannot express, blocks.
              const narrowed = event.toolName === "grep" && ownsBuiltinTool("grep")
                ? narrowGrepSearch(input, ctx.cwd, cfg.deniedPaths)
                : undefined;
              if (narrowed === undefined) {
                return block(ctx, {
                  timestamp: Date.now(),
                  toolName: event.toolName,
                  reason: `Search scope can contain a path denied by policy: ${policyPath}`,
                  action: summary,
                  kind: "deterministic-path-deny",
                }, logCtx);
              }
              narrowedSearchInputs.set(event.toolCallId, narrowed);
            }
          }
          // Read-only roots skip the classifier outside the cwd; protected paths do not.
          if (
            !askRequiresClassifier &&
            READ_ONLY_TOOLS.has(event.toolName) &&
            isPlainFilePath(inputPath) &&
            targets.every(({ policyPath }) =>
              isInsideReadOnlyRoot(policyPath, cfg.readOnlyRoots) &&
              !isSafetyControlPath(policyPath, ctx.cwd) &&
              !isProtectedPath(
                policyPath,
                resolvePathForPolicy(ctx.cwd) ?? ctx.cwd,
                cfg.protectedPaths,
              )
            )
          ) {
            return allow(
              ctx,
              "read-only-root",
              `Path inside read-only root: ${
                targets.map(({ policyPath }) => policyPath).join(", ")
              }`,
              event.toolName,
              summary,
              logCtx,
            );
          }
          if (cfg.allowInsideWorkingDirectory) {
            const policyCwd = resolvePathForPolicy(ctx.cwd) ?? ctx.cwd;
            if (targets.every(({ policyPath }) => isInside(policyPath, policyCwd))) {
              // Protected in-tree writes and accepted ask rules must still
              // reach the classifier. They cannot use the inside-CWD tier.
              const protectedWrite =
                (event.toolName === "write" || event.toolName === "edit") &&
                targets.some(({ policyPath }) =>
                  isProtectedPath(policyPath, policyCwd, cfg.protectedPaths)
                );
              if (!askRequiresClassifier && !protectedWrite) {
                return allow(
                  ctx,
                  "inside-working-directory",
                  `Path inside working directory: ${
                    targets.map(({ policyPath }) => policyPath).join(", ")
                  }`,
                  event.toolName,
                  summary,
                  logCtx,
                );
              }
            }
            // Outside the working directory, protected writes, and accepted
            // ask rules must not use the read-only fast path.
            readOnlyFastPath = false;
          }
        }
      }

      // A built-in OMP scheme, or a nested xd:// device call, is not a path in
      // the working directory. Entries that need review already cleared the
      // read-only fast path above.
      if (urlGate && !askRequiresClassifier && urlGate.pathEntries.length === 0) {
        const reasons = urlGate.decisions.flatMap((decision) =>
          decision.action === "classify" ||
            (decision.action === "scratch" && !cfg.allowInsideWorkingDirectory)
            ? []
            : [decision.reason]
        );
        if (reasons.length === urlGate.decisions.length) {
          return allow(
            ctx,
            "url-scheme",
            reasons.join("; "),
            event.toolName,
            summary,
            logCtx,
          );
        }
      }

      // Deterministic allow tier. It runs after every deterministic denial.
      // Accepted ask rules skip this tier and always reach the classifier.
      if (!askRequiresClassifier) {
        if (
          evalChecks
            ? matchesAllowedEvalPatterns(cfg.permissionAllow, input, ctx.cwd, evalChecks)
            : matchesAllowedToolPatterns(
              cfg.permissionAllow,
              event.toolName,
              input,
              ctx.cwd,
              bashAnalysis,
            )
        ) {
          // A protected-path write/edit is never covered by permissions.allow;
          // it stays on the classifier path (same rule as the inside-CWD tier).
          let protectedWrite = false;
          if (event.toolName === "write" || event.toolName === "edit") {
            const inputPath = extractInputPath(event.toolName, input);
            const resolved = inputPath === undefined
              ? undefined
              : resolveToolInputPath(event.toolName, ctx.cwd, inputPath) ??
                inputPath;
            if (
              resolved !== undefined &&
              isProtectedPath(resolved, ctx.cwd, cfg.protectedPaths)
            ) {
              protectedWrite = true;
            }
          }
          if (!protectedWrite) {
            return allow(
              ctx,
              "permissions.allow",
              "Allowed by permissions.allow",
              event.toolName,
              summary,
              logCtx,
            );
          }
        }
      }

      // Opt-in tier for pure-read bash; anything not provably read-only goes to the classifier.
      if (
        !askRequiresClassifier &&
        cfg.allowReadOnlyBash &&
        event.toolName === "bash" &&
        typeof input.command === "string"
      ) {
        const policy = readOnlyBashPolicy(cfg, input, ctx.cwd);
        const verdict = policy && analyzeReadOnlyBash(input.command, policy);
        if (verdict?.readOnly) {
          return allow(
            ctx,
            "read-only-bash",
            `Read-only shell command: ${verdict.commands.join(", ")}`,
            event.toolName,
            summary,
            logCtx,
          );
        }
      }

      if (readOnlyFastPath) {
        return allow(
          ctx,
          "read-only",
          `Read-only built-in tool: ${event.toolName}`,
          event.toolName,
          summary,
          logCtx,
        );
      }

      classifierCallsInFlight += 1;
      updateUi(ctx);
      hubEntry?.classifyStarted(event.toolName, summary);
      let decision: ClassifyResult;
      try {
        decision = await classify(
          ctx,
          cfg,
          serializeClassifierAction(event.toolName, input),
          loadedContext,
          classifierNotes,
          state.createdPaths,
          {
            ...(evalChecks ? evalClassifierHints(evalChecks) : {}),
            // An accepted ask rule demands full classifier review, and eval
            // runs arbitrary code a probability cannot vouch for.
            skipJudge: askRequiresClassifier || event.toolName === EVAL_TOOL,
          },
          describeActiveControls(ctx.cwd, [globalConfig.activePath]),
        );
      } finally {
        classifierCallsInFlight -= 1;
        hubEntry?.classifyFinished();
        updateUi(ctx);
      }
      logClassifierIo(decision, logCtx);
      if (decision.decision === "allow") {
        state.classifierAllowed += 1;
        return allow(
          ctx,
          "classifier",
          decision.reason,
          event.toolName,
          summary,
          logCtx,
        );
      }

      if (decision.failure) {
        // The classifier could not decide: not a policy denial, so the
        // classifier-denied counter stays unchanged.
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: decision.reason,
          action: summary,
          kind: "classifier-unavailable",
        }, logCtx);
      }

      state.classifierDenied += 1;
      return block(ctx, {
        timestamp: Date.now(),
        toolName: event.toolName,
        reason: decision.reason,
        action: summary,
        kind: "classifier",
      }, logCtx);
    }

    pi.on("tool_call", async (event, ctx) => {
      narrowedSearchInputs.delete(event.toolCallId);
      const result = await evaluateToolCall(event, ctx);
      if (result !== undefined) return result;
      const revised = narrowedSearchInputs.get(event.toolCallId);
      // OMP runs the call with the returned `input`; the field is OMP-only.
      return revised
        ? ({ input: revised } as unknown as { block?: boolean })
        : undefined;
    });

    // Registered right after the enforcement handler above. Pi and OMP stop at
    // the first handler that blocks, so a call that reaches this one was
    // allowed. The paths are only recorded as created once the call's result
    // arrives without an error.
    pi.on("tool_call", (event, ctx) => {
      if (!event.toolCallId || !effectiveConfig().enabled) return undefined;
      try {
        const claims = claimsForToolCall(
          event.toolName,
          event.input as Record<string, unknown>,
          ctx.cwd,
          options.analyzeBash ?? analyzeBash,
        );
        const pending = claims && snapshotCreations(claims, Date.now());
        if (!pending) return undefined;
        if (pendingCreations.size >= MAX_PENDING_CREATIONS) {
          const [oldest] = pendingCreations.keys();
          if (oldest !== undefined) pendingCreations.delete(oldest);
        }
        pendingCreations.set(event.toolCallId, pending);
      } catch {
        // Provenance only gives the classifier more to work with. A failure
        // here leaves the paths untracked, which keeps it as strict as before.
      }
      return undefined;
    });

    pi.registerTool({
      name: INSPECT_TOOL,
      label: "Inspect Auto Mode",
      description:
        "Inspect the active pi-automode status, effective config, built-in defaults, or recent denial metadata. This tool is read-only and cannot enable, disable, reload, reset, or reconfigure auto mode. Its output is sent to the current model; denial reasons and action payloads are omitted.",
      promptSnippet:
        "Inspect active pi-automode state and diagnostic information without changing it",
      parameters: Type.Object({
        action: StringEnum(INSPECTION_ACTIONS, {
          description: "The read-only auto-mode view to return",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Auto-mode inspection cancelled");
        const result = inspectAutomode(
          params.action,
          ctx,
          await classifierLabel(ctx),
        );
        return {
          content: [{ type: "text", text: safeJson(result, 16000) }],
          details: result,
        };
      },
    });

    function refreshConfig(ctx: ExtensionContext): void {
      loadResult = loadConfigWithDiagnostics(ctx.cwd, projectIsTrusted(ctx));
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      persist();
      updateUi(ctx);
    }

    function settingsSnapshot(): SettingsSnapshot {
      return {
        config: effectiveConfig(),
        provenance: loadResult.provenance,
        sessionEnabled: enabledOverride.value,
      };
    }

    async function saveGlobalSetting(
      update: SettingUpdate,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      try {
        saveSetting(update);
      } catch (error) {
        ctx.ui.notify(
          `Failed to save ${SETTING_LABELS[update.key]}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
        return;
      }
      refreshConfig(ctx);
      const saved = describeSavedSetting(update, settingsSnapshot());
      ctx.ui.notify(saved.message, saved.overridden ? "warning" : "info");
    }

    async function setClassifierModel(
      selected: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const selection = await validateClassifierSelection(ctx, selected);
      if ("error" in selection) {
        ctx.ui.notify(selection.error, "error");
        return;
      }
      await saveGlobalSetting(
        { key: "classifierModel", value: selection.spec },
        ctx,
      );
    }

    async function handleAutomodeCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const [command = "status", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const remainder = rest.join(" ").trim();

      if (command === "status") {
        ctx.ui.notify(
          statusText(effectiveConfig(), state, await classifierLabel(ctx)),
          "info",
        );
        return;
      }
      if (command === "on") {
        enabledOverride.value = true;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode enabled for this session and its subagents", "info");
        return;
      }
      if (command === "off") {
        enabledOverride.value = false;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode disabled for this session and its subagents", "warning");
        return;
      }
      if (command === "reload") {
        // Also forgets rate-limit cooldowns, so the next action probes providers again.
        classifierCooldowns.clear();
        refreshConfig(ctx);
        ctx.ui.notify(
          "pi-automode config reloaded",
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "reset") {
        state = initialState();
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode counters reset", "info");
        return;
      }
      if (command === "defaults") {
        ctx.ui.notify(
          safeJson(
            {
              environment: DEFAULT_ENVIRONMENT,
              allow: DEFAULT_ALLOW,
              protectedPaths: DEFAULT_PROTECTED_PATHS,
              soft_deny: DEFAULT_SOFT_DENY,
              hard_deny: DEFAULT_HARD_DENY,
            },
            12000,
          ),
          "info",
        );
        return;
      }
      if (command === "config") {
        const logFile = resolveLogPath(
          ctx.sessionManager.getSessionFile?.(),
          ctx.sessionManager.getSessionDir?.() ?? "",
          ctx.sessionManager.getSessionId?.() ?? "unknown",
          ctx.cwd,
          logRoot,
          now(),
        );
        ctx.ui.notify(
          safeJson(
            {
              config: effectiveConfig(),
              configSources: configSourcesReport(),
              classifier: await classifierLabel(ctx),
              logFile,
              diagnostics: configDiagnostics,
            },
            16000,
          ),
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "denials") {
        ctx.ui.notify(
          formatDenials(state),
          state.recentDenials.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "model") {
        const selected = remainder ||
          await chooseClassifierModel(ctx, effectiveConfig().classifierModel);
        if (!selected) {
          ctx.ui.notify("Classifier model unchanged", "info");
          return;
        }
        await setClassifierModel(selected, ctx);
        return;
      }
      if (command === "settings") {
        const host: SettingsMenuHost = {
          ctx,
          globalConfigPath: globalConfig.activePath,
          snapshot: settingsSnapshot,
          classifierLabel: () => classifierLabel(ctx),
          hasJudge: (await loadOmpBridge()) !== undefined,
          save: (update) => saveGlobalSetting(update, ctx),
          chooseModel: async () => {
            const selected = await chooseClassifierModel(
              ctx,
              effectiveConfig().classifierModel,
            );
            if (selected) {
              await setClassifierModel(selected, ctx);
            }
          },
        };
        if (!ctx.hasUI) {
          ctx.ui.notify(await describeSettingsWithoutUi(host), "info");
          return;
        }
        await runSettingsMenu(host);
        return;
      }

      ctx.ui.notify(
        "Usage: /automode [status|on|off|reload|reset|defaults|config|denials|settings|model [provider/id|@role]]",
        "error",
      );
    }

    pi.registerCommand("automode", {
      description:
        "Control pi-automode: status, on, off, reload, reset, defaults, config, denials, settings, model",
      handler: handleAutomodeCommand,
    });
  };
}
