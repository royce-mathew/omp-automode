import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_ALLOW,
  DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY,
  DEFAULT_ALLOW_READ_ONLY_BASH,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_CLASSIFY_READ_ONLY_TOOLS,
  DEFAULT_DENIED_PATHS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
  DEFAULT_HARD_DENY,
  DEFAULT_HEADLESS_ASK,
  DEFAULT_LOG_CONFIG,
  DEFAULT_MAX_TOOL_TRANSCRIPT_TOKENS,
  DEFAULT_MAX_USER_TRANSCRIPT_TOKENS,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_READ_ONLY_ROOTS,
  DEFAULT_SOFT_DENY,
  HEADLESS_ASK_MODES,
  MAX_CLASSIFIER_TIMEOUT_MS,
  PI_GLOBAL_SETTINGS,
  PI_LEGACY_GLOBAL_SETTINGS,
  PI_PROJECT_DIR,
  PROJECT_LOCAL_SETTINGS_FILE,
  PROJECT_SHARED_SETTINGS_FILE,
} from "./constants.ts";
import { parseClassifierSelector } from "./model.ts";
import {
  CLASSIFIER_STRATEGIES,
  DEFAULT_CLASSIFIER_STRATEGY,
  DEFAULT_JUDGE_CONFIDENCE,
  isClassifierStrategy,
  isJudgeConfidence,
} from "./strategy.ts";
import {
  isMalformedToolPattern,
  MAX_WILDCARD_PATTERN_LENGTH,
  parseToolPattern,
} from "./permissions.ts";
import { readOnlyRootProblem } from "./read-only-roots.ts";
import type {
  AutoModeSettings,
  ClassifierReasoningLevel,
  ConfigLoadResult,
  ConfigScope,
  EffectiveConfig,
  HeadlessAskMode,
  LoadedSettingsFile,
  LogConfig,
  SettingId,
  SettingSource,
  SettingsFile,
  SettingsProvenance,
  SettingsSources,
  SettingUpdate,
  ToolPattern,
} from "./types.ts";
import { hasOwn, isPlainObject, stringArray } from "./utils.ts";

export type GlobalConfigPreparation = {
  status: "current" | "migrated" | "conflict" | "failed";
  activePath: string;
  diagnostic?: string;
  notification?: string;
  writeBlockedReason?: string;
};

export type PrepareGlobalConfigOptions = {
  currentPath?: string;
  legacyPath?: string;
  moveFile?: (source: string, destination: string) => void;
  unlinkFile?: (path: string) => void;
  /** Hard-link primitive for the default move. Overridden in tests. */
  linkFile?: (source: string, destination: string) => void;
};

function sameFileIdentity(firstPath: string, secondPath: string): boolean {
  try {
    const first = lstatSync(firstPath);
    const second = lstatSync(secondPath);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

function cleanupPublishedDestination(
  destination: string,
  unlinkFile: (path: string) => void,
  originalError: unknown,
): AggregateError | undefined {
  try {
    unlinkFile(destination);
    return undefined;
  } catch (cleanupError) {
    return new AggregateError(
      [originalError, cleanupError],
      `Could not clean up interrupted Auto Mode config migration at ${destination}`,
    );
  }
}

/**
 * Publish a copy of `source` at `destination` without overwriting an existing
 * file. The copy goes to a temporary file in the destination directory first,
 * then a hard link (same filesystem, fails if the destination exists) makes it
 * appear in one step, so a reader never sees a partial config.
 */
function copyFileWithoutOverwrite(
  source: string,
  destination: string,
  linkFile: (source: string, destination: string) => void,
  unlinkFile: (path: string) => void,
): void {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
    linkFile(temporary, destination);
  } finally {
    try {
      unlinkFile(temporary);
    } catch {
      // The temporary file is absent when the copy never started.
    }
  }
}

function moveFileWithoutOverwrite(
  source: string,
  destination: string,
  linkFile: (source: string, destination: string) => void,
  unlinkFile: (path: string) => void,
): void {
  try {
    linkFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    // The agent directory is on another filesystem, so a hard link is
    // impossible. Publish a copy instead, then remove the legacy file.
    copyFileWithoutOverwrite(source, destination, linkFile, unlinkFile);
  }
  try {
    unlinkFile(source);
  } catch (error) {
    throw cleanupPublishedDestination(destination, unlinkFile, error) ?? error;
  }
}

function globalConfigFailure(
  currentPath: string,
  legacyPath: string,
  error: unknown,
  writeBlockedReason?: string,
): GlobalConfigPreparation {
  const message =
    `Could not move Auto Mode config from ${legacyPath} to ${currentPath}: ${
      error instanceof Error ? error.message : String(error)
    }. Using the legacy config for this session${
      writeBlockedReason ? "; global config writes are disabled" : ""
    }.`;
  return {
    status: "failed",
    activePath: legacyPath,
    diagnostic: message,
    notification: message,
    writeBlockedReason,
  };
}

function globalConfigConflict(
  currentPath: string,
  legacyPath: string,
): GlobalConfigPreparation {
  const message =
    `Auto Mode config conflict: using ${currentPath}; legacy config ${legacyPath} is ignored and was not changed.`;
  return {
    status: "conflict",
    activePath: currentPath,
    diagnostic: message,
    notification: message,
  };
}

/** Select one global config path for this runtime and migrate a legacy file when possible. */
export function prepareGlobalConfig(
  options: PrepareGlobalConfigOptions = {},
): GlobalConfigPreparation {
  const currentPath = options.currentPath ?? PI_GLOBAL_SETTINGS[0];
  const legacyPath = options.legacyPath ?? PI_LEGACY_GLOBAL_SETTINGS;
  const currentExists = existsSync(currentPath);
  const legacyExists = existsSync(legacyPath);
  const unlinkFile = options.unlinkFile ?? unlinkSync;
  const linkFile = options.linkFile ?? linkSync;

  if (currentExists && legacyExists) {
    if (!sameFileIdentity(currentPath, legacyPath)) {
      return globalConfigConflict(currentPath, legacyPath);
    }
    try {
      unlinkFile(legacyPath);
      return {
        status: "migrated",
        activePath: currentPath,
        notification:
          `Completed interrupted Auto Mode config migration from ${legacyPath} to ${currentPath}.`,
      };
    } catch (error) {
      const cleanupError = cleanupPublishedDestination(
        currentPath,
        unlinkFile,
        error,
      );
      return globalConfigFailure(
        currentPath,
        legacyPath,
        cleanupError ?? error,
        cleanupError?.message,
      );
    }
  }
  if (currentExists || !legacyExists) {
    return { status: "current", activePath: currentPath };
  }

  try {
    mkdirSync(dirname(currentPath), { recursive: true });
    const moveFile = options.moveFile ??
      ((source: string, destination: string) =>
        moveFileWithoutOverwrite(source, destination, linkFile, unlinkFile));
    moveFile(legacyPath, currentPath);
    return {
      status: "migrated",
      activePath: currentPath,
      notification: `Moved Auto Mode config from ${legacyPath} to ${currentPath}.`,
    };
  } catch (error) {
    if (existsSync(currentPath)) {
      if (!sameFileIdentity(currentPath, legacyPath)) {
        return globalConfigConflict(currentPath, legacyPath);
      }
      const cleanupError = cleanupPublishedDestination(
        currentPath,
        unlinkFile,
        error,
      );
      if (cleanupError) {
        return globalConfigFailure(
          currentPath,
          legacyPath,
          cleanupError,
          cleanupError.message,
        );
      }
    }
    return globalConfigFailure(currentPath, legacyPath, error);
  }
}

function readSettingsFile(path: string): LoadedSettingsFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
    return {
      path,
      settings,
      diagnostics: validateSettingsFile(settings, path),
    };
  } catch (error) {
    return {
      path,
      diagnostics: [
        `${path}: invalid JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      ],
    };
  }
}

function validateStringArraySetting(
  value: unknown,
  source: string,
  key: string,
  diagnostics: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(`${source}: ${key} must be an array of strings`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      diagnostics.push(
        `${source}: ${key}[${index}] must be a non-empty string`,
      );
    }
  }
  if (value.length > 0 && !value.includes("$defaults")) {
    diagnostics.push(
      `${source}: ${key} omits "$defaults" and replaces the built-in ${key} rules`,
    );
  }
}

/** Validate config shape and emit human-readable diagnostics for `/automode config`. */
export function validateSettingsFile(
  settings: SettingsFile,
  source: string,
): string[] {
  const diagnostics: string[] = [];
  const root = settings as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "autoMode" && key !== "permissions") {
      diagnostics.push(`${source}: unknown top-level key ${key}`);
    }
  }

  if (settings.autoMode !== undefined) {
    if (
      !settings.autoMode ||
      typeof settings.autoMode !== "object" ||
      Array.isArray(settings.autoMode)
    ) {
      diagnostics.push(`${source}: autoMode must be an object`);
    } else {
      const autoMode = settings.autoMode as Record<string, unknown>;
      const knownAutoMode = new Set([
        "enabled",
        "classifierModel",
        "classifierReasoningLevel",
        "classifierTimeoutMs",
        "classifyReadOnlyTools",
        "classifierStrategy",
        "judgeConfidence",
        "fastClassifierMaxTokens",
        "allowInsideWorkingDirectory",
        "headlessAsk",
        "deniedPaths",
        "allowReadOnlyBash",
        "readOnlyRoots",
        "maxUserTranscriptTokens",
        "maxToolTranscriptTokens",
        "environment",
        "allow",
        "protectedPaths",
        "soft_deny",
        "softDeny",
        "hard_deny",
        "hardDeny",
        "log",
      ]);
      for (const key of Object.keys(autoMode)) {
        if (!knownAutoMode.has(key)) {
          diagnostics.push(`${source}: unknown autoMode key ${key}`);
        }
      }
      if (
        hasOwn(autoMode, "enabled") && typeof autoMode.enabled !== "boolean"
      ) {
        diagnostics.push(`${source}: autoMode.enabled must be a boolean`);
      }
      if (
        hasOwn(autoMode, "classifierModel") &&
        !isValidClassifierModel(autoMode.classifierModel)
      ) {
        diagnostics.push(
          `${source}: autoMode.classifierModel must be a provider/model string or an @role selector`,
        );
      }
      if (
        hasOwn(autoMode, "classifierReasoningLevel") &&
        !isClassifierReasoningLevel(autoMode.classifierReasoningLevel)
      ) {
        diagnostics.push(
          `${source}: autoMode.classifierReasoningLevel must be one of low, medium, high, xhigh, max`,
        );
      }
      if (
        hasOwn(autoMode, "classifierTimeoutMs") &&
        (!Number.isInteger(autoMode.classifierTimeoutMs) ||
          (autoMode.classifierTimeoutMs as number) < 1000 ||
          (autoMode.classifierTimeoutMs as number) > MAX_CLASSIFIER_TIMEOUT_MS)
      ) {
        diagnostics.push(
          `${source}: autoMode.classifierTimeoutMs must be an integer from 1000 through ${MAX_CLASSIFIER_TIMEOUT_MS}`,
        );
      }
      if (
        hasOwn(autoMode, "classifyReadOnlyTools") &&
        typeof autoMode.classifyReadOnlyTools !== "boolean"
      ) {
        diagnostics.push(
          `${source}: autoMode.classifyReadOnlyTools must be a boolean`,
        );
      }
      if (
        hasOwn(autoMode, "classifierStrategy") &&
        !isClassifierStrategy(autoMode.classifierStrategy)
      ) {
        diagnostics.push(
          `${source}: autoMode.classifierStrategy must be one of ${CLASSIFIER_STRATEGIES.join(", ")}`,
        );
      }
      if (
        hasOwn(autoMode, "judgeConfidence") &&
        !isJudgeConfidence(autoMode.judgeConfidence)
      ) {
        diagnostics.push(
          `${source}: autoMode.judgeConfidence must be a number above 0.5 and at most 1`,
        );
      }
      if (
        hasOwn(autoMode, "fastClassifierMaxTokens") &&
        (!Number.isInteger(autoMode.fastClassifierMaxTokens) ||
          (autoMode.fastClassifierMaxTokens as number) < 16)
      ) {
        diagnostics.push(
          `${source}: autoMode.fastClassifierMaxTokens must be an integer of at least 16`,
        );
      }
      if (
        hasOwn(autoMode, "allowInsideWorkingDirectory") &&
        typeof autoMode.allowInsideWorkingDirectory !== "boolean"
      ) {
        diagnostics.push(
          `${source}: autoMode.allowInsideWorkingDirectory must be a boolean`,
        );
      }
      if (
        hasOwn(autoMode, "headlessAsk") &&
        !isHeadlessAskMode(autoMode.headlessAsk)
      ) {
        diagnostics.push(
          `${source}: autoMode.headlessAsk must be one of ${HEADLESS_ASK_MODES.join(", ")}`,
        );
      }
      if (
        hasOwn(autoMode, "allowReadOnlyBash") &&
        typeof autoMode.allowReadOnlyBash !== "boolean"
      ) {
        diagnostics.push(
          `${source}: autoMode.allowReadOnlyBash must be a boolean`,
        );
      }
      validateReadOnlyRootsSetting(
        autoMode.readOnlyRoots,
        source,
        diagnostics,
      );
      validateDeniedPathsSetting(
        autoMode.deniedPaths,
        source,
        diagnostics,
      );
      for (
        const key of [
          "maxUserTranscriptTokens",
          "maxToolTranscriptTokens",
        ] as const
      ) {
        if (
          hasOwn(autoMode, key) &&
          (!Number.isInteger(autoMode[key]) || Number(autoMode[key]) < 32)
        ) {
          diagnostics.push(
            `${source}: autoMode.${key} must be an integer of at least 32`,
          );
        }
      }
      validateStringArraySetting(
        autoMode.environment,
        source,
        "autoMode.environment",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.allow,
        source,
        "autoMode.allow",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.protectedPaths,
        source,
        "autoMode.protectedPaths",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.soft_deny ?? autoMode.softDeny,
        source,
        "autoMode.soft_deny",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.hard_deny ?? autoMode.hardDeny,
        source,
        "autoMode.hard_deny",
        diagnostics,
      );
      if (hasOwn(autoMode, "log")) {
        validateLogSetting(autoMode.log, source, diagnostics);
      }
    }
  }

  if (settings.permissions !== undefined) {
    if (
      !settings.permissions ||
      typeof settings.permissions !== "object" ||
      Array.isArray(settings.permissions)
    ) {
      diagnostics.push(`${source}: permissions must be an object`);
    } else {
      const permissions = settings.permissions as Record<string, unknown>;
      for (const key of Object.keys(permissions)) {
        if (key !== "deny" && key !== "ask" && key !== "allow") {
          diagnostics.push(`${source}: unknown permissions key ${key}`);
        }
      }
      for (const key of ["deny", "ask", "allow"] as const) {
        const value = permissions[key];
        if (value === undefined) continue;
        if (!Array.isArray(value)) {
          diagnostics.push(
            `${source}: permissions.${key} must be an array of tool patterns`,
          );
          continue;
        }
        for (const [index, entry] of value.entries()) {
          const pattern = parseToolPattern(entry);
          if (typeof entry !== "string" || !pattern) {
            diagnostics.push(
              `${source}: permissions.${key}[${index}] must be a tool pattern string`,
            );
          } else if (entry.length > MAX_WILDCARD_PATTERN_LENGTH) {
            diagnostics.push(
              `${source}: permissions.${key}[${index}] must be at most ${MAX_WILDCARD_PATTERN_LENGTH} characters`,
            );
          } else if (key === "deny" && isMalformedToolPattern(pattern)) {
            diagnostics.push(
              `${source}: permissions.${key}[${index}] must be a tool pattern string`,
            );
          }
        }
      }
    }
  }

  return diagnostics;
}

type RuleAccumulator = {
  defaults: string[];
  includeDefaults: boolean;
  entries: string[];
};

function createRuleAccumulator(defaults: string[]): RuleAccumulator {
  return { defaults, includeDefaults: true, entries: [] };
}

function applyRuleSetting(
  accumulator: RuleAccumulator,
  value: unknown,
  acceptEntry: (entry: string) => boolean = () => true,
): void {
  const entries = stringArray(value);
  if (!entries) return;
  // Any entry that stringArray or acceptEntry drops marks the list malformed.
  // Fail conservative: keep defaults rather than replace them with a partial list.
  let malformed = Array.isArray(value) && value.length !== entries.length;
  for (const entry of entries) {
    if (entry === "$defaults") continue;
    if (acceptEntry(entry)) {
      accumulator.entries.push(entry);
    } else {
      malformed = true;
    }
  }
  accumulator.includeDefaults = entries.includes("$defaults") || malformed;
}

function finalizeRuleSetting(accumulator: RuleAccumulator): string[] {
  const base = accumulator.includeDefaults ? accumulator.defaults : [];
  return [...new Set([...base, ...accumulator.entries])];
}

function validateLogSetting(
  value: unknown,
  source: string,
  diagnostics: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(`${source}: autoMode.log must be an object`);
    return;
  }
  const log = value as Record<string, unknown>;
  if (hasOwn(log, "enabled") && typeof log.enabled !== "boolean") {
    diagnostics.push(`${source}: autoMode.log.enabled must be a boolean`);
  }
  if (
    hasOwn(log, "classifierIo") && typeof log.classifierIo !== "boolean"
  ) {
    diagnostics.push(`${source}: autoMode.log.classifierIo must be a boolean`);
  }
}

function mergeLog(
  base: LogConfig,
  patch: Partial<LogConfig> | undefined,
): LogConfig {
  if (!patch) return base;
  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : base.enabled,
    classifierIo: typeof patch.classifierIo === "boolean" ? patch.classifierIo : base.classifierIo,
  };
}

/**
 * Validate `deniedPaths`: an array of non-empty path patterns. Unlike the
 * `$defaults` rule lists there is no built-in default list, so `$defaults` is
 * a no-op (accepted for consistency with the other rule lists) and omitting
 * it is not a diagnostic.
 */
function validateDeniedPathsSetting(
  value: unknown,
  source: string,
  diagnostics: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(`${source}: deniedPaths must be an array of strings`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (entry === "$defaults") continue;
    if (typeof entry !== "string" || entry.trim() === "") {
      diagnostics.push(
        `${source}: deniedPaths[${index}] must be a non-empty path pattern`,
      );
      continue;
    }
    if (entry.length > MAX_WILDCARD_PATTERN_LENGTH) {
      diagnostics.push(
        `${source}: deniedPaths[${index}] must be at most ${MAX_WILDCARD_PATTERN_LENGTH} characters`,
      );
      continue;
    }
    if (!DENIED_PATH_PATTERN_PREFIX.test(entry)) {
      diagnostics.push(
        `${source}: deniedPaths[${index}] "${entry}" can never match a resolved absolute path; start it with *, ~, $HOME, \${HOME}, or / (e.g. "**/${entry}")`,
      );
    }
  }
}

/**
 * Validate `readOnlyRoots`: absolute directories (after `~`/`$HOME`
 * expansion) that are not the filesystem root, the home directory, or a system
 * root. Invalid entries are reported here and dropped when the config is built.
 */
function validateReadOnlyRootsSetting(
  value: unknown,
  source: string,
  diagnostics: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(`${source}: readOnlyRoots must be an array of strings`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (entry === "$defaults") continue;
    if (typeof entry !== "string" || entry.trim() === "") {
      diagnostics.push(
        `${source}: readOnlyRoots[${index}] must be a non-empty absolute path`,
      );
      continue;
    }
    const problem = readOnlyRootProblem(entry);
    if (problem) {
      diagnostics.push(
        `${source}: readOnlyRoots[${index}] "${entry}" is ignored: ${problem}`,
      );
    }
  }
}

/**
 * A pattern can only match a resolved absolute path when it starts with a
 * form that anchors it: a leading `/`, a home expansion (`~`, `$HOME`,
 * `${HOME}`), or a `*` wildcard that absorbs the leading slash. Anything else
 * (e.g. `config.json` or `src/secret.txt`) matches only against the bare
 * relative name, which the matcher never sees.
 */
const DENIED_PATH_PATTERN_PREFIX =
  /^(?:\/|~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}(?:\/|$)|\*)/;

export const CLASSIFIER_REASONING_LEVELS: readonly ClassifierReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isClassifierReasoningLevel(
  value: unknown,
): value is ClassifierReasoningLevel {
  return typeof value === "string" &&
    (CLASSIFIER_REASONING_LEVELS as readonly string[]).includes(value);
}

function isValidClassifierModel(value: unknown): value is string {
  return typeof value === "string" &&
    parseClassifierSelector(value) !== undefined;
}

function isHeadlessAskMode(value: unknown): value is HeadlessAskMode {
  return HEADLESS_ASK_MODES.includes(value as HeadlessAskMode);
}

function validTranscriptBudget(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 32;
}

function validFastClassifierBudget(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 16;
}

function validClassifierTimeout(value: unknown): value is number {
  return Number.isInteger(value) &&
    Number(value) >= 1000 &&
    Number(value) <= MAX_CLASSIFIER_TIMEOUT_MS;
}

function applyAutoModeScalars(
  base: EffectiveConfig,
  settings: AutoModeSettings | undefined,
): EffectiveConfig {
  if (!settings) return base;
  return {
    ...base,
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : base.enabled,
    classifierModel: isValidClassifierModel(settings.classifierModel)
      ? settings.classifierModel
      : base.classifierModel,
    classifierReasoningLevel: isClassifierReasoningLevel(
        settings.classifierReasoningLevel,
      )
      ? settings.classifierReasoningLevel
      : base.classifierReasoningLevel,
    classifyReadOnlyTools: typeof settings.classifyReadOnlyTools === "boolean"
      ? settings.classifyReadOnlyTools
      : base.classifyReadOnlyTools,
    classifierStrategy: isClassifierStrategy(settings.classifierStrategy)
      ? settings.classifierStrategy
      : base.classifierStrategy,
    judgeConfidence: isJudgeConfidence(settings.judgeConfidence)
      ? settings.judgeConfidence
      : base.judgeConfidence,
    allowInsideWorkingDirectory:
      typeof settings.allowInsideWorkingDirectory === "boolean"
        ? settings.allowInsideWorkingDirectory
        : base.allowInsideWorkingDirectory,
    headlessAsk: isHeadlessAskMode(settings.headlessAsk)
      ? settings.headlessAsk
      : base.headlessAsk,
    allowReadOnlyBash: typeof settings.allowReadOnlyBash === "boolean"
      ? settings.allowReadOnlyBash
      : base.allowReadOnlyBash,
    fastClassifierMaxTokens: validFastClassifierBudget(
        settings.fastClassifierMaxTokens,
      )
      ? settings.fastClassifierMaxTokens
      : base.fastClassifierMaxTokens,
    classifierTimeoutMs: validClassifierTimeout(settings.classifierTimeoutMs)
      ? settings.classifierTimeoutMs
      : base.classifierTimeoutMs,
    maxUserTranscriptTokens: validTranscriptBudget(
        settings.maxUserTranscriptTokens,
      )
      ? settings.maxUserTranscriptTokens
      : base.maxUserTranscriptTokens,
    maxToolTranscriptTokens: validTranscriptBudget(
        settings.maxToolTranscriptTokens,
      )
      ? settings.maxToolTranscriptTokens
      : base.maxToolTranscriptTokens,
    log: mergeLog(base.log, settings.log),
  };
}

const LOG_SETTING_PREFIX = "log.";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** The same value checks `applyAutoModeScalars` applies, keyed by setting. */
const SETTING_VALIDATORS: Record<SettingId, (value: unknown) => boolean> = {
  enabled: isBoolean,
  classifierStrategy: isClassifierStrategy,
  classifierModel: isValidClassifierModel,
  judgeConfidence: isJudgeConfidence,
  classifierReasoningLevel: isClassifierReasoningLevel,
  "log.enabled": isBoolean,
  "log.classifierIo": isBoolean,
};

// Object.keys is string[]; the table above is keyed by exactly SettingId.
const SETTING_IDS = Object.keys(SETTING_VALIDATORS) as SettingId[];

const DEFAULT_SETTING_SOURCE: SettingSource = { kind: "default" };
const INLINE_SETTING_SOURCE: SettingSource = { kind: "inline" };

/** One settings file or the inline JSON, with where it came from. */
type SettingsLayer = { source: SettingSource; settings: SettingsFile };

function readSetting(autoMode: unknown, id: SettingId): unknown {
  if (!isPlainObject(autoMode)) return undefined;
  if (!id.startsWith(LOG_SETTING_PREFIX)) return autoMode[id];
  const log = autoMode.log;
  return isPlainObject(log) ? log[id.slice(LOG_SETTING_PREFIX.length)] : undefined;
}

/**
 * The source that supplies each editable setting: the last layer with a valid
 * value, matching how the merge lets later layers win and ignore invalid values.
 */
function settingsProvenance(
  layers: readonly SettingsLayer[],
): SettingsProvenance {
  // fromEntries loses the key type; every SettingId gets an entry.
  return Object.fromEntries(
    SETTING_IDS.map((id) => [
      id,
      layers.findLast((layer) =>
        SETTING_VALIDATORS[id](readSetting(layer.settings.autoMode, id))
      )?.source ?? DEFAULT_SETTING_SOURCE,
    ]),
  ) as SettingsProvenance;
}

function fileLayers(
  files: Array<LoadedSettingsFile | undefined>,
  kind: "global" | "project-local",
): SettingsLayer[] {
  return files.flatMap((file) =>
    file?.settings ? [{ source: { kind, path: file.path }, settings: file.settings }] : []
  );
}

function appendPermissionPatterns(
  target: ToolPattern[],
  settings: SettingsFile | undefined,
  key: "deny" | "ask" | "allow",
): void {
  const values = stringArray(settings?.permissions?.[key]);
  if (!values) return;
  for (const value of values) {
    if (value.length > MAX_WILDCARD_PATTERN_LENGTH) continue;
    const pattern = parseToolPattern(value);
    if (pattern) target.push(pattern);
  }
}

/** Scope whose `autoMode.enabled` wins, in the same order scalars are applied. */
function enabledSourceOf(sources: SettingsSources): ConfigScope {
  const scopes = [
    ["global", sources.globalSettings],
    ["project-local", sources.projectLocalSettings],
    ["inline", sources.inlineSettings],
  ] as const;
  let source: ConfigScope = "default";
  for (const [scope, files] of scopes) {
    if (files?.some((file) => typeof file.autoMode?.enabled === "boolean")) {
      source = scope;
    }
  }
  return source;
}

/**
 * Merge settings with Claude Code-style precedence using Pi-owned config files.
 *
 * Important details:
 * - shared project `.pi/automode.json` contributes `permissions.deny` and
 *   `permissions.ask` but not `permissions.allow` or `autoMode`, so checked-in
 *   config can only add permission barriers;
 * - global, project-local, and inline `autoMode` settings combine additively across scopes;
 * - omitting `$defaults` in any scope for a rule list means "replace built-ins" for that list.
 */
export function buildEffectiveConfigFromSources(
  sources: SettingsSources = {},
): EffectiveConfig {
  let config: EffectiveConfig = {
    enabled: true,
    classifyReadOnlyTools: DEFAULT_CLASSIFY_READ_ONLY_TOOLS,
    classifierStrategy: DEFAULT_CLASSIFIER_STRATEGY,
    judgeConfidence: DEFAULT_JUDGE_CONFIDENCE,
    allowInsideWorkingDirectory: DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY,
    headlessAsk: DEFAULT_HEADLESS_ASK,
    deniedPaths: [...DEFAULT_DENIED_PATHS],
    allowReadOnlyBash: DEFAULT_ALLOW_READ_ONLY_BASH,
    readOnlyRoots: [...DEFAULT_READ_ONLY_ROOTS],
    fastClassifierMaxTokens: DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
    classifierTimeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
    maxUserTranscriptTokens: DEFAULT_MAX_USER_TRANSCRIPT_TOKENS,
    maxToolTranscriptTokens: DEFAULT_MAX_TOOL_TRANSCRIPT_TOKENS,
    environment: [...DEFAULT_ENVIRONMENT],
    allow: [...DEFAULT_ALLOW],
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    softDeny: [...DEFAULT_SOFT_DENY],
    hardDeny: [...DEFAULT_HARD_DENY],
    permissionDeny: [],
    permissionAsk: [],
    permissionAllow: [],
    log: { ...DEFAULT_LOG_CONFIG },
  };

  const globalSettings = sources.globalSettings ?? [];
  const projectLocalSettings = sources.projectLocalSettings ?? [];
  const projectSharedSettings = sources.projectSharedSettings ?? [];
  const inlineSettings = sources.inlineSettings ?? [];

  const configurableSettings = [
    ...globalSettings,
    ...projectLocalSettings,
    ...inlineSettings,
  ];
  const environment = createRuleAccumulator(DEFAULT_ENVIRONMENT);
  const allow = createRuleAccumulator(DEFAULT_ALLOW);
  const protectedPaths = createRuleAccumulator(DEFAULT_PROTECTED_PATHS);
  const deniedPaths = createRuleAccumulator(DEFAULT_DENIED_PATHS);
  const readOnlyRoots = createRuleAccumulator(DEFAULT_READ_ONLY_ROOTS);
  const softDeny = createRuleAccumulator(DEFAULT_SOFT_DENY);
  const hardDeny = createRuleAccumulator(DEFAULT_HARD_DENY);

  for (const settings of configurableSettings) {
    config = applyAutoModeScalars(config, settings.autoMode);
    applyRuleSetting(environment, settings.autoMode?.environment);
    applyRuleSetting(allow, settings.autoMode?.allow);
    applyRuleSetting(protectedPaths, settings.autoMode?.protectedPaths);
    applyRuleSetting(
      deniedPaths,
      settings.autoMode?.deniedPaths,
      (entry) => entry.length <= MAX_WILDCARD_PATTERN_LENGTH,
    );
    applyRuleSetting(
      readOnlyRoots,
      settings.autoMode?.readOnlyRoots,
      (entry) => readOnlyRootProblem(entry) === undefined,
    );
    applyRuleSetting(
      softDeny,
      settings.autoMode?.soft_deny ?? settings.autoMode?.softDeny,
    );
    applyRuleSetting(
      hardDeny,
      settings.autoMode?.hard_deny ?? settings.autoMode?.hardDeny,
    );
  }

  config = {
    ...config,
    environment: finalizeRuleSetting(environment),
    allow: finalizeRuleSetting(allow),
    protectedPaths: finalizeRuleSetting(protectedPaths),
    deniedPaths: finalizeRuleSetting(deniedPaths),
    readOnlyRoots: finalizeRuleSetting(readOnlyRoots),
    softDeny: finalizeRuleSetting(softDeny),
    hardDeny: finalizeRuleSetting(hardDeny),
    enabledSource: enabledSourceOf(sources),
  };

  for (
    const settings of [
      ...globalSettings,
      ...projectSharedSettings,
      ...projectLocalSettings,
      ...inlineSettings,
    ]
  ) {
    appendPermissionPatterns(config.permissionDeny, settings, "deny");
    appendPermissionPatterns(config.permissionAsk, settings, "ask");
  }
  for (
    const settings of [
      ...globalSettings,
      ...projectLocalSettings,
      ...inlineSettings,
    ]
  ) {
    appendPermissionPatterns(config.permissionAllow, settings, "allow");
  }

  return config;
}

function loadedSettingsToSettings(
  files: Array<LoadedSettingsFile | undefined>,
): SettingsFile[] {
  return files.flatMap((file) => (file?.settings ? [file.settings] : []));
}

function loadedSettingsDiagnostics(
  files: Array<LoadedSettingsFile | undefined>,
): string[] {
  return files.flatMap((file) => file?.diagnostics ?? []);
}

function ignoredSharedAllowDiagnostics(
  files: Array<LoadedSettingsFile | undefined>,
): string[] {
  return files.flatMap((file) => {
    const permissions = file?.settings?.permissions;
    if (!file || !permissions || !hasOwn(permissions, "allow")) return [];
    return [
      `${file.path}: permissions.allow is ignored in shared project config. Use a user-owned config source instead`,
    ];
  });
}

type ProjectSettingsSelection = {
  /** Path that is read when the project is trusted. */
  path: string;
  /** Every location that could hold this file, most preferred first. */
  candidates: string[];
  diagnostics: string[];
};

/**
 * Choose the project settings file for one file name. The first config
 * directory that holds the file wins. A later directory is a legacy location:
 * it is used only when the preferred one lacks the file, and never moved.
 */
function selectProjectSettingsPath(
  cwd: string,
  fileName: string,
  projectConfigDirs: string[],
): ProjectSettingsSelection {
  const candidates = projectConfigDirs.map((dir) => resolve(cwd, dir, fileName));
  const preferred = candidates[0] ?? resolve(cwd, PI_PROJECT_DIR, fileName);
  const existing = candidates.filter(existsSync);
  const [active, ...ignored] = existing;
  if (active === undefined) {
    return { path: preferred, candidates, diagnostics: [] };
  }
  const diagnostics = ignored.map((path) =>
    `${path}: ignored because ${active} exists`
  );
  if (active !== preferred) {
    diagnostics.push(
      `${active}: using legacy project config location; move it to ${preferred}`,
    );
  }
  return { path: active, candidates, diagnostics };
}

/** Load config from disk and environment variables, including diagnostics for `/automode config`. Project files require explicit trust. */
export function loadEffectiveConfigWithDiagnostics(
  cwd: string,
  projectTrusted = false,
  globalSettingsPath = PI_GLOBAL_SETTINGS[0],
  projectConfigDirs: string[] = [PI_PROJECT_DIR],
): ConfigLoadResult {
  const inlineSettings: SettingsFile[] = [];
  const diagnostics: string[] = [];
  if (process.env.PI_AUTOMODE_SETTINGS_JSON) {
    try {
      const parsed = JSON.parse(
        process.env.PI_AUTOMODE_SETTINGS_JSON,
      ) as SettingsFile;
      inlineSettings.push(parsed);
      diagnostics.push(
        ...validateSettingsFile(parsed, "PI_AUTOMODE_SETTINGS_JSON"),
      );
    } catch (error) {
      diagnostics.push(
        `PI_AUTOMODE_SETTINGS_JSON: invalid JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  const globalFiles = [readSettingsFile(globalSettingsPath)];
  const projectLocal = selectProjectSettingsPath(
    cwd,
    PROJECT_LOCAL_SETTINGS_FILE,
    projectConfigDirs,
  );
  const projectShared = selectProjectSettingsPath(
    cwd,
    PROJECT_SHARED_SETTINGS_FILE,
    projectConfigDirs,
  );
  const projectLocalFiles = projectTrusted
    ? [readSettingsFile(projectLocal.path)]
    : [];
  const projectSharedFiles = projectTrusted
    ? [readSettingsFile(projectShared.path)]
    : [];
  if (projectTrusted) {
    diagnostics.push(...projectLocal.diagnostics, ...projectShared.diagnostics);
  } else {
    for (
      const path of [...projectLocal.candidates, ...projectShared.candidates]
        .filter(existsSync)
    ) {
      diagnostics.push(`${path}: ignored because project is not trusted`);
    }
  }
  const fileDiagnostics = loadedSettingsDiagnostics([
    ...globalFiles,
    ...projectLocalFiles,
    ...projectSharedFiles,
  ]);
  const sharedAllowDiagnostics = ignoredSharedAllowDiagnostics(
    projectSharedFiles,
  );

  return {
    config: buildEffectiveConfigFromSources({
      globalSettings: loadedSettingsToSettings(globalFiles),
      projectLocalSettings: loadedSettingsToSettings(projectLocalFiles),
      projectSharedSettings: loadedSettingsToSettings(projectSharedFiles),
      inlineSettings,
    }),
    diagnostics: [
      ...fileDiagnostics,
      ...sharedAllowDiagnostics,
      ...diagnostics,
    ],
    sources: {
      global: globalSettingsPath,
      projectLocal: projectLocal.path,
      projectShared: projectShared.path,
    },
    provenance: settingsProvenance([
      ...fileLayers(globalFiles, "global"),
      ...fileLayers(projectLocalFiles, "project-local"),
      ...inlineSettings.map((settings) => ({
        source: INLINE_SETTING_SOURCE,
        settings,
      })),
    ]),
  };
}

/** Load config from disk and environment variables. Exported for tests and diagnostics. */
export function loadEffectiveConfig(
  cwd: string,
  projectTrusted = false,
  globalSettingsPath = PI_GLOBAL_SETTINGS[0],
  projectConfigDirs: string[] = [PI_PROJECT_DIR],
): EffectiveConfig {
  return loadEffectiveConfigWithDiagnostics(
    cwd,
    projectTrusted,
    globalSettingsPath,
    projectConfigDirs,
  ).config;
}

function readWritableSettingsFile(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: root must be a JSON object`);
  }
  const settings = parsed as SettingsFile;
  if (
    settings.autoMode !== undefined &&
    (!settings.autoMode ||
      typeof settings.autoMode !== "object" ||
      Array.isArray(settings.autoMode))
  ) {
    throw new Error(`${path}: autoMode must be a JSON object`);
  }
  return settings;
}

/**
 * Persist one editable setting in the global config while preserving every
 * other key. Rejects values the loader would ignore, so a saved setting always
 * takes effect.
 */
export function writeGlobalSetting(
  update: SettingUpdate,
  path = PI_GLOBAL_SETTINGS[0],
): void {
  const { key, value } = update;
  const removesKey = key === "classifierReasoningLevel" && value === undefined;
  if (
    !hasOwn(SETTING_VALIDATORS, key) ||
    (!removesKey && !SETTING_VALIDATORS[key](value))
  ) {
    throw new Error(
      `Invalid value for autoMode.${key}: ${JSON.stringify(value) ?? "undefined"}`,
    );
  }
  const settings = readWritableSettingsFile(path);
  const autoMode: Record<string, unknown> = { ...settings.autoMode };
  if (key.startsWith(LOG_SETTING_PREFIX)) {
    const log = autoMode.log;
    if (log !== undefined && !isPlainObject(log)) {
      throw new Error(`${path}: autoMode.log must be a JSON object`);
    }
    autoMode.log = { ...log, [key.slice(LOG_SETTING_PREFIX.length)]: value };
  } else if (removesKey) {
    delete autoMode[key];
  } else {
    autoMode[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ ...settings, autoMode }, null, 2)}\n`,
    "utf8",
  );
}

/** Persist the global default classifier model while preserving other settings. */
export function writeGlobalClassifierModel(
  classifierModel: string,
  path = PI_GLOBAL_SETTINGS[0],
): void {
  writeGlobalSetting({ key: "classifierModel", value: classifierModel }, path);
}
