import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseToolPattern } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

for (const [name, target, reason] of [
	["shell profile", join(os.homedir(), ".bashrc"), /shell profile modification is hard-denied/],
	["SSH authorized_keys", join(os.homedir(), ".ssh/authorized_keys"), /SSH authorized_keys modification is hard-denied/],
] as const) {
	for (const linkType of ["direct", "chained", "parent-directory"] as const) {
		test(`Bash redirect through a ${linkType} symlink to ${name} overrides permission allow`, async (t) => {
			const cwd = mkdtempSync(join(os.tmpdir(), "pi-automode-profile-link-"));
			t.after(() => rmSync(cwd, { recursive: true, force: true }));
			if (linkType === "parent-directory") {
				symlinkSync(os.homedir(), join(cwd, "home"), "dir");
				symlinkSync(join(cwd, "home", target.slice(os.homedir().length + 1)), join(cwd, "out.log"));
			} else if (linkType === "chained") {
				symlinkSync(target, join(cwd, "middle.log"));
				symlinkSync("middle.log", join(cwd, "out.log"));
			} else {
				symlinkSync(target, join(cwd, "out.log"));
			}
			const allow = parseToolPattern("bash(printf * >> out.log)");
			assert.ok(allow);
			const harness = await setupHookTest({
				config: baseConfig({ permissionAllow: [allow] }),
				ctx: createFakeCtx([], { cwd }),
				classifier: async () => ({ decision: "allow", tier: "allow", reason: "classifier sentinel" }),
			});

			const result = await harness.emit("tool_call", {
				toolName: "bash",
				input: { command: "printf x >> out.log" },
			}, harness.ctx) as { block?: boolean; reason?: string } | undefined;

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", reason);
			assert.equal(harness.classifierCalls, 0);
		});
	}
}

test("permission allow still permits a Bash redirect through a normal-file symlink", async (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "pi-automode-normal-link-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "normal.log"), "normal fixture");
	symlinkSync("normal.log", join(cwd, "out.log"));
	const allow = parseToolPattern("bash(printf * >> out.log)");
	assert.ok(allow);
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow: [allow] }),
		ctx: createFakeCtx([], { cwd }),
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "classifier sentinel" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "printf x >> out.log" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("symlinked profile and authorized_keys anchors protect canonical targets and lexical names", (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "pi-automode-profile-anchors-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const home = join(cwd, "home");
	const keys = join(cwd, "keys");
	mkdirSync(home);
	mkdirSync(keys);
	writeFileSync(join(cwd, "profile-target"), "profile fixture");
	writeFileSync(join(cwd, "key-target"), "key fixture");
	symlinkSync(join(cwd, "profile-target"), join(home, ".bashrc"));
	symlinkSync(join(cwd, "missing-profile-target"), join(home, ".zshrc"));
	symlinkSync(keys, join(home, ".ssh"), "dir");
	symlinkSync(join(cwd, "key-target"), join(keys, "authorized_keys"));

	const script = `
		import assert from "node:assert/strict";
		import { rmSync, symlinkSync } from "node:fs";
		import { join } from "node:path";
		import { parseToolPattern } from ${JSON.stringify(new URL("../extensions/auto-mode.ts", import.meta.url).href)};
		import { baseConfig, createFakeCtx, setupHookTest } from ${JSON.stringify(new URL("./test-helpers.ts", import.meta.url).href)};
		const cwd = ${JSON.stringify(cwd)};
		const home = ${JSON.stringify(home)};
		const allow = parseToolPattern("bash(printf * >> out.log)");
		assert.ok(allow);
		const harness = await setupHookTest({
			config: baseConfig({ permissionAllow: [allow] }),
			ctx: createFakeCtx([], { cwd }),
			classifier: async () => ({ decision: "allow", tier: "allow", reason: "classifier sentinel" }),
		});
		for (const [anchor, target, reason] of [
			[join(home, ".bashrc"), join(cwd, "profile-target"), /shell profile modification is hard-denied/],
			[join(home, ".zshrc"), join(cwd, "missing-profile-target"), /shell profile modification is hard-denied/],
			[join(home, ".ssh/authorized_keys"), join(cwd, "key-target"), /SSH authorized_keys modification is hard-denied/],
		]) {
			for (const path of [anchor, target]) {
				rmSync(join(cwd, "out.log"), { force: true });
				symlinkSync(path, join(cwd, "out.log"));
				for (const [toolName, input] of [
					["bash", { command: "printf x >> out.log" }],
					["write", { path, content: "not executed" }],
					["edit", { path, oldText: "not executed", newText: "not executed" }],
				]) {
					const result = await harness.emit("tool_call", { toolName, input }, harness.ctx);
					assert.equal(result?.block, true, toolName + ": " + path);
					assert.match(result?.reason ?? "", reason, toolName + ": " + path);
					assert.equal(harness.classifierCalls, 0);
				}
			}
		}
	`;
	const result = spawnSync(process.execPath, [
		"--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
	], {
		cwd,
		env: { ...process.env, HOME: home, USERPROFILE: home },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
});
