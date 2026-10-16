import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("A marketplace copy validates native Jev answers without installed dependencies", () => {
	const directory = mkdtempSync(join(os.tmpdir(), "automode-jev-distribution-"));
	try {
		cpSync(new URL("../extensions", import.meta.url), join(directory, "extensions"), { recursive: true });
		const jevUrl = pathToFileURL(join(directory, "extensions/auto-mode/jev.ts")).href;
		const script = `
			import { classifyWithJev } from ${JSON.stringify(jevUrl)};
			const config = { classifierModel: "typesafe/jev-latest", classifierTimeoutMs: 1000 };
			const answers = Object.fromEntries(["hard_deny", "soft_deny", "allow_exception", "direct_authorization"].map((key) => [key, {
				type: "choice", choice: "no", probabilities: { yes: 0, no: 1 }, confidence: 1,
			}]));
			let response = { model: "jev-1.14.0", answers, usage: { input_tokens: 500, output_tokens: 40 } };
			globalThis.fetch = async () => Response.json(response);
			const allowed = await classifyWithJev(config, "echo safe", "", "policy");
			answers.hard_deny = { type: "choice", choice: "yes", probabilities: { yes: 1, no: 0 }, confidence: 1 };
			const denied = await classifyWithJev(config, "echo unsafe", "", "policy");
			response = {};
			const malformed = await classifyWithJev(config, "echo safe", "", "policy");
			console.log(JSON.stringify({
				allowed: { decision: allowed.decision, tier: allowed.tier },
				denied: { decision: denied.decision, tier: denied.tier },
				malformed: { decision: malformed.decision, reason: malformed.reason },
			}));
		`;
		const result = spawnSync(process.execPath, [
			"--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
		], {
			cwd: directory, encoding: "utf8", timeout: 10_000,
			env: { ...process.env, TYPESAFE_API_KEY: "distribution-test-key" },
		});
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.deepEqual(JSON.parse(result.stdout), {
			allowed: { decision: "allow", tier: "none" },
			denied: { decision: "block", tier: "hard_deny" },
			malformed: { decision: "block", reason: "Jev returned an invalid response; auto mode fails closed." },
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
