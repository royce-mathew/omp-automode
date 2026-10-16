import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	buildClassifierTranscript,
	createPiAutomode,
	defaultClassifyAction,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const QUESTION =
	"May I modify existing files under src/** in /work/parser for the parser task, without deleting files?";
const APPROVAL = `User: Answered ask question "${QUESTION}": Approve scoped edits`;
const BUILTIN_ASK = { path: "<builtin:ask>", source: "builtin" };

type AskSource = { path: string; source: string };
type SessionEntry = Record<string, unknown>;

function askTurn(toolCallId: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "user", content: "Inspect the parser and ask before editing." } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: toolCallId,
					name: "ask",
					arguments: {
						questions: [{
							id: "edit",
							question: QUESTION,
							options: [{ label: "Approve scoped edits" }, { label: "Do not edit" }],
						}],
					},
				}],
			},
		},
	];
}

function askResult(toolCallId: string, isError = false): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "ask",
			content: [{ type: "text", text: "User selected: Approve scoped edits" }],
			isError,
		},
	};
}

function singleAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		question: QUESTION,
		options: ["Approve scoped edits", "Do not edit"],
		multi: false,
		selectedOptions: ["Approve scoped edits"],
		...overrides,
	};
}

async function recordAskAnswer(
	details: unknown,
	options: { source?: AskSource; isError?: boolean; toolCallId?: string } = {},
): Promise<SessionEntry[]> {
	const fake = createFakePi();
	const source = options.source ?? BUILTIN_ASK;
	fake.pi.getAllTools = () => [{
		name: "ask",
		description: "Ask user questions",
		parameters: {},
		promptGuidelines: [],
		sourceInfo: { ...source, scope: "temporary", origin: "top-level" },
	}];
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	await fake.emit("tool_result", {
		type: "tool_result",
		toolName: "ask",
		toolCallId: options.toolCallId ?? "ask-1",
		input: {},
		content: [{ type: "text", text: "User selected: Approve scoped edits" }],
		details,
		isError: options.isError ?? false,
	}, createFakeCtx());
	return fake.entries;
}

function transcript(entries: SessionEntry[]): string {
	return buildClassifierTranscript(createFakeCtx(entries) as never, {
		maxUserTokens: 4000,
		maxToolTokens: 4000,
	});
}

test("answers from OMP's built-in ask tool reach classifier evidence as user authorization", async () => {
	const recorded = await recordAskAnswer(singleAnswer({ note: "Keep the public API unchanged." }));
	const evidence = transcript([
		...askTurn("ask-1"),
		askResult("ask-1"),
		...recorded,
		{ type: "message", message: { role: "user", content: "Actually, do not edit anything yet." } },
	]);

	const approval = `${APPROVAL}; note: Keep the public API unchanged.`;
	assert.ok(evidence.includes(approval), evidence);
	assert.ok(evidence.indexOf(approval) < evidence.indexOf("User: Actually, do not edit anything yet."));
});

test("multi-question ask answers keep user answers and exclude timeout auto-selections", async () => {
	const recorded = await recordAskAnswer({
		results: [
			{ id: "edit", question: QUESTION, options: [], multi: false, selectedOptions: ["Approve scoped edits"] },
			{
				id: "delete",
				question: "May I delete generated parser fixtures?",
				options: [],
				multi: false,
				selectedOptions: ["Approve deletion"],
				timedOut: true,
			},
			{
				id: "scope",
				question: "Which parser files may I modify?",
				options: [],
				multi: true,
				selectedOptions: [],
				customInput: "Only src/parser.ts and src/lexer.ts",
			},
		],
	});
	const evidence = transcript([...askTurn("ask-1"), askResult("ask-1"), ...recorded]);

	assert.deepEqual(evidence.split("\n").filter((line) => line.startsWith("User: Answered ask question")), [
		APPROVAL,
		'User: Answered ask question "Which parser files may I modify?": custom answer: Only src/parser.ts and src/lexer.ts',
	]);
});

test("ask answers do not count without a verified built-in user response", async (t: TestContext) => {
	const cases: Array<{ name: string; entries: () => Promise<SessionEntry[]> }> = [
		{
			name: "same-named extension tool",
			entries: async () => [
				...askTurn("ask-1"),
				askResult("ask-1"),
				...await recordAskAnswer(singleAnswer(), {
					source: { path: "/tmp/fake-ask-extension.ts", source: "extension" },
				}),
			],
		},
		{ name: "persisted result without a captured answer", entries: async () => [...askTurn("ask-1"), askResult("ask-1")] },
		{
			name: "single timeout auto-selection",
			entries: async () => [...askTurn("ask-1"), askResult("ask-1"), ...await recordAskAnswer(singleAnswer({ timedOut: true }))],
		},
		{
			name: "chat redirect",
			entries: async () => [
				...askTurn("ask-1"),
				askResult("ask-1"),
				...await recordAskAnswer({ chatRedirect: true, questions: [QUESTION] }),
			],
		},
		{
			name: "error result",
			entries: async () => [
				...askTurn("ask-1"),
				askResult("ask-1", true),
				...await recordAskAnswer(singleAnswer(), { isError: true }),
			],
		},
		{
			name: "answer no longer present in active context",
			entries: async () => [...askTurn("ask-1"), ...await recordAskAnswer(singleAnswer())],
		},
		{
			name: "answer attached to another tool call",
			entries: async () => [
				...askTurn("ask-1"),
				askResult("ask-1"),
				...await recordAskAnswer(singleAnswer(), { toolCallId: "ask-2" }),
			],
		},
	];

	const positive = transcript([...askTurn("ask-1"), askResult("ask-1"), ...await recordAskAnswer(singleAnswer())]);
	assert.ok(positive.includes(APPROVAL), positive);
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const evidence = transcript(await scenario.entries());
			assert.equal(evidence.includes("Answered ask question"), false, evidence);
		});
	}
});

test("Jev receives verified ask authorization in its classifier context", async (t: TestContext) => {
	const previousKey = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "jev-test-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previousKey;
	});
	let context: unknown;
	t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
		const body: unknown = JSON.parse(String(options.body));
		if (body && typeof body === "object" && "state" in body && body.state && typeof body.state === "object" && "context" in body.state) {
			context = body.state.context;
		}
		const answers = Object.fromEntries(["hard_deny", "soft_deny", "allow_exception", "direct_authorization"].map((key) => [key, {
			type: "choice",
			choice: key === "soft_deny" || key === "direct_authorization" ? "yes" : "no",
			probabilities: { yes: 0.5, no: 0.5 },
			confidence: 0.9,
		}]));
		return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 0 } });
	});
	const entries = [...askTurn("ask-1"), askResult("ask-1"), ...await recordAskAnswer(singleAnswer())];

	const result = await defaultClassifyAction(
		createFakeCtx(entries) as never,
		baseConfig({ classifierModel: "typesafe/jev-latest" }),
		JSON.stringify({ toolName: "edit", input: { path: "src/parser.ts" } }),
		"",
	);

	assert.equal(result.tier, "explicit_intent");
	assert.equal(typeof context === "string" && context.includes(APPROVAL), true, String(context));
});
