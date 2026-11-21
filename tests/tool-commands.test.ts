import assert from "node:assert/strict";
import test from "node:test";
import { baseConfig, setupHookTest } from "./test-helpers.ts";
import { type EffectiveConfig, parseToolPattern } from "../extensions/auto-mode.ts";

// OMP 19.1 mounts tools as bash commands (`lsp --action references`). The bash
// call fires one tool_call, then the wrapped tool fires another with id
// `<bash id>:cmd:<n>`. The bash call is reviewed; the wrapped call is not
// classified a second time.

type Decision = { decision: "allow" | "block"; tier: "none"; reason: string };
type Result = { block?: boolean; reason?: string } | undefined;

async function setup(options: {
	config?: EffectiveConfig;
	classify?: (action: string) => Decision;
} = {}) {
	const actions: string[] = [];
	let current = "";
	const harness = await setupHookTest({
		config: options.config,
		classifier: async () => {
			actions.push(current);
			return options.classify?.(current) ?? { decision: "allow", tier: "none", reason: "ok" };
		},
	});
	const call = (toolName: string, toolCallId: string, input: Record<string, unknown>) => {
		current = toolName;
		return harness.emit("tool_call", { toolName, toolCallId, input }, harness.ctx) as Promise<Result>;
	};
	return {
		harness,
		actions,
		bash: (toolCallId: string, command: string) => call("bash", toolCallId, { command }),
		tool: (toolName: string, toolCallId: string, input: Record<string, unknown> = {}) =>
			call(toolName, toolCallId, input),
	};
}

test("a tool command run by a classifier-allowed bash call is not classified again", async () => {
	const t = await setup();
	assert.equal(await t.bash("b1", "lsp --action references --file a.ts && github --op pr_view"), undefined);
	assert.equal(await t.tool("lsp", "b1:cmd:0", { action: "references" }), undefined);
	assert.equal(await t.tool("github", "b1:cmd:1", { op: "pr_view" }), undefined);
	assert.deepEqual(t.actions, ["bash"]);
});

test("a wrapped tool is classified when its bash call was not classifier-allowed", async () => {
	const blocked = await setup({
		classify: (tool) => tool === "bash"
			? { decision: "block", tier: "none", reason: "no" }
			: { decision: "allow", tier: "none", reason: "ok" },
	});
	assert.equal((await blocked.bash("b1", "github --op pr_merge"))?.block, true);
	assert.equal(await blocked.tool("github", "b1:cmd:0", { op: "pr_merge" }), undefined);
	assert.deepEqual(blocked.actions, ["bash", "github"]);

	const allowRule = parseToolPattern("bash(lsp *)");
	assert.ok(allowRule);
	const allowed = await setup({ config: baseConfig({ permissionAllow: [allowRule] }) });
	assert.equal(await allowed.bash("b1", "lsp --action rename"), undefined);
	assert.equal(await allowed.tool("lsp", "b1:cmd:0", { action: "rename" }), undefined);
	assert.deepEqual(allowed.actions, ["lsp"]);
});

test("a wrapped tool is classified unless the bash script names it literally", async () => {
	const t = await setup();
	assert.equal(await t.bash("b1", 'lsp --action hover; "$CMD" --op pr_merge'), undefined);
	await t.tool("github", "b1:cmd:1", { op: "pr_merge" });
	await t.tool("lsp", "other:cmd:0", { action: "rename" });
	await t.tool("lsp", "b1", { action: "rename" });
	assert.deepEqual(t.actions, ["bash", "github", "lsp", "lsp"]);
});

test("a finished bash call no longer vouches for tool commands", async () => {
	const t = await setup();
	await t.bash("b1", "lsp --action hover");
	await t.harness.emit(
		"tool_result",
		{ toolName: "bash", toolCallId: "b1", input: {}, content: [], isError: false },
		t.harness.ctx,
	);
	await t.tool("lsp", "b1:cmd:0", { action: "rename" });
	assert.deepEqual(t.actions, ["bash", "lsp"]);
});

test("permission rules still apply to a tool command run through bash", async () => {
	const deny = parseToolPattern("github");
	assert.ok(deny);
	const denied = await setup({ config: baseConfig({ permissionDeny: [deny] }) });
	await denied.bash("b1", "github --op pr_merge");
	const result = await denied.tool("github", "b1:cmd:0", { op: "pr_merge" });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny/);

	// An accepted ask rule sends the wrapped call to the classifier.
	const ask = parseToolPattern("github");
	assert.ok(ask);
	const asked = await setup({ config: baseConfig({ permissionAsk: [ask] }) });
	await asked.bash("b1", "github --op pr_merge");
	await asked.tool("github", "b1:cmd:0", { op: "pr_merge" });
	assert.deepEqual(asked.actions, ["bash", "github"]);
});

test("automode_inspect run as a bash command skips the classifier", async () => {
	const t = await setup();
	assert.equal(await t.bash("b1", "automode_inspect --action status"), undefined);
	assert.equal(await t.tool("automode_inspect", "b1:cmd:0", { action: "status" }), undefined);
	await t.bash("b2", "automode_inspect --action status; rm -f notes.txt");
	await t.bash("b3", "FOO=1 automode_inspect --action status");
	assert.deepEqual(t.actions, ["bash", "bash"]);
});
