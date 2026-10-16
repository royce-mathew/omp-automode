import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAX_BASH_SOURCE_LENGTH,
	analyzeBash,
} from "../extensions/auto-mode.ts";

test("Bash analysis works from a marketplace copy without installed dependencies", () => {
	const directory = mkdtempSync(join(os.tmpdir(), "automode-parser-distribution-"));
	try {
		cpSync(new URL("../extensions", import.meta.url), join(directory, "extensions"), { recursive: true });
		const parserUrl = pathToFileURL(join(directory, "extensions/auto-mode/bash.ts")).href;
		const script = `
			import { analyzeBash } from ${JSON.stringify(parserUrl)};
			const analysis = analyzeBash("bash -c 'echo safe && git config --global http.sslVerify false'");
			console.log(JSON.stringify({
				commands: analysis.commands.map((command) => command.text),
				errors: analysis.errors,
			}));
		`;
		const result = spawnSync(process.execPath, [
			"--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
		], { cwd: directory, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.deepEqual(JSON.parse(result.stdout), {
			commands: [
				"bash -c 'echo safe && git config --global http.sslVerify false'",
				"echo safe",
				"git config --global http.sslVerify false",
			],
			errors: [],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Bash analysis finds commands across shell control structures", () => {
	const analysis = analyzeBash(`
		echo start && git push origin main
		printf done | tee output &
		if test -n "$HOME"; then rm -rf /tmp/build; fi
	`);

	assert.deepEqual(
		analysis.commands.map((command) => command.text),
		[
			"echo start",
			"git push origin main",
			"printf done",
			"tee output",
			'test -n "$HOME"',
			"rm -rf /tmp/build",
		],
	);
	assert.deepEqual(analysis.errors, []);
});

test("Bash analysis traverses nested command and process substitutions", () => {
	const analysis = analyzeBash(
		'echo "$(git push origin main)" < <(printf data) && echo `cat file`',
	);
	const commands = analysis.commands.map((command) => command.text).sort();

	assert.deepEqual(commands, [
		"cat file",
		'echo "$(git push origin main)"',
		"echo `cat file`",
		"git push origin main",
		"printf data",
	]);
});

test("Bash analysis parses literal shell wrapper scripts", () => {
	const analysis = analyzeBash(
		`bash -c 'echo safe && git config --global http.sslVerify false'`,
	);

	assert.deepEqual(
		analysis.commands.map((command) => command.text),
		[
			`bash -c 'echo safe && git config --global http.sslVerify false'`,
			"echo safe",
			"git config --global http.sslVerify false",
		],
	);
});

test("Bash analysis exposes the effective command behind transparent dispatch", () => {
	const analysis = analyzeBash("env -- MODE=test command -p /bin/rm -rf -- /root");
	assert.equal(analysis.errors.length, 0);
	assert.deepEqual(analysis.commands[0]?.effectiveCommand, {
		name: "rm",
		args: ["-rf", "--", "/root"],
		argTexts: ["-rf", "--", "/root"],
		argTildeExpansions: [false, false, false],
		unresolvedTransparentDispatch: false,
	});
});

test("Bash analysis does not trust unsupported env dispatch options", () => {
	const analysis = analyzeBash(`env --split-string='rm -rf /' echo safe`);
	assert.equal(analysis.errors.length, 0);
	assert.deepEqual(analysis.commands[0]?.effectiveCommand, {
		name: undefined,
		args: [],
		argTexts: [],
		argTildeExpansions: [],
		unresolvedTransparentDispatch: true,
	});
});

test("Bash analysis rejects unresolved pathname-expanded executables", () => {
	for (const executable of ["/bin/ba[s]h", "/bin/ba?h", "/bin/ba*h"]) {
		for (const prefix of ["", "command -- ", "env -- MODE=test ", "exec -a shell ", "env command exec -- ", "builtin ", "builtin command -- "]) {
			const source = `${prefix}${executable} -c 'git config --global http.sslVerify false'`;
			const analysis = analyzeBash(source);
			assert.match(analysis.errors[0]?.message ?? "", /executable.*pathname expansion/i, source);
			assert.equal(analysis.commands[0]?.effectiveCommand.name, undefined, source);
			assert.equal(analysis.commands[0]?.effectiveCommand.unresolvedTransparentDispatch, true, source);
			if (prefix === "") assert.equal(analysis.commands[0]?.dynamicName, true, source);
		}
	}
});

test("Bash analysis preserves literal executable glob characters and argument globs", () => {
	for (const executable of ["'/bin/ba[s]h'", '"/bin/ba[s]h"', "/bin/ba\\[s\\]h", "$'/bin/ba[s]h'"]) {
		for (const prefix of ["", "command -- ", "env -- MODE=test ", "exec -- ", "builtin command -- "]) {
			const source = `${prefix}${executable} -c 'echo safe'`;
			const analysis = analyzeBash(source);
			assert.deepEqual(analysis.errors, [], source);
			assert.equal(analysis.commands[0]?.effectiveCommand.name, "ba[s]h", source);
			assert.equal(analysis.commands[0]?.effectiveCommand.unresolvedTransparentDispatch, false, source);
			assert.equal(analysis.commands[0]?.dynamicName, false, source);
		}
	}
	const analysis = analyzeBash("printf '%s\\n' *.ts");
	assert.deepEqual(analysis.errors, []);
	assert.equal(analysis.commands[0]?.effectiveCommand.name, "printf");
});

test("Bash analysis rejects decoded NUL in executable names and all word positions", () => {
	for (const source of [
		"$'bash\\0ignored' -c 'git config --global http.sslVerify false'",
		"command $'bash\\x00ignored' -c 'echo safe'",
		"env MODE=test $'bash\\u0000ignored' -c 'echo safe'",
		"exec $'bash\\U00000000ignored' -c 'echo safe'",
		"builtin command $'bash\\0ignored' -c 'echo safe'",
		"printf '%s' $'safe\\0ignored'",
		"printf safe > $'output\\0ignored'",
		"VALUE=$'safe\\0ignored' printf safe",
		"printf '%s' ${VALUE:-$'safe\\0ignored'}",
		"printf '%s' \"$(printf '%s' $'safe\\0ignored')\"",
		"bash -c \"printf '%s' \\$'safe\\\\0ignored'\"",
	]) {
		assert.match(analyzeBash(source).errors[0]?.message ?? "", /NUL/i, source);
	}

	const safe = analyzeBash("$'ba\\x73h' -c 'echo safe' && printf '%s' $'\\\\0'");
	assert.deepEqual(safe.errors, []);
	assert.deepEqual(safe.commands.map((command) => command.name), ["bash", "echo", "printf"]);
	assert.deepEqual(safe.commands.at(-1)?.args, ["%s", "\\0"]);
});

test("Bash analysis resolves builtin dispatch but not unsupported builtin options", () => {
	for (const source of ["builtin cd /", "builtin command cd /", "builtin -- cd /"]) {
		const analysis = analyzeBash(source);
		assert.deepEqual(analysis.errors, [], source);
		assert.deepEqual(analysis.commands[0]?.effectiveCommand, {
			name: "cd",
			args: ["/"],
			argTexts: ["/"],
			argTildeExpansions: [false],
			unresolvedTransparentDispatch: false,
		}, source);
	}
	for (const option of ["-p", "--help", "--version", "--unknown"]) {
		const analysis = analyzeBash(`builtin ${option} cd /`);
		assert.deepEqual(analysis.commands[0]?.effectiveCommand, {
			name: undefined,
			args: [],
			argTexts: [],
			argTildeExpansions: [],
			unresolvedTransparentDispatch: true,
		}, option);
	}
});

test("Bash analysis keeps wrapper-local source ranges for nested commands", () => {
	const analysis = analyzeBash(
		`bash -c 'echo "$(tee .pi/automode.local.json)"'`,
	);
	const nested = analysis.commands.find((command) => command.name === "tee");

	assert.equal(nested?.raw, "tee .pi/automode.local.json");
});

test("Bash analysis normalizes token whitespace without changing quoted text", () => {
	const analysis = analyzeBash(`git\t push   "a  b"`);

	assert.equal(analysis.commands[0]?.text, 'git push "a  b"');
	assert.deepEqual(analysis.commands[0]?.words, ["git", "push", "a  b"]);
});

test("Bash analysis keeps redirects separate from command words", () => {
	const analysis = analyzeBash('MODE=test printf value >> "$HOME/.zshrc"');

	assert.deepEqual(analysis.commands[0]?.words, [
		"MODE=test",
		"printf",
		"value",
	]);
	assert.deepEqual(analysis.commands[0]?.redirectTargets, [
		"$HOME/.zshrc",
	]);
});

test("Bash analysis reports malformed input and keeps its partial tree", () => {
	const analysis = analyzeBash('echo safe && git push "unterminated');

	assert.equal(analysis.commands.some((command) => command.name === "git"), true);
	assert.match(analysis.errors[0]?.message ?? "", /unterminated double quote/);
});

test("Bash analysis collects errors from literal nested scripts", () => {
	const analysis = analyzeBash(`bash -c 'echo "unterminated'`);

	assert.match(analysis.errors[0]?.message ?? "", /unterminated double quote/);
});

test("Bash analysis converts parser exceptions into fail-closed errors", () => {
	const analysis = analyzeBash("echo safe", () => {
		throw new Error("synthetic parser failure");
	});

	assert.deepEqual(analysis.commands, []);
	assert.match(analysis.errors[0]?.message ?? "", /synthetic parser failure/);
});

test("Bash analysis rejects oversized input before parsing", () => {
	let parserCalls = 0;
	const analysis = analyzeBash("x".repeat(MAX_BASH_SOURCE_LENGTH + 1), () => {
		parserCalls += 1;
		throw new Error("parser must not run");
	});

	assert.equal(parserCalls, 0);
	assert.match(analysis.errors[0]?.message ?? "", /exceeds/);
});

test("Bash analysis does not treat quoted operators as command boundaries", () => {
	const analysis = analyzeBash(
		`echo "; && || | &" && printf '%s' 'still | one command'`,
	);

	assert.deepEqual(
		analysis.commands.map((command) => command.text),
		[
			'echo "; && || | &"',
			"printf '%s' 'still | one command'",
		],
	);
});

test("Bash analysis covers loops, groups, subshells, and stderr pipelines", () => {
	const analysis = analyzeBash(
		`for item in a; do echo "$item"; done; { git status; }; (printf ok) |& tee out`,
	);

	assert.deepEqual(
		analysis.commands.map((command) => command.text),
		['echo "$item"', "git status", "printf ok", "tee out"],
	);
});

test("Bash analysis marks unrepresented control-node values unsafe for allow", () => {
	for (const source of [
		'for x in a; do echo "$x"; done',
		'select x in a; do echo "$x"; done',
		'for ((i=0; i<3; i++)); do echo "$i"; done',
		'f() { echo ok; }',
		'case "$x" in a) echo ok;; esac',
		'coproc worker { echo ok; }',
		'[[ "$x" == a ]]',
		'((x += 1))',
	]) {
		const analysis = analyzeBash(source);
		assert.deepEqual(analysis.errors, [], source);
		assert.equal(analysis.allowStructureSafe, false, source);
	}

	assert.equal(analyzeBash("echo safe | cat").allowStructureSafe, true);
});
