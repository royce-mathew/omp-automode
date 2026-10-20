import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const BASH_CALL = { toolName: "bash", input: { command: "git push origin main" } };

// OMP rebinds the extension factory for every subagent, so each session here
// gets its own fake Pi and extension instance, as in a real OMP process.
async function startSession(options: {
	sessionFile: string;
	agent: { kind: "main" | "sub" };
	parentSession?: string;
	entries?: unknown[];
}) {
	const fake = createFakePi();
	fake.entries.push(...(options.entries ?? []));
	let classifierCalls = 0;
	createPiAutomode({
		loadConfig: () => baseConfig(),
		classifyAction: async () => {
			classifierCalls += 1;
			return { decision: "block", tier: "thinking", reason: "test block" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, {
		sessionFile: options.sessionFile,
		parentSession: options.parentSession,
		agent: options.agent,
		hasUI: options.agent.kind === "main",
	});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return {
		...fake,
		ctx,
		command: (args: string) => fake.commands.get("automode")?.handler(args, ctx),
		toolCall: async () => {
			const result = await fake.emit("tool_call", BASH_CALL, ctx) as { block?: boolean } | undefined;
			return { blocked: result?.block === true, classifierCalls };
		},
	};
}

test("subagents follow the main session's /automode off and on", async () => {
	const main = await startSession({ sessionFile: "/sessions/toggle.jsonl", agent: { kind: "main" } });
	await main.command("off");
	const sub = await startSession({
		sessionFile: "/sessions/toggle/Worker.jsonl",
		agent: { kind: "sub" },
		parentSession: "/sessions/toggle.jsonl",
	});
	const nested = await startSession({
		sessionFile: "/sessions/toggle/Worker/Helper.jsonl",
		agent: { kind: "sub" },
		parentSession: "/sessions/toggle/Worker.jsonl",
	});

	assert.deepEqual(await sub.toolCall(), { blocked: false, classifierCalls: 0 });
	assert.deepEqual(await nested.toolCall(), { blocked: false, classifierCalls: 0 });

	// Already-running subagents pick up the change on their next tool call.
	await main.command("on");
	assert.deepEqual(await sub.toolCall(), { blocked: true, classifierCalls: 1 });
	assert.deepEqual(await nested.toolCall(), { blocked: true, classifierCalls: 1 });
});

test("a revived subagent follows the main session after its earlier run shut down", async () => {
	const main = await startSession({ sessionFile: "/sessions/revive.jsonl", agent: { kind: "main" } });
	const subOptions = {
		sessionFile: "/sessions/revive/Worker.jsonl",
		agent: { kind: "sub" as const },
		parentSession: "/sessions/revive.jsonl",
	};
	const first = await startSession(subOptions);
	await first.emit("session_shutdown", { type: "session_shutdown" }, first.ctx);

	await main.command("off");
	const revived = await startSession({ ...subOptions, entries: first.entries });

	assert.deepEqual(await revived.toolCall(), { blocked: false, classifierCalls: 0 });
});

test("sessions that are not subagents keep their own enabled state", async () => {
	const main = await startSession({ sessionFile: "/sessions/source.jsonl", agent: { kind: "main" } });
	await main.command("off");
	// Forks and /new sessions also name a parent session in their header.
	const fork = await startSession({
		sessionFile: "/sessions/fork.jsonl",
		agent: { kind: "main" },
		parentSession: "/sessions/source.jsonl",
	});

	assert.deepEqual(await fork.toolCall(), { blocked: true, classifierCalls: 1 });
});

test("a resumed main session restores /automode off", async () => {
	const main = await startSession({ sessionFile: "/sessions/resume.jsonl", agent: { kind: "main" } });
	await main.command("off");
	await main.emit("session_shutdown", { type: "session_shutdown" }, main.ctx);

	const resumed = await startSession({
		sessionFile: "/sessions/resume.jsonl",
		agent: { kind: "main" },
		entries: main.entries,
	});

	assert.deepEqual(await resumed.toolCall(), { blocked: false, classifierCalls: 0 });
});
