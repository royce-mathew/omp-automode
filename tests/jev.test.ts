import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import { defaultClassifyAction, serializeClassifierAction } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx } from "./test-helpers.ts";

test("Jev evaluates the complete action with its API key without a Pi model registration", async (t) => {
	configureJev(t);
	let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
	t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
		request = { url, headers: new Headers(options.headers), body: JSON.parse(String(options.body)) };
		const answers = Object.fromEntries(["hard_deny", "soft_deny", "allow_exception", "direct_authorization"].map((key) => [key, {
			type: "choice", choice: "no", probabilities: { yes: 0.01, no: 0.99 }, confidence: 0.98,
		}]));
		return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 40 } });
	});
	const ctx = createFakeCtx([], { modelRegistry: { find: () => undefined } });
	const action = serializeClassifierAction("write", { path: "src/example.ts", content: "x".repeat(5000) });
	const result = await defaultClassifyAction(ctx as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), action, "Project instructions");
	assert.equal(result.decision, "allow");
	assert.equal(request?.url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(request?.headers.get("authorization"), "Bearer jev-test-key");
	assert.equal(request?.body.model, "jev-latest");
	const state = request?.body.state;
	assert.ok(state && typeof state === "object" && "action" in state);
	assert.equal(state.action, action);
	assert.equal(result.io?.attempts[0].response?.usage.input, 500);
	assert.equal(result.io?.attempts[0].response?.model, "jev-1.13.0");
});

function configureJev(t: TestContext): void {
	const previousKey = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "jev-test-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previousKey;
	});
}

function jevResponse(choices = ["no", "no", "no", "no"]) {
	const answers = Object.fromEntries(["hard_deny", "soft_deny", "allow_exception", "direct_authorization"].map((key, i) => [key, {
		type: "choice", choice: choices[i], probabilities: { yes: choices[i] === "yes" ? 0.99 : 0.01, no: choices[i] === "no" ? 0.99 : 0.01 }, confidence: 0.98,
	}]));
	return { model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 40 } };
}

test("Jev preserves hard-deny precedence and soft-deny overrides", async (t) => {
	configureJev(t);
	const cases = [
		{ choices: ["yes", "yes", "yes", "yes"], decision: "block", tier: "hard_deny" },
		{ choices: ["no", "yes", "no", "no"], decision: "block", tier: "soft_deny" },
		{ choices: ["no", "yes", "yes", "no"], decision: "allow", tier: "allow" },
		{ choices: ["no", "yes", "no", "yes"], decision: "allow", tier: "explicit_intent" },
		{ choices: ["no", "no", "no", "no"], decision: "allow", tier: "none" },
	];
	for (const scenario of cases) {
		await t.test(scenario.tier, async (t) => {
			t.mock.method(globalThis, "fetch", async () => Response.json(jevResponse(scenario.choices)));
			const result = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-1.14.0", classifierReasoningLevel: "low" }), "{}", "");
			assert.deepEqual({ decision: result.decision, tier: result.tier }, { decision: scenario.decision, tier: scenario.tier });
			assert.deepEqual(result.reasoning, { mode: "explicit", requestedLevel: "low", effectiveLevel: "off" });
		});
	}
});

test("Jev blocks malformed and incomplete answers instead of treating them as safe", async (t) => {
	configureJev(t);
	const invalid = [
		null,
		{},
		{ ...jevResponse(), answers: {} },
		{ ...jevResponse(), answers: { ...jevResponse().answers, hard_deny: { type: "choice", choice: "maybe" } } },
		{ ...jevResponse(), answers: { ...jevResponse().answers, hard_deny: { type: "choice", choice: "no", probabilities: { yes: -1, no: 2 }, confidence: 0.9 } } },
		{ ...jevResponse(), usage: { input_tokens: -1, output_tokens: 40 } },
		{ ...jevResponse(), model: "" },
		{ ...jevResponse(), answers: null },
		{ ...jevResponse(), answers: { ...jevResponse().answers, soft_deny: { ...jevResponse().answers.soft_deny, probabilities: null } } },
		{ ...jevResponse(), answers: { ...jevResponse().answers, direct_authorization: { ...jevResponse().answers.direct_authorization, confidence: 1.1 } } },
		{ ...jevResponse(), usage: { input_tokens: 0.5, output_tokens: 40 } },
		{ ...jevResponse(), usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 40 } },
	];
	for (const response of invalid) {
		t.mock.method(globalThis, "fetch", async () => Response.json(response));
		const result = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
		assert.equal(result.decision, "block");
		assert.match(result.reason, /invalid response/);
		t.mock.restoreAll();
	}
	t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
	const malformed = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	assert.equal(malformed.decision, "block");
	assert.match(malformed.reason, /invalid response/);
});

test("Jev blocks missing credentials and provider errors without disclosing keys", async (t) => {
	configureJev(t);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request without credentials"); });
	delete process.env.TYPESAFE_API_KEY;
	const missing = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	assert.equal(missing.decision, "block");
	assert.match(missing.reason, /TYPESAFE_API_KEY/);
	process.env.TYPESAFE_API_KEY = "jev-test-key";
	t.mock.method(globalThis, "fetch", async () => new Response("provider-body-jev-test-key", { status: 401 }));
	const rejected = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	assert.equal(rejected.decision, "block");
	assert.match(rejected.reason, /HTTP 401/);
	assert.equal(JSON.stringify(rejected).includes("jev-test-key"), false);
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", async () => { throw new Error("network failure containing jev-test-key"); });
	const failed = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	assert.equal(failed.decision, "block");
	assert.equal(JSON.stringify(failed).includes("jev-test-key"), false);
});

test("Jev cancellation and deadlines cover response bodies and cannot produce a late allow", async (t) => {
	configureJev(t);
	const body = Promise.withResolvers<string>();
	t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: () => body.promise }));
	const timedOut = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest", classifierTimeoutMs: 10 }), "{}", "");
	assert.equal(timedOut.decision, "block");
	assert.match(timedOut.reason, /timed out/);
	body.resolve(JSON.stringify(jevResponse()));
	await setImmediate();
	assert.deepEqual(timedOut.io?.attempts.map((attempt) => ({ parsed: attempt.parsed, error: attempt.error })), [
		{ parsed: undefined, error: "Jev request timed out; auto mode fails closed." },
	]);
	const controller = new AbortController();
	controller.abort();
	const cancelled = await defaultClassifyAction(createFakeCtx([], { signal: controller.signal }) as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	assert.equal(cancelled.decision, "block");
	assert.match(cancelled.reason, /aborted/);
	t.mock.restoreAll();
	const pendingFetch = Promise.withResolvers<Response>();
	t.mock.method(globalThis, "fetch", () => pendingFetch.promise);
	const activeController = new AbortController();
	const activeRequest = defaultClassifyAction(createFakeCtx([], { signal: activeController.signal }) as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "{}", "");
	activeController.abort();
	const interrupted = await activeRequest;
	assert.equal(interrupted.decision, "block");
	assert.match(interrupted.reason, /aborted/);
});

test("Jev blocks oversized actions without truncating or sending them", async (t) => {
	configureJev(t);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected oversized request"); });
	const result = await defaultClassifyAction(createFakeCtx() as never, baseConfig({ classifierModel: "typesafe/jev-latest" }), "x".repeat(150_000), "");
	assert.equal(result.decision, "block");
	assert.match(result.reason, /without truncation/);
});
