import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";
import { parseToolPattern } from "../extensions/auto-mode.ts";

const permissionAllow = ["bash"].map((raw) => parseToolPattern(raw)!);

for (const command of [
	`cd / && rm -rf ${os.homedir().replace(/^\//, "")}`,
	"cd / && find -L etc -delete",
	"cd / && chmod 777 etc/passwd",
	"cd / && printf marker >> etc/profile",
	"command cd / && rm -rf etc",
	"builtin cd / && rm -rf etc",
	"cd /tmp || cd /; rm -rf etc",
	"bash -c 'cd / && rm -rf etc'",
]) {
	test(`directory changes cannot bypass protected-path checks: ${command}`, async () => {
		const harness = await setupHookTest({
			config: baseConfig({ permissionAllow }),
			ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
		});
		const result = await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(result?.block, true);
		assert.equal(harness.classifierCalls, 0);
	});
}

test("unresolved shell directory changes fail closed for relative destructive targets", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
	});
	for (const command of [
		'cd "$TARGET" && rm -rf relative-target',
		"popd && rm -rf relative-target",
		"cd - && rm -rf relative-target",
		"while test -n x; do cd ..; done; rm -rf relative-target",
	]) {
		const result = await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(result?.block, true, command);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("trusted directory changes preserve routine builds and scoped temporary deletion", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
	});
	for (const command of [
		"cd /etc/nixos && git status",
		"cd /tmp && npm test",
		`cd ${JSON.stringify(os.tmpdir())} && rm -rf automode-created-output`,
	]) {
		assert.equal(await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx), undefined, command);
	}
	assert.equal(harness.classifierCalls, 0);
});
