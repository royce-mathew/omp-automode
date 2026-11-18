import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_HEADLESS_ASK,
	DEFAULT_LOG_CONFIG,
	DEFAULT_PROTECTED_PATHS,
	analyzeBash,
	createPiAutomode,
	type AutoModeState,
	type ClassificationDecision,
	type ClassifyHints,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

const INLINE_SETTINGS_ENV = "PI_AUTOMODE_SETTINGS_JSON";

/** Run `run`, then `cleanup`, whether `run` returns a value or a promise. */
function runThen<T>(run: () => T, cleanup: () => void): T {
	try {
		const result = run();
		if (result instanceof Promise) {
			// `result` is a promise, so T is that promise type.
			return result.finally(cleanup) as T;
		}
		cleanup();
		return result;
	} catch (error) {
		cleanup();
		throw error;
	}
}

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

/** Run with a throwaway directory that is removed afterwards. */
export function withTempDir<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-test-"));
	return runThen(() => run(dir), () => rmSync(dir, { recursive: true, force: true }));
}

/** Run with an environment variable set (or deleted when `value` is undefined), then restore it. */
export function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
	const previous = process.env[name];
	setEnv(name, value);
	return runThen(run, () => setEnv(name, previous));
}

/** Run with `PI_AUTOMODE_SETTINGS_JSON` set to the JSON of `inline`, or unset when `inline` is undefined. */
export function withInline<T>(inline: unknown, run: () => T): T {
	return withEnv(INLINE_SETTINGS_ENV, inline === undefined ? undefined : JSON.stringify(inline), run);
}

const EXTENSION_SOURCE = realpathSync(
	join(dirname(fileURLToPath(import.meta.url)), "../extensions/auto-mode.ts"),
);

export function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler; description?: string }>();
	const tools = new Map<string, {
		execute: (...args: any[]) => any;
		sourceInfo: { path: string };
	}>();
	const entries: any[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		registerCommand(name: string, command: { handler: Handler; description?: string }) {
			commands.set(name, command);
		},
		registerTool(tool: {
			name: string;
			execute: (...args: any[]) => any;
			sourceInfo?: { path: string };
		}) {
			if (tools.has(tool.name)) return;
			tools.set(tool.name, {
				execute: tool.execute,
				sourceInfo: tool.sourceInfo ?? { path: EXTENSION_SOURCE },
			});
		},
		getAllTools() {
			return [...tools].map(([name, tool]) => ({
				name,
				description: "test tool",
				parameters: {},
				promptGuidelines: [],
				sourceInfo: {
					path: tool.sourceInfo.path,
					source: "test",
					scope: "temporary",
					origin: "package",
				},
			}));
		},
	} as any;

	return {
		pi,
		entries,
		commands,
		tools,
		async emit(event: string, payload: any, ctx: any) {
			// Like OMP, a later handler that returns nothing keeps the result an
			// earlier one produced, such as a revised tool input.
			let lastResult: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const result = await handler(payload, ctx);
				if (result === undefined) continue;
				lastResult = result;
				if ((result as { block?: boolean }).block) return result;
			}
			return lastResult;
		},
	};
}

export function createFakeCtx(entries: any[] = [], overrides: Record<string, unknown> = {}) {
	const { sessionFile, sessionDir, sessionId, parentSession, ...rest } = overrides;
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];

	return {
		cwd: "/tmp/project",
		mode: "tui",
		hasUI: true,
		signal: undefined,
		model: { provider: "test", id: "classifier" },
		modelRegistry: {
			find() {
				return { provider: "test", id: "classifier" };
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			buildContextEntries: () => entries,
			getSessionFile: () => sessionFile as string | undefined,
			getSessionDir: () => typeof sessionDir === "string"
				? sessionDir
				: sessionFile
					? dirname(sessionFile as string)
					: "/tmp",
			getSessionId: () => typeof sessionId === "string" ? sessionId : "test-session",
			getHeader: () => ({
				type: "session",
				id: typeof sessionId === "string" ? sessionId : "test-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/project",
				parentSession: parentSession as string | undefined,
			}),
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			setWidget(key: string, content: string[] | undefined) {
				widgets.push({ key, content });
			},
			async confirm() {
				return true;
			},
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
				bold(text: string) {
					return text;
				},
			},
		},
		statuses,
		notifications,
		isProjectTrusted: () => true,
		getSystemPrompt: () => "",
		...rest,
	};
}

export type FakeCtx = ReturnType<typeof createFakeCtx>;

export function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return {
		enabled: true,
		classifyReadOnlyTools: false,
		classifierStrategy: "staged",
		judgeConfidence: 0.9,
		allowInsideWorkingDirectory: false,
		headlessAsk: DEFAULT_HEADLESS_ASK,
		deniedPaths: [],
		allowReadOnlyBash: false,
		readOnlyRoots: [],
		fastClassifierMaxTokens: 512,
		classifierTimeoutMs: 20_000,
		maxUserTranscriptTokens: 4000,
		maxToolTranscriptTokens: 4000,
		environment: [],
		allow: [],
		protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		softDeny: [],
		hardDeny: [],
		permissionDeny: [],
		permissionAsk: [],
		permissionAllow: [],
		log: { ...DEFAULT_LOG_CONFIG },
		...overrides,
	};
}

export function baseState(overrides: Partial<AutoModeState> = {}): AutoModeState {
	return {
		checkedActions: 0,
		blockedActions: 0,
		classifierAllowed: 0,
		classifierDenied: 0,
		recentDenials: [],
		recentClassifierErrors: [],
		createdPaths: [],
		...overrides,
	};
}

export async function setupHookTest(options: {
	config?: EffectiveConfig;
	classifier?: () => Promise<ClassificationDecision>;
	ctx?: ReturnType<typeof createFakeCtx>;
	analyze?: typeof analyzeBash;
} = {}) {
	const fake = createFakePi();
	let classifierCalls = 0;
	const classifierHints: Array<ClassifyHints | undefined> = [];
	const classifier = options.classifier ?? (async () => ({ decision: "allow", tier: "none", reason: "test allow" }));
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig(),
		classifyAction: async (_ctx, _config, _action, _loadedContext, _notes, _createdPaths, hints) => {
			classifierHints.push(hints);
			classifierCalls += 1;
			return classifier();
		},
		analyzeBash: options.analyze,
	})(fake.pi);
	const ctx = options.ctx ?? createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return {
		...fake,
		ctx,
		get classifierCalls() { return classifierCalls; },
		get classifierHints() { return classifierHints; },
	};
}
