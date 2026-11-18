import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_READ_ONLY_BASH_COMMANDS,
	MAX_READ_ONLY_BASH_LENGTH,
	analyzeReadOnlyBash,
	isSimpleJqFilter,
	isSimpleSedScript,
	resolvePhysicalPath,
} from "../extensions/auto-mode.ts";

type Fixture = {
	base: string;
	project: string;
	secrets: string;
	denied: string[];
	cleanup: () => void;
};

function createFixture(): Fixture {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-rob-")));
	const project = join(base, "project");
	const secrets = join(base, "secrets");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(secrets, { recursive: true });
	writeFileSync(join(project, "a.txt"), "alpha\n");
	writeFileSync(join(project, "-x"), "dash\n");
	writeFileSync(join(project, "src", "main.ts"), "export {};\n");
	writeFileSync(join(project, ".pi", "automode.json"), "{}\n");
	writeFileSync(join(secrets, "token.txt"), "s3cret\n");
	symlinkSync(secrets, join(project, "link-to-secrets"));
	symlinkSync(join(secrets, "token.txt"), join(project, "token-link"));
	return {
		base,
		project,
		secrets,
		denied: [`${secrets}/*`, secrets],
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

function analyze(fixture: Fixture, command: string, cwd = fixture.project) {
	return analyzeReadOnlyBash(command, { cwd, deniedPaths: fixture.denied });
}

function assertReadOnly(fixture: Fixture, command: string): void {
	const result = analyze(fixture, command);
	assert.equal(
		result.readOnly,
		true,
		`expected read-only: ${command}\n${result.readOnly ? "" : result.reason}`,
	);
}

function assertNotReadOnly(fixture: Fixture, command: string): void {
	const result = analyze(fixture, command);
	assert.equal(result.readOnly, false, `expected NOT read-only: ${command}`);
}

const ALLOWED = [
	"ls",
	"ls -la",
	"ls -la src",
	"ls src/",
	"ls -R src",
	"ls --color=auto src",
	"cat a.txt",
	"cat -n a.txt src/main.ts",
	"cat -- -x",
	"cat < a.txt",
	"cat a.txt | head -5",
	"cat a.txt | head -n 5 | wc -l",
	"head -n 20 a.txt",
	"tail -n +5 a.txt",
	"tail -20 a.txt",
	"wc -l a.txt",
	"file a.txt",
	"stat a.txt",
	"stat -c %s a.txt",
	"pwd",
	"echo hello",
	"echo -n hi",
	"printf '%s\\n' hello",
	"true",
	"grep foo a.txt",
	"grep -rn foo src",
	"grep -r foo",
	"grep -e foo -e bar a.txt",
	"grep -C3 foo a.txt",
	"grep -n --include='*.ts' foo src/main.ts",
	"egrep 'a|b' a.txt",
	"rg foo",
	"rg -n --glob '*.ts' foo src",
	"rg -e foo src",
	"rg --files",
	"sed -n 5p a.txt",
	"sed -n '1,10p' a.txt",
	"sed -n '/foo/p' a.txt",
	"sed -n '$p' a.txt",
	"sed -n '/a/,/b/p' a.txt",
	"sed -n -e 1p -e 3p a.txt",
	"sed 's/a/b/g' a.txt",
	"sed -E 's/(a)/\\1/' a.txt",
	"sed -n '2q' a.txt",
	"git status",
	"git status -sb",
	"git status --porcelain=v2",
	"git log --oneline -5",
	"git log --oneline --since=yesterday --author=me -n 10",
	"git log -p -- src/main.ts",
	"git diff",
	"git diff --stat HEAD~1",
	"git diff --cached --no-ext-diff",
	"git diff --no-textconv HEAD",
	"git show HEAD",
	"git show --stat HEAD",
	"git show HEAD:src/main.ts",
	"git rev-parse --show-toplevel",
	"git rev-parse --abbrev-ref HEAD",
	"git branch",
	"git branch -a",
	"git branch --list 'feat/*'",
	"git blame -L 1,5 src/main.ts",
	"git ls-files",
	"git ls-files --others --exclude-standard",
	"git ls-tree -r HEAD",
	"git describe --tags --always",
	"git remote -v",
	"git config --get remote.origin.url",
	"git tag",
	"git tag --list 'v*'",
	"git worktree list",
	"git --no-pager log -3",
	"jq . a.txt",
	"jq -r '.name' src/main.ts",
	"jq -n --arg a 1 '$a'",
	"find . -name '*.ts'",
	"find src -type f -name '*.ts' -print",
	"find . -maxdepth 2 -type d",
	"find . \\( -name a -o -name b \\) -print",
	"find . -newer a.txt",
	"find . -mtime -1 -size +10k",
	"which node",
	"type ls",
	"tree -L 2 src",
	"du -sh src",
	"df -h",
	"date",
	"date +%s",
	"uname -a",
	"id -u",
	"whoami",
	"sort a.txt",
	"sort -u -k2 a.txt",
	"uniq -c a.txt",
	"cut -d, -f1 a.txt",
	"tr a-z A-Z",
	"nl a.txt",
	"column -t a.txt",
	"basename src/main.ts",
	"dirname src/main.ts",
	"realpath src",
	"readlink -f src",
	"diff a.txt src/main.ts",
	"cmp a.txt src/main.ts",
	"md5sum a.txt",
	"sha256sum a.txt src/main.ts",
	"ls; cat a.txt",
	"ls && cat a.txt",
	"ls || echo none",
	"cat a.txt 2>/dev/null",
	"cat a.txt > /dev/null",
	"cat a.txt &>/dev/null",
	"ls 2>&1 | head",
	"grep foo a.txt 2>&1 || true",
	"ls |& head",
	"cat 'a.txt'",
	'cat "a.txt"',
	"cat a.txt >&2",
	"cat a.txt~",
	"git show HEAD~2:src/main.ts",
	"git log HEAD~3..HEAD",
	"'cat' a.txt",
	"\\cat a.txt",
	"cat \\\na.txt",
	"ls\ncat a.txt",
	"cat ./a.txt",
	"cat src/../a.txt",
	`cat ${"$HOME"}/.nonexistent-for-test`,
	`ls "$HOME"`,
	"cat ~/.nonexistent-for-test",
];

const REJECTED: Array<[string, string]> = [
	["cat a.txt > out.txt", "redirect to file"],
	["cat a.txt >> out.txt", "append redirect"],
	["cat a.txt >| out.txt", "clobber redirect"],
	["cat a.txt &> out.txt", "ampersand redirect"],
	["cat a.txt 2> err.txt", "stderr redirect"],
	["cat a.txt >& out.txt", "redirect word target"],
	["cat <> a.txt", "read-write redirect"],
	["echo hi | tee f", "tee"],
	["sed -n 'w /etc/x' a.txt", "sed w"],
	["sed -n 'W /etc/x' a.txt", "sed W"],
	["sed -i s/a/b/ a.txt", "sed -i"],
	["sed --in-place s/a/b/ a.txt", "sed --in-place"],
	["sed -n e a.txt", "sed e"],
	["sed -n '1e date' a.txt", "sed e with address"],
	["sed 's/a/b/e' a.txt", "sed s///e"],
	["sed 's/a/b/w out' a.txt", "sed s///w"],
	["sed -n 'r /etc/passwd' a.txt", "sed r"],
	["sed -n 'R /etc/passwd' a.txt", "sed R"],
	["sed -n '1!d' a.txt", "sed negation"],
	["sed -n '{p}' a.txt", "sed group"],
	["sed -f script.sed a.txt", "sed -f"],
	["sed -s -n p a.txt", "sed -s"],
	["sed -n 'p;w x' a.txt", "sed later w"],
	["sed 'y/a/b/' a.txt", "sed y"],
	["sed -n 'p' a.txt -i", "sed -i after operand"],
	["git -c core.pager=sh log", "git -c"],
	["git -c core.fsmonitor=cmd status", "git -c fsmonitor"],
	["git log --output=f", "git log --output"],
	["git diff --output=f", "git diff --output"],
	["git diff --ext-diff", "git diff --ext-diff"],
	["git show --textconv HEAD", "git show --textconv"],
	["git diff --no-index /etc/passwd /etc/hostname", "git diff --no-index"],
	["git --exec-path", "git --exec-path"],
	["git --exec-path=/tmp/x log", "git --exec-path=x"],
	["git --git-dir=/tmp/x log", "git --git-dir"],
	["git --work-tree=/tmp/x status", "git --work-tree"],
	["git --paginate log", "git --paginate"],
	["git log --format=%GS", "git %G exec gpg"],
	["git log --show-signature", "git show-signature"],
	["git log -O orderfile", "git -O"],
	["git branch newbranch", "git branch create"],
	["git branch -d old", "git branch delete"],
	["git branch -D old", "git branch force delete"],
	["git branch -m a b", "git branch rename"],
	["git tag v1", "git tag create"],
	["git tag -d v1", "git tag delete"],
	["git remote add x y", "git remote add"],
	["git remote show origin", "git remote show contacts network"],
	["git config user.name evil", "git config write"],
	["git config --unset user.name", "git config unset"],
	["git config --global --get user.name --file /tmp/x", "git config --file"],
	["git config --list", "git config --list"],
	["git commit -m x", "git commit"],
	["git push", "git push"],
	["git fetch", "git fetch"],
	["git checkout main", "git checkout"],
	["git clean -fdx", "git clean"],
	["git worktree add ../x", "git worktree add"],
	["git grep -O sh foo", "git grep"],
	["git blame --contents /etc/shadow a.txt", "git blame --contents"],
	["git", "bare git"],
	["git --no-pager", "git without subcommand"],
	["GIT_EXTERNAL_DIFF=x git diff", "GIT_ env prefix"],
	["GIT_PAGER=sh git log", "GIT_PAGER prefix"],
	["a=1 cat a.txt", "env prefix"],
	["a=1", "bare assignment"],
	["PATH=/tmp ls", "PATH prefix"],
	["find . -exec rm {} ;", "find -exec"],
	["find . -exec cat {} +", "find -exec +"],
	["find . -execdir cat {} ;", "find -execdir"],
	["find . -ok rm {} ;", "find -ok"],
	["find . -okdir rm {} ;", "find -okdir"],
	["find . -delete", "find -delete"],
	["find . -fprint x", "find -fprint"],
	["find . -fprint0 x", "find -fprint0"],
	["find . -fprintf x %p", "find -fprintf"],
	["find . -fls x", "find -fls"],
	["find -L . -name x", "find -L"],
	["find . -follow", "find -follow"],
	["find . -newerXY a.txt", "find invalid -newerXY"],
	["rg --pre cmd foo", "rg --pre"],
	["rg --pre=cmd foo", "rg --pre="],
	["rg --pre-glob '*.gz' foo", "rg --pre-glob"],
	["rg --hostname-bin cmd foo", "rg --hostname-bin"],
	["rg -z foo", "rg -z"],
	["rg --search-zip foo", "rg --search-zip"],
	["rg -L foo", "rg -L follow"],
	["rg --follow foo", "rg --follow"],
	["rg", "rg without pattern"],
	["grep -r x . > out", "grep redirect"],
	["grep -R foo .", "grep -R deref"],
	["grep -d recurse foo .", "grep -d"],
	["grep --exclude-from=../secrets/token.txt foo a.txt", "grep exclude-from denied"],
	["grep", "grep without pattern"],
	["jq -f prog.jq a.txt", "jq -f"],
	["jq -n 'env'", "jq env"],
	["jq -n '$ENV'", "jq $ENV"],
	["jq -n 'import \"a\" as a; .'", "jq import"],
	["jq --args . a b", "jq --args"],
	["jq -L /tmp .", "jq -L"],
	["sort -o out a.txt", "sort -o"],
	["sort --output=out a.txt", "sort --output"],
	["sort --compress-program=sh a.txt", "sort --compress-program"],
	["sort -T /tmp a.txt", "sort -T"],
	["uniq a.txt out", "uniq output file"],
	["date -s 'tomorrow'", "date -s"],
	["date 010100002030", "date set operand"],
	["tree -o out", "tree -o"],
	["du --files0-from=x", "du --files0-from"],
	["wc --files0-from=x", "wc --files0-from"],
	["md5sum -c sums", "md5sum -c"],
	["diff -l a.txt b.txt", "diff -l pipes through pr"],
	["diff a b c", "diff three operands"],
	["file -C", "file -C"],
	["file -m magic a.txt", "file -m"],
	["file -f list", "file -f"],
	["stat -c", "stat missing value"],
	["tail -f a.txt", "tail -f"],
	["tail --follow a.txt", "tail --follow"],
	["less a.txt", "less pager"],
	["more a.txt", "more pager"],
	["man ls", "man pager"],
	["env cat a.txt", "env wrapper"],
	["command cat a.txt", "command wrapper"],
	["builtin cat a.txt", "builtin wrapper"],
	["exec cat a.txt", "exec"],
	["time cat a.txt", "time keyword"],
	["timeout 5 cat a.txt", "timeout"],
	["nice cat a.txt", "nice"],
	["nohup cat a.txt", "nohup"],
	["xargs rm", "xargs"],
	["ls | xargs rm", "ls pipe xargs"],
	["awk '{print}' a.txt", "awk"],
	["bash -c 'cat a.txt'", "bash -c"],
	["sh -c 'cat a.txt'", "sh -c"],
	["python3 -c 'print(1)'", "python"],
	["node -e 1", "node"],
	["perl -e 1", "perl"],
	["eval cat a.txt", "eval"],
	["source a.txt", "source"],
	[". a.txt", "dot source"],
	["alias ls=rm", "alias"],
	["cd src", "relative cd"],
	["rm a.txt", "rm"],
	["touch x", "touch"],
	["curl https://example.com", "curl"],
	["ls; rm -rf x", "list with rm"],
	["ls && rm a.txt", "and with rm"],
	["cat a.txt || curl x", "or with curl"],
	["ls\nrm a.txt", "newline rm"],
	["! cat a.txt", "negation"],
	["cat a.txt &", "background"],
	["cat a.txt & cat b.txt", "background list"],
	["cat <<EOF\nhi\nEOF", "heredoc"],
	["cat <<-EOF\nhi\nEOF", "heredoc dash"],
	["cat <<< hello", "here-string"],
	["cat $(echo a.txt)", "command substitution"],
	["cat `echo a.txt`", "backticks"],
	['cat "$(echo a.txt)"', "quoted command substitution"],
	["cat <(echo a)", "process substitution"],
	["echo hi > >(tee f)", "output process substitution"],
	["cat $X", "variable"],
	["cat ${X}", "braced variable"],
	['cat "$X"', "quoted variable"],
	["cat ${HOME:-/x}", "parameter expansion"],
	["cat $HOMEX", "HOME prefix variable"],
	["cat $HOME$X", "HOME followed by variable"],
	["cat $((1+1))", "arithmetic expansion"],
	["cat $'a.txt'", "ansi-c quoting"],
	["cat *", "glob star"],
	["cat a.tx?", "glob question"],
	["cat [a].txt", "glob bracket"],
	["cat {a,b}.txt", "brace expansion"],
	["cat {1..3}", "brace sequence"],
	["cat ~root/x", "tilde user"],
	["cat ~+/a.txt", "tilde plus"],
	["cat ~-/a.txt", "tilde minus"],
	["cat a=~/x", "tilde after = in an assignment-shaped word"],
	["cat a_b+=~/x", "tilde after += in an assignment-shaped word"],
	["cat @(a|b)", "extglob"],
	["(cat a.txt)", "subshell"],
	["{ cat a.txt; }", "brace group"],
	["if true; then cat a.txt; fi", "if"],
	["for f in a; do cat $f; done", "for loop"],
	["while true; do cat a.txt; done", "while loop"],
	["f() { cat a.txt; }; f", "function"],
	["case a in a) cat a.txt;; esac", "case"],
	["[[ -f a.txt ]]", "test command"],
	["(( 1 + 1 ))", "arithmetic command"],
	["coproc cat", "coproc"],
	["cat a.txt;;", "parse error"],
	["cat 'a.txt", "unterminated quote"],
	["", "empty"],
	["   ", "whitespace"],
	["# comment only", "comment only"],
	["#!/bin/bash\ncat a.txt", "shebang"],
	["ca\\\nt a.txt", "line continuation inside a word"],
	["/bin/cat a.txt", "absolute binary"],
	["./cat a.txt", "relative binary"],
	["cat\u0000a.txt", "nul byte"],
	["echo $(", "unterminated substitution"],
	["cat ''", "empty path"],
	["cat ../secrets/token.txt", "parent traversal into denied"],
	[`cat ${"$HOME"}/../../etc/hostname/../../proc/self/environ`, "traversal to /proc"],
	["cat /proc/self/environ", "proc environ"],
	["cat /proc/1/cmdline", "proc cmdline"],
	["cat /dev/stdin", "dev stdin"],
	["cat /dev/tty", "dev tty"],
	["cat /sys/kernel/notes", "sys"],
	["cat .pi/automode.json", "safety control path"],
	["cat ./.pi/automode.json", "safety control path dotslash"],
	["cat src/../.pi/automode.json", "safety control via dotdot"],
	["cat link-to-secrets/token.txt", "symlinked dir into denied"],
	["cat token-link", "symlinked file into denied"],
	["cat link-to-secrets/../secrets/token.txt", "symlink with dotdot"],
	["ls link-to-secrets", "ls symlinked denied dir"],
	["cat < ../secrets/token.txt", "input redirect from denied"],
	["cat 2>/dev/null ../secrets/token.txt", "redirect then denied path"],
	["cat -n ../secrets/token.txt", "flag then denied path"],
	["head -n 1 ../secrets/token.txt", "head denied"],
	["grep -f ../secrets/token.txt a.txt", "grep -f denied"],
	["grep --file=../secrets/token.txt a.txt", "grep --file denied"],
	["grep -r x ..", "grep recursive reaching denied"],
	["ls -R ..", "ls -R reaching denied"],
	["rg x ..", "rg reaching denied"],
	["find .. -name x", "find reaching denied"],
	["du ..", "du reaching denied"],
	["tree ..", "tree reaching denied"],
	["diff a.txt ../secrets/token.txt", "diff denied operand"],
	["realpath --relative-to=../secrets a.txt", "realpath relative-to denied"],
	["stat token-link", "stat denied symlink"],
	["readlink -f token-link", "readlink denied symlink"],
	["git -C ../secrets status", "git -C denied"],
	["git -C / diff", "git -C root diff reaches denied scope"],
	["git diff ../secrets/token.txt", "git diff denied path"],
	["jq . ../secrets/token.txt", "jq denied file"],
	["jq --rawfile x ../secrets/token.txt .", "jq rawfile denied"],
	["jq --slurpfile x ../secrets/token.txt .", "jq slurpfile denied"],
	["sed -n 1p ../secrets/token.txt", "sed denied"],
	["date -r ../secrets/token.txt", "date -r denied"],
	["cd ../secrets && cat token.txt", "relative cd"],
	["cd \"$X\" && cat y", "cd dynamic"],
	["cd $X && cat y", "cd variable"],
	["cd -P /tmp && cat x", "cd option"],
	["cd /tmp || cat x", "cd with ||"],
	["cd /tmp && cat x || cat y", "cd with mixed operators"],
	["cd /tmp 2>&1 && cat x", "cd with redirect"],
	["cd /tmp /etc && cat x", "cd two args"],
];

test("analyzeReadOnlyBash allows plain read-only commands", () => {
	const fixture = createFixture();
	try {
		for (const command of ALLOWED) assertReadOnly(fixture, command);
	} finally {
		fixture.cleanup();
	}
});

test("analyzeReadOnlyBash rejects everything that is not provably read-only", () => {
	const fixture = createFixture();
	try {
		for (const [command, label] of REJECTED) {
			const result = analyze(fixture, command);
			assert.equal(
				result.readOnly,
				false,
				`expected NOT read-only (${label}): ${JSON.stringify(command)}`,
			);
		}
	} finally {
		fixture.cleanup();
	}
});

test("analyzeReadOnlyBash reports the commands and a reason", () => {
	const fixture = createFixture();
	try {
		const allowed = analyze(fixture, "cat a.txt | grep foo && ls");
		assert.deepEqual(allowed, { readOnly: true, commands: ["cat", "grep", "ls"] });
		const denied = analyze(fixture, "rm a.txt");
		assert.equal(denied.readOnly, false);
		assert.match(denied.readOnly ? "" : denied.reason, /command not allowed: rm/);
	} finally {
		fixture.cleanup();
	}
});

test("leading cd to an absolute path switches the checked working directory", () => {
	const fixture = createFixture();
	try {
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && cat main.ts`).readOnly, true);
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && ls | head && cat main.ts`).readOnly, true);
		assert.equal(analyze(fixture, `cd "${fixture.project}" && cat a.txt`).readOnly, true);
		// Relative paths now resolve against the new directory, and denied paths still apply.
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && cat ../a.txt`).readOnly, true);
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && cat ../../secrets/token.txt`).readOnly, false);
		assert.equal(analyze(fixture, `cd ${fixture.secrets} && cat token.txt`).readOnly, false);
		assert.equal(analyze(fixture, `cd ${fixture.secrets} && ls`).readOnly, false);
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && cat main.ts > out`).readOnly, false);
		// cd into a symlinked denied directory.
		assert.equal(analyze(fixture, `cd ${fixture.project}/link-to-secrets && cat token.txt`).readOnly, false);
		// Unsafe cd forms.
		assert.equal(analyze(fixture, `cd ${fixture.project}/src || cat main.ts`).readOnly, false);
		assert.equal(analyze(fixture, `ls && cd ${fixture.project}/src && cat main.ts`).readOnly, false);
		assert.equal(analyze(fixture, `cd ${fixture.project}/src && cd .. && cat a.txt`).readOnly, false);
		assert.equal(analyze(fixture, `cd src && cat main.ts`).readOnly, false);
		assert.equal(analyze(fixture, `cd ~ && cat a.txt`).readOnly, true, "~ resolves to an absolute home directory");
		const homePolicy = { cwd: fixture.project, deniedPaths: [`${os.homedir()}/*`] };
		assert.equal(analyzeReadOnlyBash(`cd ~ && cat a.txt`, homePolicy).readOnly, false);
	} finally {
		fixture.cleanup();
	}
});

test("relative paths resolve against the supplied cwd and symlinks are followed physically", () => {
	const fixture = createFixture();
	try {
		const inSrc = analyze(fixture, "cat main.ts", join(fixture.project, "src"));
		assert.equal(inSrc.readOnly, true);
		const fromSecrets = analyzeReadOnlyBash("cat token.txt", {
			cwd: fixture.secrets,
			deniedPaths: fixture.denied,
		});
		assert.equal(fromSecrets.readOnly, false);
		// A symlinked cwd resolves to its target before the policy runs.
		const linkedCwd = analyzeReadOnlyBash("cat token.txt", {
			cwd: join(fixture.project, "link-to-secrets"),
			deniedPaths: fixture.denied,
		});
		assert.equal(linkedCwd.readOnly, false);
		const missingCwd = analyzeReadOnlyBash("ls", {
			cwd: "/nonexistent-pi-automode-cwd/\0",
			deniedPaths: [],
		});
		assert.equal(missingCwd.readOnly, false);
	} finally {
		fixture.cleanup();
	}
});

test("resolvePhysicalPath follows a symlink before applying dot-dot", () => {
	const fixture = createFixture();
	try {
		// Lexically `link-to-secrets/..` is the project; physically it is the secrets parent.
		assert.equal(
			resolvePhysicalPath(fixture.project, "link-to-secrets/.."),
			fixture.base,
		);
		assert.equal(resolvePhysicalPath(fixture.project, "src/../a.txt"), join(fixture.project, "a.txt"));
		assert.equal(resolvePhysicalPath(fixture.project, "missing/child"), join(fixture.project, "missing", "child"));
		assert.equal(resolvePhysicalPath(fixture.project, "/"), "/");
	} finally {
		fixture.cleanup();
	}
});

test("deniedPaths wildcard patterns apply to every path-like argument", () => {
	const fixture = createFixture();
	try {
		const policy = { cwd: fixture.project, deniedPaths: ["**/*.env", "**/id_rsa"] };
		assert.equal(analyzeReadOnlyBash("cat a.txt", policy).readOnly, true);
		assert.equal(analyzeReadOnlyBash("cat prod.env", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("cat src/../prod.env", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("cat ~/.ssh/id_rsa", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("cat $HOME/.ssh/id_rsa", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash('cat "$HOME/.ssh/id_rsa"', policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("cat ${HOME}/.ssh/id_rsa", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("cat /home/x/.SSH/ID_RSA", policy).readOnly, false, "case folded");
		// A recursive search whose scope can contain a wildcard-denied file is not read-only.
		assert.equal(analyzeReadOnlyBash("grep -r foo src", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("rg foo", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("find . -name x", policy).readOnly, false);
		assert.equal(analyzeReadOnlyBash("git diff", policy).readOnly, false);
		// Non-recursive uses of the same tools stay allowed.
		assert.equal(analyzeReadOnlyBash("grep foo a.txt", policy).readOnly, true);
	} finally {
		fixture.cleanup();
	}
});

test("deniedPaths with the user's home prefix reject $HOME and ~ spellings", () => {
	const fixture = createFixture();
	try {
		const policy = { cwd: fixture.project, deniedPaths: ["~/.ssh/*", "$HOME/.aws/*"] };
		for (const command of [
			"cat ~/.ssh/id_rsa",
			"cat $HOME/.ssh/id_rsa",
			"cat ${HOME}/.ssh/id_rsa",
			'cat "$HOME/.ssh/id_rsa"',
			"cat ~/.aws/credentials",
			`cat ${os.homedir()}/.ssh/id_rsa`,
			"cat ~/./.ssh/id_rsa",
			"cat ~/x/../.ssh/id_rsa",
			"head -c 10 < ~/.ssh/id_rsa",
		]) {
			assert.equal(analyzeReadOnlyBash(command, policy).readOnly, false, command);
		}
	} finally {
		fixture.cleanup();
	}
});

test("HOME that disagrees with the resolved home disables $HOME and ~ words", () => {
	const fixture = createFixture();
	const original = process.env.HOME;
	try {
		process.env.HOME = "/somewhere/else";
		assert.equal(analyze(fixture, "cat ~/x").readOnly, false);
		assert.equal(analyze(fixture, "cat $HOME/x").readOnly, false);
		assert.equal(analyze(fixture, "cat a.txt").readOnly, true);
	} finally {
		if (original === undefined) delete process.env.HOME;
		else process.env.HOME = original;
		fixture.cleanup();
	}
});

test("quoted globs and escapes are literal paths, not expansions", () => {
	const fixture = createFixture();
	try {
		assertReadOnly(fixture, "cat 'a*.txt'");
		assertReadOnly(fixture, 'cat "a*.txt"');
		assertReadOnly(fixture, "cat a\\*.txt");
		assertReadOnly(fixture, "grep '$foo' a.txt");
		assertReadOnly(fixture, "grep \"\\$foo\" a.txt");
		assertReadOnly(fixture, "grep '(a|b)' a.txt");
		assertNotReadOnly(fixture, "cat a*.txt");
		assertNotReadOnly(fixture, 'cat "a"*.txt');
		assertNotReadOnly(fixture, "cat \"a $X\"");
		assertNotReadOnly(fixture, 'cat "`x`"');
	} finally {
		fixture.cleanup();
	}
});

test("oversized and pathological inputs fail closed without throwing", () => {
	const fixture = createFixture();
	try {
		assert.equal(analyze(fixture, `cat ${"a".repeat(MAX_READ_ONLY_BASH_LENGTH)}`).readOnly, false);
		const many = Array.from({ length: MAX_READ_ONLY_BASH_COMMANDS + 1 }, () => "ls").join(" ; ");
		assert.equal(analyze(fixture, many).readOnly, false);
		const justEnough = Array.from({ length: MAX_READ_ONLY_BASH_COMMANDS }, () => "ls").join(" ; ");
		assert.equal(analyze(fixture, justEnough).readOnly, true);
		assert.equal(analyze(fixture, "(".repeat(5000)).readOnly, false);
		assert.equal(analyze(fixture, "cat " + "'".repeat(999)).readOnly, false);
		assert.equal(analyze(fixture, "\u0000").readOnly, false);
		assert.equal(analyze(fixture, "cat a.txt " + "|".repeat(200)).readOnly, false);
		assert.equal(analyze(fixture, `sed -n '${"1p;".repeat(2000)}' a.txt`).readOnly, false);
	} finally {
		fixture.cleanup();
	}
});

test("isSimpleSedScript accepts only print, delete, quit, line number, and plain substitution", () => {
	for (const script of [
		"p", "5p", "1,10p", "$p", "/foo/p", "/a/,/b/p", "1,+3p", "2q", "d", "=",
		"s/a/b/", "s/a/b/gp", "s/a\\/b/c/", "1p;3p", "1p\n3p", " 1p ; 2p ", "/a\\/b/p",
		"s/a/b/;p", "5,$d", "q5",
	]) {
		assert.equal(isSimpleSedScript(script), true, script);
	}
	for (const script of [
		"", ";", "w x", "1w x", "W x", "r x", "R x", "e", "e date", "1e", "s/a/b/e", "s/a/b/w f",
		"s/a/b/ew", "!p", "1!p", "p!", "{p}", "p;{p}", ":a", "b", "t", "T", "n", "N", "y/a/b/",
		"s|a|b|", "s/a/b", "s/a", "/a", "/a/", "5", "1,", "1,p", "p x", "s/a/b/ w", "a\\ text",
		"i\\ text", "c\\ text", "l", "F", "z", "v", "x", "p\nw x", "s/a/b/\\w", "q;w x",
		"s/a/b/" + "g".repeat(0) + "x", "s/a/b/m;e", "1~2p", "0~3p", "\\,a,p", "s/\n/b/",
	]) {
		assert.equal(isSimpleSedScript(script), false, JSON.stringify(script));
	}
});

test("isSimpleJqFilter rejects environment and module access", () => {
	for (const filter of [".", ".a.b", "map(.x)", ".[] | select(.n == 1)", "@sh", "input_filename"]) {
		assert.equal(isSimpleJqFilter(filter), true, filter);
	}
	for (const filter of ["env", "env.HOME", "$ENV", "$ENV.PATH", "import \"a\" as a; .", "include \"a\"; .", "modulemeta", "get_search_list", "$__prog_args"]) {
		assert.equal(isSimpleJqFilter(filter), false, filter);
	}
	assert.equal(isSimpleJqFilter(`.${"a".repeat(5000)}`), false);
});

test("git read-only subcommands honour option allowlists and -C path policy", () => {
	const fixture = createFixture();
	try {
		assertReadOnly(fixture, `git -C ${fixture.project}/src status`);
		assertReadOnly(fixture, "git -C src status");
		assertNotReadOnly(fixture, `git -C ${fixture.secrets} status`);
		assertNotReadOnly(fixture, "git -C link-to-secrets status");
		assertNotReadOnly(fixture, "git -C");
		assertNotReadOnly(fixture, "git -Csrc status");
		assertNotReadOnly(fixture, "git -P -c x=y status");
		assertReadOnly(fixture, "git branch --list");
		assertNotReadOnly(fixture, "git branch --list --delete x");
		assertNotReadOnly(fixture, "git branch --set-upstream-to=x");
		assertNotReadOnly(fixture, "git log --exec=sh");
		assertNotReadOnly(fixture, "git log --upload-pack=sh");
		assertNotReadOnly(fixture, "git diff --output-indicator-new=x --output=f");
		assertNotReadOnly(fixture, "git log --oneline -S foo");
		assertNotReadOnly(fixture, "git log -S");
		assertReadOnly(fixture, "git log -Sfoo");
		assertReadOnly(fixture, "git log -U3 -p");
		assertNotReadOnly(fixture, "git config --get-regexp 'remote.*'");
		assertReadOnly(fixture, "git config user.name");
		assertNotReadOnly(fixture, "git config user.name x");
		assertNotReadOnly(fixture, "git config --get");
	} finally {
		fixture.cleanup();
	}
});

test("grep and rg treat the first operand as a file when -f or --file supplies the patterns", () => {
	const fixture = createFixture();
	try {
		for (const command of [
			"grep -vf /dev/null token-link",
			"grep -f a.txt token-link",
			"grep --file=a.txt token-link",
			"egrep -f a.txt token-link",
			"rg -f a.txt token-link",
			"rg --file a.txt token-link",
		]) {
			assertNotReadOnly(fixture, command);
		}
		assertReadOnly(fixture, "grep -f a.txt src/main.ts");
		assertReadOnly(fixture, "rg -f a.txt src");
		assertReadOnly(fixture, "grep -e x -f a.txt src/main.ts");
	} finally {
		fixture.cleanup();
	}
});

test("options that take a value cannot hide a path operand", () => {
	const fixture = createFixture();
	try {
		assertNotReadOnly(fixture, "column -n -s token-link");
		assertNotReadOnly(fixture, "column -n a.txt");
		assertReadOnly(fixture, "column -t a.txt");
		assertReadOnly(fixture, "column -t -s , a.txt");
		assertReadOnly(fixture, "rg --color always foo");
		assertReadOnly(fixture, "date -I");
		assertReadOnly(fixture, "date -Iseconds");
	} finally {
		fixture.cleanup();
	}
});

test("recursive scans cannot start at a root that contains /proc, /sys, or /dev", () => {
	const fixture = createFixture();
	try {
		for (const command of ["grep -rIa KEY /", "rg KEY /", "find / -name x", "ls -R /", "du /", "tree /", "grep -r x //"]) {
			assertNotReadOnly(fixture, command);
		}
		// With no deniedPaths configured nothing else stops the walk.
		for (const command of ["grep -rIa KEY /", "rg KEY /", "find / -name x", "ls -R /", "du /", "tree /"]) {
			assert.equal(
				analyzeReadOnlyBash(command, { cwd: fixture.project, deniedPaths: [] }).readOnly,
				false,
				command,
			);
		}
		assertNotReadOnly(fixture, "cat /proc/self/environ");
		assertNotReadOnly(fixture, "cat /dev/zero");
		assertReadOnly(fixture, "cat /dev/null");
	} finally {
		fixture.cleanup();
	}
});

test("git subcommands cannot run gpg, print diffs through status, or dump credentials", () => {
	const fixture = createFixture();
	try {
		for (const command of [
			"git status -v",
			"git status --verbose",
			"git for-each-ref --format='%(signature:grade)'",
			"git branch --list --format='%(signature)'",
			"git tag --list --format='%(signature)'",
			"git tag --verify v1",
			"git log --format='%G?'",
			"git config --get-regexp .",
			"git config --get-all remote.origin.url",
			"git config --list",
			"git config --get http.extraheader",
			"git config credential.helper",
			"git config --get remote.origin.token",
			"git config --global user.signingkey",
		]) {
			assertNotReadOnly(fixture, command);
		}
		assertReadOnly(fixture, "git status -sb");
		assertReadOnly(fixture, "git for-each-ref --format='%(refname)'");
		assertReadOnly(fixture, "git config --get remote.origin.url");
	} finally {
		fixture.cleanup();
	}
});

test("recursive listing cannot follow symlinks out of the checked scope", () => {
	const fixture = createFixture();
	try {
		for (const command of ["ls -RL .", "ls -R --dereference .", "tree -l .", "diff -r src src"]) {
			assertNotReadOnly(fixture, command);
		}
		assertReadOnly(fixture, "ls -L src");
		assertReadOnly(fixture, "ls -R src");
		assertReadOnly(fixture, "diff -r --no-dereference src src");
	} finally {
		fixture.cleanup();
	}
});

test("URL-shaped arguments are never read as local paths", () => {
	const fixture = createFixture();
	try {
		for (const word of [
			"local://x",
			"skill://git",
			"artifact://1",
			"ssh://host/etc/passwd",
			"file:///etc/passwd",
			"https://example.com",
			"--file=ssh://host/x",
		]) {
			assertNotReadOnly(fixture, `cat ${word}`);
		}
		assertNotReadOnly(fixture, "grep x skill://github");
		assertNotReadOnly(fixture, "ls local://");
	} finally {
		fixture.cleanup();
	}
});

test("jq accepts field names that look like builtins but not the builtins themselves", () => {
	assert.equal(isSimpleJqFilter(".env"), true);
	assert.equal(isSimpleJqFilter(".a.include | .b.import"), true);
	for (const filter of ["env", "$ENV", "$ENV.PATH", ".|env", "{a: env}", "import \"x\" as x; .", "include \"x\"; .", "modulemeta", "$__prog_args"]) {
		assert.equal(isSimpleJqFilter(filter), false, filter);
	}
});

test("a leading cd checks later statements in both the old and the new directory", () => {
	const fixture = createFixture();
	try {
		const src = `${fixture.project}/src`;
		assertReadOnly(fixture, `cd ${src}`);
		assertReadOnly(fixture, `cd ${src}; cat main.ts`);
		assertReadOnly(fixture, `cd ${src} && ls; cat ../a.txt | head`);
		assertReadOnly(fixture, `cd ${src} && ls && wc -l main.ts; echo done`);
		// The cd may fail, so the later statement also runs in the original directory.
		assertNotReadOnly(fixture, `cd ${src}; cat token-link`);
		// The cd may succeed, so the later statement also runs in the new directory.
		assertNotReadOnly(fixture, `cd ${src} && ls; cat ../../secrets/token.txt`);
		assertNotReadOnly(fixture, `cd ${fixture.secrets}; ls`);
		// Anything but a single leading cd stays rejected.
		assertNotReadOnly(fixture, `cd ${src}; cd ..; cat a.txt`);
		assertNotReadOnly(fixture, `ls; cd ${src}; cat main.ts`);
		assertNotReadOnly(fixture, `cd ${src} & cat main.ts`);
		assertNotReadOnly(fixture, `cd ${src} || cat main.ts`);
		assertNotReadOnly(fixture, `cd ${src}; cat main.ts; rm a.txt`);
		assertNotReadOnly(fixture, `cd ${src} && ls; cd ${src}`);
	} finally {
		fixture.cleanup();
	}
});

test("quoting tricks cannot change which binary is checked", () => {
	const fixture = createFixture();
	try {
		assertReadOnly(fixture, "'c'at a.txt");
		assertReadOnly(fixture, '"ca"t a.txt');
		assertReadOnly(fixture, "c\\at a.txt");
		assertNotReadOnly(fixture, "'r'm a.txt");
		assertNotReadOnly(fixture, "\\rm a.txt");
		assertNotReadOnly(fixture, "r\"\"m a.txt");
		assertNotReadOnly(fixture, "'cat a.txt'");
		assertNotReadOnly(fixture, "constructor a.txt");
		assertNotReadOnly(fixture, "__proto__ a.txt");
		assertNotReadOnly(fixture, "toString a.txt");
		assertNotReadOnly(fixture, "git constructor");
		assertNotReadOnly(fixture, "git __proto__");
	} finally {
		fixture.cleanup();
	}
});

test("git is not read-only when repository config can make it run programs", () => {
	const fixture = createFixture();
	try {
		const gitDir = join(fixture.project, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "config"), "[core]\n\tbare = false\n");
		assertReadOnly(fixture, "git status");

		for (const config of [
			"[core]\n\tfsmonitor = /tmp/hook.sh\n",
			"[diff \"x\"]\n\ttextconv = /tmp/conv.sh\n",
			"[filter \"lfs\"]\n\tclean = /tmp/clean.sh\n",
			"[include]\n\tpath = /tmp/other.config\n",
		]) {
			writeFileSync(join(gitDir, "config"), config);
			for (const command of ["git status", "git diff", "git log -p", "git -C src status"]) {
				const result = analyze(fixture, command);
				assert.equal(result.readOnly, false, `${command} with ${config}`);
			}
		}

		// A linked worktree reads the shared config through `.git` and `commondir`.
		writeFileSync(join(gitDir, "config"), "[core]\n\tfsmonitor = /tmp/hook.sh\n");
		const worktree = join(fixture.base, "worktree");
		const worktreeGitDir = join(gitDir, "worktrees", "wt");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree);
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
		assert.equal(analyze(fixture, "git status", worktree).readOnly, false);
	} finally {
		fixture.cleanup();
	}
});
