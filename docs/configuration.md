# Configuration

The extension follows the documented Claude Code configuration model where Pi supports it.

It reads `autoMode` only from Pi-owned configuration sources:

- the global config file
- the project-local config file for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`

Which files these are depends on the host:

| | Pi | OMP |
|---|---|---|
| Global config | `~/.pi/agent/extensions/pi-automode/config.json` | `<agentDir>/automode/config.json` |
| Project-local config | `.pi/automode.local.json` | `.omp/automode.local.json` |
| Shared project config | `.pi/automode.json` | `.omp/automode.json` |
| Logs for in-memory sessions | `~/.pi/agent/extensions/pi-automode/logs/` | `<agentDir>/automode/logs/` |

Pi-automode detects OMP through the `getAgentDir()` function that OMP exposes to extensions. `<agentDir>` is the directory OMP reports, normally `~/.omp/agent`. It follows OMP profiles and `PI_CONFIG_DIR`. Under any other host, pi-automode uses the Pi paths. See [ADR-003](adr/ADR-003-omp-config-directory.md).

At startup, pi-automode selects one active global config path for the session. Under Pi, it moves a legacy `~/.pi/agent/automode.json` file to the Pi path. Under OMP, it moves a Pi config (`~/.pi/agent/extensions/pi-automode/config.json`, or the older `~/.pi/agent/automode.json`) to `<agentDir>/automode/config.json`. This is a one-way move: Pi no longer finds the file afterwards. If both files exist, pi-automode uses the new file and reports the conflict. If migration fails, it uses the legacy file for that session and reports the error.

Under OMP, project files come from `.omp/`. If `.omp/` lacks a file but `.pi/` has it, pi-automode reads the `.pi/` file and `/automode config` reports the legacy location. If both exist, it reads the `.omp/` file and reports the ignored `.pi/` file. Pi-automode never moves project files. `/automode config` shows the selected files under `configSources`.

It does not read project configuration until the host trusts the project. For an untrusted project, it ignores the project config files in both `.omp/` and `.pi/`. `/automode config` reports each ignored file that exists.

Shared project `automode.json` (`.pi/automode.json` under Pi, `.omp/automode.json` under OMP) cannot weaken auto mode. For a trusted project, it can add `permissions.deny` and `permissions.ask` rules.

The shared file cannot set `autoMode` or add `permissions.allow` rules. If the file contains `permissions.allow`, `/automode config` reports a diagnostic.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json` (`.omp/automode.local.json` under OMP):

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This file is project-local. The host must trust the project before pi-automode reads it. Do not commit this file. Shared project `automode.json` cannot disable auto mode.

Set a global default classifier model in the global config file. For a trusted project, override it in the project-local config file.

### Classifier model selectors

`classifierModel` accepts three forms:

- `provider/model-id` selects one model from the Pi/OMP registry.
- `typesafe/jev-*` selects the native [TypeSafe Jev](#typesafe-jev) backend.
- `@role` (OMP only) selects an OMP model role such as `@smol` or `@judge`.

A role selector expands to the role's complete OMP chain: the model assigned to the role in OMP settings, then its configured or built-in fallbacks, which can sit on other providers. The classifier uses the first model in the chain that has working credentials. The `@judge` chain also holds native judgment and on-device models. They cannot run the classifier's decision tool, so the classifier skips them.

Under OMP, an unset `classifierModel` means `@smol`. If that role resolves to no available model, the current session model is used. Pi has no model roles, so an unset value still means the session model, and a role selector fails closed with a reason that names the missing OMP support.

If a role or model cannot be resolved, the action is blocked. An explicit selector never falls back to the session model. `/automode status`, `/automode config`, and `automode_inspect` show the selector and the concrete model it resolves to, for example `@smol → anthropic/claude-haiku-5-5 +16 fallbacks`.

### Provider failures and fallback

Each classifier failure gets a type: `rate-limit` (HTTP 429 or a rate or quota message), `timeout`, `server` (5xx, overload, dropped connections, and unrecognized provider errors), `auth` (401, 402, 403, rejected credentials), `invalid-response` (an invalid decision, a truncated or non-`0`/`1` answer, a request the provider rejects), `context-limit` (an action too large for the model), `no-classifier` (no usable model or credential), and `aborted` (the session cancelled the action). The decision log and `automode_inspect` record these as `errorKind` and `kind`.

- A `timeout` or `server` failure is retried once on the same model after a pause of 250 to 750 ms.
- Any other failure, or a failed retry, moves to the next model in the role chain. The walk prefers a provider that has not failed yet, tries at most four models, and starts no new attempt once three `classifierTimeoutMs` have passed.
- A `rate-limit` puts that provider on cooldown for the `retry-after` the provider gave (capped at 10 minutes, 60 seconds when it gave none). Until then, every model of that provider is skipped without a request, in every session of the process. `/automode reload` clears the cooldowns.
- Two consecutive timeouts of the same model (an attempt and its retry count as two) skip that model for 60 seconds, so one slow model does not cost a full timeout and its retry on every action. Other models of the provider are unaffected, and any decision from the model resets the count.
- When no model can decide, the action is blocked with kind `classifier-unavailable` and a reason such as `classifier unavailable (rate limited, retry in 53m)`. The model sees that this is not a policy denial. These blocks do not count as classifier denials in the status counters.

A single `provider/model-id` has no fallback, but it gets the same retry, cooldown, and typed block. Jev has no retry or fallback; its failures are typed and block as `classifier-unavailable`. The decision log's `classifier` entries record, for each attempt, the serving model, `errorKind`, and `retryAfterMs`.

### Classifier strategy and the OMP judge

`classifierStrategy` chooses how a classified action is reviewed:

- `staged` (default) asks for a one-token `0`/`1` gate and runs the detailed review only on `1`.
- `detailed` skips the gate and always runs the detailed review. In a log of 11.9k decisions the gate passed 14% of actions and 99% of the rest were then allowed, so it cost more time than it saved (about 1.6 hours over 23 days).
- `hybrid` (OMP only) first asks OMP's `judge` role chain four typed policy questions: a HARD_DENY match, a SOFT_DENY match, ALLOW-exception coverage, and direct user authorization. These are the questions Jev uses. Only a native judge such as TypeSafe Jev can approve, because it returns calibrated probabilities. Prompted chat models answer with probability 0 or 1, so `judgeConfidence` cannot gate them, and on-device models are too weak to approve anything. Both kinds are skipped. When the chain has no credentialed native judge, the judge stage is skipped with `judge-unavailable: no calibrated judge` in the attempt's error and the detailed classifier decides, as if no judge existed.

The judge approves an action only when `P(no HARD_DENY) >= judgeConfidence` and either `P(no SOFT_DENY) >= judgeConfidence` or the larger of `P(ALLOW exception)` and `P(direct authorization)` reaches it. `judgeConfidence` defaults to 0.9 and must be above 0.5 and at most 1. Every other outcome goes to the detailed classifier on `classifierModel`: a doubtful answer, an unavailable or failing judge, no calibrated judge in the chain, an invalid answer, or a timeout.

Deterministic hard denies, `permissions.deny`, and path denials run before any model. The judge never blocks and never has the last word on a doubtful action, so an inaccurate judge costs latency and cannot let a doubtful action through unreviewed. The remaining risk is a confident wrong approval, as with any model decision; raise `judgeConfidence` to require more certainty. An action that matched `permissions.ask` and an `eval` call always skip the judge. Jev as `classifierModel` is its own judge, so `hybrid` adds nothing for it, and under Pi `hybrid` behaves as `detailed`.

The judge's model, token usage and cost appear as a `judge` attempt in the decision log's `classifier` entry and as a usage record. A skipped or doubtful judge shows its reason in that attempt's `error` (`judge-unavailable: no calibrated judge` or `escalated: ...`). The chain comes from OMP's `judge` role, so configure it in OMP and put a native judge such as `typesafe/jev-*` in it; a chain of chat models only makes `hybrid` behave as `detailed` with an extra lookup.

For Pi/OMP chat models, `classifierReasoningLevel` requests `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both classifier stages. If the key is absent, pi-automode sends no reasoning preference. The server then selects the level.

Pi AI clamps an unsupported value to the nearest level that the selected model supports. A model without reasoning support resolves to `off`. `low` matches the reasoning effort of Codex Auto Review.

Higher levels can use all 512 or 1200 stage tokens before they produce visible output. In this case, the classifier fails closed. If truncation occurs before the required `0` or `1` digit, increase `fastClassifierMaxTokens`. The default is 512, and the minimum is 16.

`classifierTimeoutMs` limits each classifier request in milliseconds. The default is 20000, and the minimum is 1000. The fast and detailed stages have separate budgets.

If a request stalls or exceeds its budget, pi-automode aborts it. Then auto mode fails closed and blocks the action.

`allowInsideWorkingDirectory` adds a deterministic allow tier for the file tools. The default value is `false`. The file tools are `read`, `write`, `edit`, `grep`, `find`, and `ls`.

The value `allowInsideWorkingDirectory: true` allows access to paths inside the working directory without classifier review. Pi-automode sends access to outside paths to the classifier. This rule also applies to read calls.

This tier takes precedence over `classifyReadOnlyTools`. If both configuration fields are enabled, pi-automode still allows in-tree file access locally. `classifyReadOnlyTools: true` does not change this behavior.

Protected in-tree targets do not use this allow tier. Writes and edits to `.git/hooks`, `.pi` controls, shell profiles, and configuration files still reach the classifier.

`deniedPaths` is a list of path glob patterns. The default list is `[]`. A matching pattern blocks a file-tool call before classifier review or an allow tier.

Patterns support `~`, `$HOME`, and `${HOME}` expansion. The `*` wildcard matches all characters, including `/`. Thus, `**/id_rsa` matches a private key at any depth.

Each pattern can contain at most 4,096 UTF-16 code units. Pi-automode matches the typed path and its symlink-resolved form. It also resolves the fixed path prefix of each pattern. Thus, a symlink alias cannot bypass a denied target.

OMP's `read` and `grep` parse `path`. They peel line and `:raw` selectors (`~/.netrc:1-2`, `:-5`, `:2-4:raw`), address archive members and database tables (`app.db:users:7`), accept `?query` suffixes, and split `;`-, `,`- and whitespace-separated lists. Pi-automode checks the typed value, each list entry, and each prefix of an entry that ends before a `:` or `?`. A `deniedPaths` match on any of them blocks the call. The inside-working-directory tier and `permissions.allow` rules apply only when all of them pass. A file name that contains a colon still matches literally.

If a recursive `find` scope can contain a denied path, pi-automode blocks the call. OMP's built-in `grep` still runs. Pi-automode appends a `!glob` exclusion for each denied path that can lie under a search root, so OMP never searches those files, and it drops the result if the list of files OMP reports contains a denied file. An exclusion matches at any depth below the root, so a file elsewhere in the tree with the same name or ending is left out too, and the result is not annotated. Pi-automode blocks the `grep` call instead when it cannot guarantee the exclusions. That happens when a pattern covers a whole search root (`/repo/*` while searching `/repo`), when a pattern contains `{`, `}`, `;` or control characters, when the `path` has unbalanced braces or a backslash, when a root is a URL, and for any `grep` that is not OMP's built-in.

A `scheme://` path is not a filesystem path. Reads of built-in OMP schemes (`skill`, `local`, `artifact`, `omp`, `history`, `issue`, `pr`, `mr`, `agent`, `proc`, `mcp`, `xd`) are allowed locally. Reads of any other scheme, including `https://` pages and `ssh://` hosts, go to the classifier even when `classifyReadOnlyTools` is `false`. A `write` to `xd://<tool>` is allowed because OMP runs the named tool as a nested call that is judged on its own. A write to `local://` is session scratch and follows `allowInsideWorkingDirectory`. Writes to `proc://`, `agent://`, `ssh://`, and other schemes go to the classifier. A `deniedPaths` pattern is matched against the URL as typed, so `*.env` blocks `skill://notes/.env`.

A matching path blocks the call without classifier review or an override. The list applies only to file tools. The classifier governs `bash` path access. Both keys use the normal scalar and array precedence.

`allowInsideWorkingDirectory` uses scalar precedence: global, then project-local, then `PI_AUTOMODE_SETTINGS_JSON`. `deniedPaths` entries accumulate across these configuration sources.

Shared project `.pi/automode.json` cannot set either field. Omitting either field at a higher-precedence source does not clear a lower-source value.

`headlessAsk` sets what a `permissions.ask` match does in a session that has no UI, such as an OMP subagent or `/tan` clone. A session with its own UI always asks its own user. The default is `parent`. The setting uses scalar precedence like `allowInsideWorkingDirectory`, and shared project `.pi/automode.json` cannot set it.

- `parent` asks the nearest ancestor session in the same process that has a UI. The dialog title names the asking agent. A decline, an abort, no answer within 25 seconds, or an ancestor that cannot be found blocks the call. An accepted dialog works as it does in a session with its own UI: the call continues through the deterministic checks to the classifier.
- `classifier` does not ask. The call skips every allow tier and reaches the classifier, which receives a note that the rule matched in a session without UI. If the classifier allows the call, it runs without any user approval, so this is the weakest setting. Use it only when you accept the classifier as the sole reviewer of calls your ask rules mark as sensitive.
- `block` blocks the call.

The lookup for `parent` uses the session header of the asking session, which names its parent by session file or session id. It finds only sessions of the same process, and a parent that has shut down is gone. OMP lets an extension's `tool_call` handler work for 30 seconds (`extensionHandlers.toolCallTimeoutMs`) and does not pause that clock for a dialog in another session's UI. For that reason a forwarded dialog closes after 25 seconds and the asking call is blocked. Subagents that ask at the same time queue in the parent's UI, and each one's 25 seconds start when it asks, not when its dialog appears.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
    "classifierReasoningLevel": "low",
    "classifyReadOnlyTools": false,
    "fastClassifierMaxTokens": 512,
    "classifierTimeoutMs": 20000,
    "allowInsideWorkingDirectory": false,
    "headlessAsk": "parent",
    "deniedPaths": [],
    "allowReadOnlyBash": false,
    "readOnlyRoots": [],
    "maxUserTranscriptTokens": 4000,
    "maxToolTranscriptTokens": 4000,
    "environment": [
      "$defaults",
      "Source control: github.example.com/acme-corp and all repos under it",
      "Trusted internal domains: *.corp.example.com, git.example.com",
      "Trusted cloud buckets: s3://acme-dev-artifacts, gs://acme-ci-cache",
      "Key internal services: staging deploy API at deploy.corp.example.com"
    ],
    "allow": ["$defaults"],
    "protectedPaths": ["$defaults"],
    "soft_deny": ["$defaults"],
    "hard_deny": [
      "$defaults",
      "Never send repository contents to third-party code-review APIs"
    ]
  },
  "permissions": {
    "deny": ["bash(rm -rf *)"],
    "ask": ["bash(git push *)"],
    "allow": ["bash(git status*)", "example-extension-tool"]
  }
}
```

`maxUserTranscriptTokens` covers human instructions, verified ask answers, and delegated assignments, including retained human evidence from live OMP ancestors. `maxToolTranscriptTokens` covers assistant tool-call payloads. Both are approximate content budgets, excluding JSON metadata and escaping overhead, default to 4000, and accept integers of at least 32. Human intent anchors take priority over delegated text. Content is truncated before JSON serialization; the full serialized request still undergoes classifier context-window checks.

Pi-automode does not support the former `maxTranscriptLines` field. Evidence selection now uses token budgets instead of line counts.

## Read-only Bash and read-only roots

Two opt-in settings let provably read-only calls skip the classifier. Both are off by default. Only global configuration, trusted project-local `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON` can set them. Shared project `.pi/automode.json` cannot, because both settings widen what runs without review.

### `allowReadOnlyBash`

With `allowReadOnlyBash: true`, a Bash command skips the classifier when static analysis shows that it only reads files. Everything the analysis cannot prove goes through the normal pipeline. The tier runs after `permissions.deny`, `permissions.ask`, deterministic hard-deny checks, and the `deniedPaths` gate, so none of them is weakened. An accepted `permissions.ask` rule still sends the call to the classifier.

A command qualifies when all of these hold:

- It is a list of simple commands joined by `|`, `&&`, `||`, or `;`. Loops, functions, subshells, `case`, background jobs, negation, `time`, here-documents, and here-strings are not accepted.
- Every word is static. Command and process substitution, variables, globs, brace expansion, and `~user` are rejected. `~`, `$HOME`, and `${HOME}` are accepted only at the start of a word.
- It has no environment-assignment prefix such as `A=1 cmd`.
- Redirects are limited to `/dev/null`, descriptor duplication such as `2>&1`, and `< file`.
- Each command is on a fixed allowlist, and every flag is on that command's own allowlist. An unknown flag rejects the command. The allowlist is `ls`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `pwd`, `echo`, `printf`, `true`, `grep`, `egrep`, `fgrep`, `rg`, `sed`, `jq`, `find`, `git`, `which`, `type`, `tree`, `du`, `df`, `date`, `uname`, `id`, `whoami`, `sort`, `uniq`, `cut`, `tr`, `nl`, `column`, `basename`, `dirname`, `realpath`, `readlink`, `diff`, `cmp`, and the `*sum` checksum tools.
- Flags that write or run another program are on no list: `sed -i`, `sed` scripts with `w`, `e`, or `r`, `sort -o`, `find -exec`, `-delete`, and `-fprint*`, `rg --pre` and `-z`, `git -c`, `--output`, `--ext-diff`, and `--textconv`, and `file -C`. Pagers, `env`, `xargs`, `awk`, `tee`, interpreters, and shells are not allowlisted.
- `sed` accepts only `p`, `d`, `q`, `=`, and plain `s///` scripts. `jq` rejects `env`, `$ENV`, and module directives. `git` accepts only read subcommands (`status`, `log`, `show`, `diff`, `blame`, `rev-parse`, `rev-list`, `branch --list`, `tag --list`, `ls-files`, `ls-tree`, `describe`, `merge-base`, `for-each-ref`, `show-ref`, `remote -v`, `worktree list`, and `config --get <key>`), `-C <dir>`, `--no-pager`, and `--no-optional-locks`. It rejects signature placeholders that run `gpg` and config keys that hold credentials.
- A single leading `cd /absolute/path` is accepted, alone or followed by `&&`. Statements after a `;` are checked in both the old and the new directory, because the `cd` can fail.
- Every path argument, option value, redirect source, and `cd` target is resolved against the working directory, following symlinks one component at a time, and checked against `deniedPaths` and the safety-control paths. It must not reach `/proc`, `/dev` (except `/dev/null`), or `/sys`. Recursive commands (`grep -r`, `rg`, `find`, `du`, `tree`, `ls -R`, `git diff`, `git log`, `git show`, `git blame`) also fail when the search scope can contain a denied path, or when it starts at `/`. `ls -RL`, `tree -l`, and `diff -r` without `--no-dereference` are rejected because they follow symlinks out of the checked scope.
- Arguments that look like URLs (`skill://`, `local://`, `ssh://`, `file://`, …) are rejected. The shell can map some schemes to files or hosts.
- A `cwd` argument on the Bash tool is resolved and checked like a `cd` target. A `cwd` that is not a plain local path sends the call to the classifier.

When `allowInsideWorkingDirectory` is on, file tools reach the classifier outside the working directory. Read-only Bash follows the same rule: every path must be inside the working directory or a `readOnlyRoots` entry. `classifyReadOnlyTools` does not affect this tier. Leave `allowReadOnlyBash` off if every read must be reviewed.

#### Limits

The analysis is a static allowlist and gives no sandbox guarantee.

- Reads are limited by `deniedPaths` only. A secret that is not listed there, such as a token in a project file, is readable and its content reaches the model. List sensitive locations in `deniedPaths`.
- The check happens before the command runs. A file or symlink that changes in between is not detected.
- `git` runs with the repository's own configuration. When the repository's `config` (or a linked worktree's shared `config` and `config.worktree`) mentions a key that can run a program, such as `core.fsmonitor`, `diff.external`, a `textconv` or `filter` driver, a pager, an alias, or an `include`, the command goes to the classifier. Global git configuration is not checked. `git status` and `git diff` can also refresh `.git/index`.
- Flag tables follow GNU coreutils, ripgrep, and git. A different implementation of the same name, a shell function, or an alias that shadows an allowlisted binary in the session shell is not detected.
- `git remote -v` and `git config --get remote.<name>.url` print remote URLs, which can embed credentials.

### `readOnlyRoots`

`readOnlyRoots` is a list of absolute directories, default `[]`. A `read`, `grep`, `find`, or `ls` call whose path is inside one of them skips the classifier, even outside the working directory. Typical entries are scratch and cache trees such as `/tmp`, `~/.omp/wt`, and `/nix/store`.

- `write` and `edit` never use roots.
- `deniedPaths` still blocks a matching path. Protected and safety-control paths, such as `.git/config` or `.pi/automode.json` inside a root, still reach the classifier.
- Paths are compared after symlink resolution, so a link inside a root that points outside it does not qualify. A root that is itself a symlink is resolved, and one that resolves to a protected location is ignored. Comparison is case-sensitive; a different spelling falls back to the classifier.
- Entries accept `~`, `$HOME`, and `${HOME}`. Pi-automode reports and ignores entries that are relative, contain `*` or `..`, or name `/`, the home directory or one of its ancestors, a system root such as `/etc`, `/usr`, `/var`, `/home`, or anything under `/proc`, `/sys`, `/dev`, `/etc`, or `/root`.
- A `grep` or `find` path that lists several targets (`a;b`), contains a glob, or is a URL does not use roots.
- `$defaults` is accepted and means nothing. Entries accumulate across configuration sources.
- Roots apply whether or not `classifyReadOnlyTools` is set.

## Settings menu

`/automode settings` opens an interactive menu for `enabled`, `classifierStrategy`, `classifierModel`, `judgeConfidence`, `classifierReasoningLevel`, `log.enabled`, and `log.classifierIo`. Each row shows the effective value and the source that supplies it: the built-in default, the global file, the project-local file, `PI_AUTOMODE_SETTINGS_JSON`, or, for `enabled`, the `/automode on` or `/automode off` choice of the current session. The menu repeats until you pick Done or press Escape.

A choice is written to `~/.pi/agent/extensions/pi-automode/config.json` and takes effect at once. The write keeps every other key in the file. `/automode model` writes to the same file. While a failed migration blocks global config writes, the menu refuses each change and prints the reason. The `enabled` row writes `autoMode.enabled`; it leaves the session's `/automode on|off` choice alone. Typed values are checked before they are saved: `judgeConfidence` must be above 0.5 and at most 1, and the reasoning level is one of `low`, `medium`, `high`, `xhigh`, `max`, or unset.

Sources with higher precedence still win over the global file. When a saved value is overridden, the confirmation names the winner, for example `classifier strategy saved globally: detailed, but the current config uses hybrid from PI_AUTOMODE_SETTINGS_JSON`. The winner can be `PI_AUTOMODE_SETTINGS_JSON`, a project-local file, or the session's `/automode on|off` choice.

Under OMP, the classifier model row lists the model roles (`@smol`, `@judge`, and any others that resolve to a chat model) with the model each resolves to, plus `typesafe/jev-latest` when `TYPESAFE_API_KEY` is set. The `Browse all models…` entry opens OMP's native model picker in selection-only mode, which changes no session or role. That picker lists models and no roles, which is why the roles sit in the list in front of it. Under Pi the row opens Pi's model list, and if OMP's picker fails to open the plain list takes its place. A chosen value passes the same checks as `/automode model <selector>`: a role must resolve to a model, Jev needs `TYPESAFE_API_KEY`, and a model must exist and have credentials.

pi-automode has no judge model setting. The `hybrid` strategy uses OMP's `judge` model role, so the menu shows a "Judge model" row under OMP that points to the OMP configuration (`modelRoles.judge`) and changes nothing.

Without a UI, such as print mode, `/automode settings` prints the current settings, their sources, and the global config path instead of prompting.

## Ask-user tools and explicit authorization

Classifier evidence uses newline-delimited JSON records with `kind` and `content` fields: human user messages and verified answers from OMP's built-in `ask` tool use `user`, agent-authored assignments use `delegation`, and assistant tool-call inputs use `tool`. JSON escaping keeps embedded labels, newlines, and record-like text inside content; they cannot create new human records. A final `{"kind":"omitted"}` record marks omitted or truncated evidence. OMP workers also receive retained human evidence from live ancestor sessions in this process. Assignments cannot grant human consent. Evidence excludes assistant prose and all other tool results, including answers from same-named or extension-provided ask tools such as `@vanillagreen/pi-questions`.

An OMP `ask` answer counts only when the tool reports itself as `<builtin:ask>` from the `builtin` source. Pi-automode records the question with the selected options, custom answer, and note from the result's structured details. It ignores timeout auto-selections, chat redirects, cancellations, errors, and nested tool calls. The classifier sees the answer as `Answered ask question "<question>": <answer>` at the result's position in the transcript, so a later user message can narrow or revoke it.

The answer must still meet the policy: soft-denied existing-file changes need a question and answer that name the task, one repository or worktree, path scopes, and whether modification, deletion, or both are allowed. Hard denies stay unconditional. The answer stops counting when its result leaves the active context, for example after compaction or on another branch.

Captured answers apply to built-in ask calls made while this version is installed. Earlier sessions do not contain the capture record. Send authorization as a normal chat message when no verified ask answer applies.

## `$defaults`

See [Defaults and rule-list behavior](defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries. The document also explains replacement behavior after omission of `$defaults`.

## Observability logging

Auto mode can write a JSONL observability log for decisions and classifier usage. Persisted sessions use a sidecar next to the Pi session file. In-memory sessions use a global application directory. Logging is off by default.

```json
{
  "autoMode": {
    "log": {
      "enabled": true,
      "classifierIo": false
    }
  }
}
```

With logging enabled, persisted-session sidecars also contain ccusage-compatible entries for every classifier response. When `classifierIo` is off, `ccusage pi` still reports a separate `-pi-automode` session. In-memory logs use the same entry shape but live outside the normal Pi session tree.

See [Observability logging](observability-logging.md) for the log file location, entry schema, and the `classifierIo` privacy tradeoff. Run `/automode config` to see the resolved log file path.

## Permission patterns

Permission patterns use Pi tool names. Examples include `bash(...)`, `write(...)`, `edit(...)`, and `read(...)`. The parser accepts capitalized names such as `Bash(...)`. The documented form is lowercase because Pi tool names are lowercase.

`permissions.allow` is a deterministic allow tier. The default list is `[]`. A matching rule skips classifier review.

Use this tier for a narrow command such as `bash(git status*)`. You can also use it for a side-effect-free extension or MCP tool.

The matcher understands primary arguments for `bash`, `eval` (the cell `code`; see [Eval tool](#eval-tool)), the file tools, and `grep`. For file tools, it uses the resolved `input.path`. A `scheme://` entry matches as typed, so `read(https://docs.example.com/*)` allows one site. For `grep`, it uses `input.pattern`.

For `bash`, pi-automode parses `input.command` with `unbash`. Deny and ask rules inspect each executable command in the Bash syntax tree. This includes pipelines, logical chains, compound commands, substitutions, and literal scripts passed to `bash -c`, `sh -c`, or `eval`. The analysis also follows these literal shell scripts through transparent `command`, `exec`, and `env` dispatch.

The matcher normalizes whitespace between Bash tokens. It preserves whitespace and quoting inside each token. Thus, `bash(git push*)` matches `git  push origin main`. Quoted operators do not create extra commands.

A Bash allow decision requires coverage for each executable command. A multi-command pattern must match the same AST structure and operators. This structure check also applies to one command inside a group, wrapper, control structure, or background statement. Separate single-command patterns only cover top-level foreground chains and plain pipelines. Other supported structure requires one matching structural pattern. A multi-command pattern must match the same number of commands in the same order. Each pattern command must match its corresponding input command. One wildcard cannot hide an additional command or a different operator.

A redirect requires explicit coverage in the allow pattern. The redirect operator, file descriptor, variable name, and target pattern must match. Here-documents and dynamic redirect targets continue to the classifier. Parser errors, dynamic command names, and dynamic wrapper scripts cannot use `permissions.allow`.

Control nodes with unrepresented semantic values cannot use `permissions.allow`. This includes loops, functions, coprocesses, case statements, test commands, and arithmetic commands. These scripts continue to the classifier.

Pi-automode does not execute shell expansions. It cannot resolve aliases, variables, generated scripts, or dynamic `eval` input. These calls continue to the classifier unless a deterministic rule blocks them.

For other tools, the matcher uses the serialized input object. Use a bare tool name for an MCP or extension tool. For example, `example-extension-tool` matches every call to that tool.

The providing extension or MCP server defines the Pi tool name. Pi-automode does not need a predefined list.

A match skips only the classifier call. It cannot skip `permissions.deny`, deterministic hard-deny checks, `deniedPaths`, or protected-path controls. An accepted `permissions.ask` rule also takes precedence. After confirmation, the call continues through deterministic checks and then reaches the classifier. It cannot use `permissions.allow`, the inside-working-directory tier, or the read-only fast path.

Pi-automode reads `permissions.allow` only from global configuration, trusted `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON`. Shared `.pi/automode.json` cannot add allow rules.

A pattern can contain at most 4,096 UTF-16 code units. Bash analysis accepts at most 1,048,576 UTF-16 code units. A longer Bash input is blocked before parsing.

For other allow matching, an input can contain at most 1,048,576 UTF-16 code units. A longer input returns no match. Deny and ask patterns match the same oversized input so that they fail closed.

`write` and `edit` calls whose resolved target is a protected path are never covered by `permissions.allow`. This includes protected targets reached through symlink aliases.

See [Permission recipes](permission-recipes.md) for narrow examples of Bash permissions, directory changes, command chains, redirects, and classifier guidance.

## Eval tool

OMP's `eval` tool runs Python or JavaScript cells. Its `code` can start shell commands that a `bash(...)` rule never sees, so pi-automode matches `eval` patterns against the code, scans the code for shell commands, and treats code it cannot fully read as opaque.

### Patterns

`permissions.deny`, `permissions.ask`, and `permissions.allow` accept `eval(...)`. The argument is a wildcard pattern matched against the cell's `code`, with the same `*` semantics as other patterns. `*` also matches newlines, so `eval(*shutil.rmtree*)` matches anywhere in the cell.

Prefix the pattern with `py:` or `js:` to limit it to one language: `eval(py: *requests.post*)`. `python:` and `javascript:` work too. A pattern without a prefix applies to both languages. To match code that literally starts with `py:`, write `eval(*py:*)`. If the call has no recognizable `language`, deny and ask rules still apply to a scoped pattern, and allow rules do not. `eval(py:)` with nothing after the prefix is malformed and fails closed like other malformed patterns.

### Embedded shell commands

Pi-automode extracts shell commands whose text is a literal from:

- Python: `subprocess.run`, `call`, `check_call`, `check_output`, `Popen`, `getoutput`, `getstatusoutput`; `os.system`, `os.popen`; `asyncio.create_subprocess_shell` and `create_subprocess_exec`; IPython `!cmd` lines, `var = !cmd`, and `%%bash` cells.
- JavaScript: `child_process` `exec`, `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync` (through `require`, `import`, `import()`, destructuring, or renamed imports); Bun's `$` template without `${}` interpolation; `Bun.spawn` and `Bun.spawnSync` with a literal array or `cmd`.

A string argument is shell text. An argument list becomes a command line with each word quoted. Glob characters and a leading `~` stay unquoted, so `['rm', '-rf', '/*']` is analyzed as `rm -rf /*`. That over-approximates what `exec` runs, which can only make deny rules and hard-deny checks stricter. A literal `cwd` becomes a leading `cd`. Literal strings joined with `+` (or written side by side in Python) are folded into one string.

Each extracted command goes through the same checks as a `bash` call: `bash(...)` deny and ask rules match it, and deterministic hard-deny checks apply to it. Every command in a cell must pass, and the block reason names the embedded command. A `bash(rm -rf /*)` deny rule therefore blocks `subprocess.run(['rm', '-rf', '/*'])` in an `eval` cell.

An `eval` allow rule also needs every extracted command to be covered by `bash(...)` allow rules. `permissions.allow: ["eval"]` alone does not allow `os.system('git status')`.

### Opaque evals

When the scanner cannot be sure it saw every command, the eval is opaque. Common causes:

- an f-string with interpolation, a variable, or concatenation with a variable as the command; `shell=True` with a computed command;
- `getattr(subprocess, ...)`, `__import__`, `importlib`, `exec`, `eval`, `compile`, `ctypes`, `pty`, `os.exec*`, `os.spawn*`, `os.fork`;
- aliasing `subprocess` or `os`, or `from subprocess import ...`;
- `env=` or `executable=` options on a subprocess call;
- an IPython magic other than `%pwd`, `%ls`, `%env`, `%set_env`, `%who`, `%whos`, `%reset`, and `%load`, `%run`, or `%pip` cells;
- JavaScript `eval`, `Function`, `vm`, `process.binding`, computed member access, or a `child_process` function used as a value;
- code the scanner cannot tokenize, and extracted strings that are not valid shell.

An opaque eval never matches `permissions.allow`, even a bare `eval` rule. It skips the classifier's fast 0/1 stage, so the detailed review always runs. The classifier also receives the reasons, so it reads the code itself.

### `tool.*` calls

Code that calls `tool.bash(...)` or another `tool.*` function from inside `eval` reaches the `tool_call` hook as a normal call under the canonical tool name. Pi-automode does not parse those calls out of the eval code, so each one runs through the normal rules once.

### Limits

The scan is a best-effort lexical pass. It is not an interpreter and not a sandbox. It cannot see:

- values computed at run time;
- aliases defined in an earlier `eval` call. The Python and JavaScript sessions persist between calls, so `run = subprocess.run` in one call and `run(['rm', '-rf', '/'])` in the next hides the command from the scan. The first call is opaque and the second is not;
- code reached through files, installed packages, `%run`, or `%load`;
- file operations such as `shutil.rmtree`, `os.remove`, `pathlib.Path.unlink`, `open(..., 'w')`, or `fs.rmSync`. These are not modeled as shell commands and reach the classifier like any other action;
- network or other side effects that need no shell.

Obfuscation that defeats the lexer can still hide a command. The classifier remains the backstop for everything a deterministic rule does not block.

## TypeSafe Jev

Select the backend through the existing `autoMode.classifierModel` setting:

```json
{
  "autoMode": {
    "classifierModel": "typesafe/jev-latest",
    "classifierTimeoutMs": 20000
  }
}
```

Set `TYPESAFE_API_KEY` in the process environment before starting OMP or Pi. Do not put API keys in automode rules or configuration files. The extension sends the key only as a Bearer authorization header to `https://api.typesafe.ai/v1/systemone`.

`typesafe/jev-latest`, `typesafe/jev-preview`, and pinned IDs such as `typesafe/jev-1.14.0` use the native TypeSafe backend. No `models.json` entry or `/login` provider is required. `/automode model typesafe/jev-latest` saves the selection globally and requires the environment key. When the key is present, the picker includes `jev-latest` and the currently configured Jev version.

Any other `provider/model-id` uses the existing Pi/OMP registry and provider credentials. Omitting `classifierModel` uses `@smol` under OMP and the current session model under Pi. Setting a TypeSafe key alone does not switch backends.

Jev evaluates four typed questions in one request: hard-deny match, soft-deny match, coverage by ALLOW exceptions, and direct user authorization for all remaining soft-denied effects. Hard denies always block. A soft deny blocks unless every affected operation is covered by an exception or direct user authorization. Actions without a deny match are allowed.

Jev cannot generate a free-text explanation; denial reasons identify the policy tier. `classifierReasoningLevel` and `fastClassifierMaxTokens` do not alter Jev requests. An explicitly requested reasoning level is logged with effective level `off`. `classifierTimeoutMs` covers the entire native request, including response-body consumption, and parent cancellation still applies.

The extension keeps the full action and uses the existing bounded transcript. Conservative context estimates enforce TypeSafe's default 32k per-question and 64k per-request limits without truncating the action. It does not enable TypeSafe's experimental long-context header.

Missing credentials, transport errors, non-success HTTP responses, malformed or incomplete typed answers, context overflow, cancellation, and deadlines block the action. They never fall back to a different classifier. Existing permission, deterministic hard-deny, and local allow tiers run before either backend.

## Custom models (like OpenRouter's presets)

Except for the native Jev backend above, pi-automode selects models through Pi's model registry. Add unlisted chat models to `~/.pi/agent/models.json`.

For example, register an OpenRouter preset in the built-in `openrouter` provider:

```json
{
  "providers": {
    "openrouter": {
      "models": [
        {
          "id": "@preset/nvidia-nemotron-3-nano-30b-a3b-fast",
          "name": "NVIDIA: Nemotron 3 Nano 30B A3B Fast (Preset)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 235929,
          "cost": {
            "input": 0.05,
            "output": 0.2,
            "cacheRead": 0.03,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Restart Pi (or run `/reload`), then select the model with `/automode model openrouter/@preset/nvidia-nemotron-3-nano-30b-a3b-fast`.
