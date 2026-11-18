# omp-automode

Auto mode guardrails for Oh My Pi (OMP) and Pi, with configurable TypeSafe Jev or Pi/OMP classifier models.

This is [royce-mathew/omp-automode](https://github.com/royce-mathew/omp-automode), a fork of [czottmann/pi-automode](https://github.com/czottmann/pi-automode) by Carlo Zottmann. The upstream MIT license and attribution are retained. The fork's package name is `@royce-mathew/omp-automode`; its commands and existing configuration paths remain compatible with pi-automode.

This is a guardrail extension. It intercepts agent tool calls before execution and blocks actions that match permission deny rules, deterministic hard-deny checks, or the auto-mode classifier's block decision.

It is not a sandbox. Extensions run in the Pi process. A malicious extension can do anything that your user account can do.

Pi-automode does not guard user `!` or `!!` shell commands. It guards only agent tool calls. Use it to reduce unsafe autonomous tool use. Do not use it as an OS security boundary.

## Compatibility

Pi-automode supports Pi and Oh My Pi (OMP) 18. It automatically uses OMP's legacy completion API. The integration needs no OMP-specific configuration.

## Install

### OMP marketplace

After these changes are committed and pushed to the fork:

```text
/marketplace add royce-mathew/omp-automode
/marketplace install omp-automode@omp-automode
```

The full Git URL also works: `/marketplace add https://github.com/royce-mathew/omp-automode`. The repository includes `.omp-plugin/marketplace.json` and declares the runtime extension through `package.json`'s `omp.extensions`.

The Git tree includes the pinned `unbash` parser, so marketplace installs do not need a separate npm install. OMP supplies the Pi-compatible host APIs.

To use this local checkout before pushing:

```text
/marketplace add ~/omp-autmode
/marketplace install omp-automode@omp-automode
```

Restart OMP after installation so it loads the extension module. Do not enable this fork and upstream pi-automode together: both register the same commands and guardrail hooks. Disable or uninstall the old plugin before enabling the fork.

### Pi or local development

```bash
pi install https://github.com/royce-mathew/omp-automode
```

For a live local development link instead of a marketplace-cached copy:

```bash
omp plugin link ~/omp-autmode
```

To load the checkout for one invocation without installing or bundling it:

```bash
omp --no-extensions --extension ~/omp-autmode
```

The upstream npm package `@czottmann/pi-automode` does not contain this fork's Jev integration.

## Choosing the classifier

For Jev, set `TYPESAFE_API_KEY` in the environment before starting OMP or Pi, then run:

```text
/automode model typesafe/jev-latest
```

Use a pinned version such as `typesafe/jev-1.14.0` if needed. Jev appears in the interactive `/automode model` prompt when the key is present. It uses TypeSafe's native [System One API](https://docs.typesafe.ai/api), not a chat-completions endpoint, and needs no Pi provider registration.

To switch back, run `/automode model provider/model-id` with any configured Pi/OMP model. Under OMP you can also pass a model role such as `/automode model @smol` or `/automode model @judge`; the classifier then uses that role's model and its fallbacks. Without an argument, `/automode model` under OMP lists the model roles and opens OMP's native model picker from its `Browse all models…` entry; under Pi it shows Pi's model list. If `classifierModel` is omitted from configuration, OMP uses `@smol` and Pi uses the current session model. Jev is never selected merely because its key exists.

`/automode settings` opens a menu for the main classifier and logging settings and shows where each value comes from. See [Settings menu](docs/configuration.md#settings-menu).

Jev evaluates typed policy questions in one request; code combines the answers with hard-deny precedence. Missing keys, invalid responses, cancellation, and request timeouts block the action. Existing permission and deterministic checks are unchanged. See [Jev configuration](docs/configuration.md#typesafe-jev).

## Commands

```text
/automode status    # current state, rules, and classifier
/automode on        # re-enable for this session and its subagents
/automode off       # disable for this session and its subagents
/automode reload    # reload config from disk
/automode reset     # reset denial counters only
/automode defaults  # print the built-in rule lists
/automode config    # effective config, resolved log file path, + diagnostics
/automode denials   # denial history for this session
/automode settings  # interactive menu for the common settings; saves to the global config file
/automode model     # choose a classifier model (OMP: roles, then the native model picker; Pi: model list) and save it to the global config file
/automode model provider/model-id # save classifier model to the global config file
/automode model @smol # OMP only: use an OMP model role (and its fallbacks) as the classifier
```

## Agent diagnostics

The package registers one model-callable, read-only tool:

`automode_inspect` accepts one `action`:

- `status`: active state and counters, the last decision's kind, where the enabled state came from, the agent identity and `hasUI`, and recent typed classifier errors
- `config`: active effective configuration, log path, and diagnostics
- `defaults`: built-in rule lists
- `denials`: recent denial timestamps, kinds, and tool names

The tool reads the same in-memory configuration and state that the guardrail enforces. Permission and deterministic checks run before the bypass.

The bypass does not change automode counters or persisted state. It writes one `read-only` decision entry to the observability log when logging is on. The extension verifies the source of the tool before it applies the exemption. Thus, a name collision does not exempt a tool from another extension.

The tool cannot enable or disable auto mode. It cannot reload configuration, reset state, select a model, or change configuration.

Pi sends tool output to the current model. The `status` and `denials` views omit denial reasons and action payloads. `status` shows classifier errors by type only, never the provider's error text.

If a diagnosis requires a reason, inspect a known-safe entry in the local observability log. The `config` view includes effective rule text. It removes raw JSON parser details from diagnostics.

Do not put credentials or other secrets in automode rules.

The bundled `automode-diagnostics` skill uses this tool to diagnose unexpected decisions without asking the user to copy output from slash commands. Configuration edits and automode state changes remain user-controlled. See [Agent diagnostics](docs/diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Status line

When the TUI is available, the extension sets one compact status segment:

| Text | Meaning |
|---|---|
| `<icon> auto` | Auto mode is on. |
| `<icon> auto · 2 blocked` | On, and 2 actions were blocked in this session (permission rule, hard-deny, or classifier). `/automode reset` clears the count. |
| `<icon> checking…` | A classifier call is in flight. The previous text returns when it finishes. |
| `<icon> off` | Disabled through configuration or `/automode off`. |

On OMP the icon is the theme's shield glyph (`cmd.shield`) for the active symbol preset, or `icon.auto` when the preset has no shield (ascii). Pi themes have no icons, so the extension uses `●`. Use `/automode status` for the full counters.

### Placing the status in OMP

By default OMP draws extension statuses as an extra row under the editor. To show the status inside the status bar, set `status` in `statusLine.leftSegments` or `statusLine.rightSegments`, which requires `statusLine.preset: custom`. OMP also keeps drawing the extra row while `status` is in the bar, so the text appears twice. Set `statusLine.showHookStatus: false` to drop the row. The `status` segment still lists every extension status, joined with `·`.

```yaml
# ~/.omp/agent/config.yml
statusLine:
  preset: custom
  showHookStatus: false
  leftSegments: [pi, model, mode, path, git, status]
  rightSegments: [context_pct]
```

OMP strips colors from statuses shown in the bar, so the text carries all of the meaning.

## Agent Hub (OMP)

On OMP, each session adds a read-only entry named `<agent>-automode` to the Agent Hub (`/hub`, then `1` for the agent roster): `main-automode` for the main agent and `<spawn id>-automode` for each subagent. While a classifier call is pending the entry shows `running` and the action being checked. Afterwards it shows `parked` with the latest allow or block decision. The entry is an advisor, so OMP does not list it as a peer or count it in the running-subagent badge, and revive and kill are disabled for it. It is removed when the session shuts down.

## Docs

- [Configuration](docs/configuration.md)
- [Permission recipes](docs/permission-recipes.md)
- [Defaults and rule-list behavior](docs/defaults.md)
- [Auto-mode classifier flow](docs/automode-classifier-flow.md)
- [Observability logging](docs/observability-logging.md)
- [Architecture decisions](docs/adr/INDEX.md)

## What runs before the classifier

The extension blocks these before any allow or classifier decision:

- `permissions.deny` matches
- declined `permissions.ask` matches
- shell profile writes
- SSH `authorized_keys` writes
- cron, launch agent, and system service persistence
- TLS/certificate/auth weakening patterns
- root, home, and system-path destructive deletes. Subtrees of validated launcher-declared temp directories are treated as disposable. Declared roots that alias `HOME`, `/`, or a system root, or that contain `HOME`, are rejected instead.
- edits to the loaded extension, `.pi/automode*` and `.omp/automode*` config files, the global automode config directory, and Pi permission and settings files. Other checkouts of this extension's source, such as a git clone or worktree, are ordinary project code. See [Active controls](docs/automode-classifier-flow.md#active-controls).

After these checks, pi-automode applies `permissions.allow`. Protected `write` and `edit` targets continue to the classifier.

Accepted ask rules also continue to the classifier. They cannot use an allow tier. Pi-automode then allows the read-only tools `read`, `grep`, `find`, and `ls`. Every remaining action goes to the classifier.

A `permissions.allow` rule intentionally skips classifier policy, including classifier `hard_deny` rules. Use narrow patterns and user-owned configuration. Deterministic hard-deny and path controls remain unconditional.

Set `classifyReadOnlyTools: true` (default `false`) to route read-only tools through the classifier. This configuration value increases model calls, latency, and session cost.

Pi-automode blocks a `deniedPaths` match before classifier review or an allow tier. Thus, file tools cannot send matching secret or system paths to the model.

The list does not govern `bash`. The classifier and deterministic hard-deny checks govern shell access to these paths.

The value `allowInsideWorkingDirectory: true` allows file access inside the working directory locally. Pi-automode sends all outside file access to the classifier, including reads.

Two opt-in settings let provably read-only calls skip the classifier. `allowReadOnlyBash: true` (default `false`) allows Bash commands that static analysis shows only read files: allowlisted binaries and flags, static words, no redirects except `/dev/null`, no substitutions, and every path checked against `deniedPaths`. `readOnlyRoots` (default `[]`) lists absolute directories, such as `/tmp` or `~/.omp/wt`, where `read`, `grep`, `find`, and `ls` skip the classifier outside the working directory. Only user-owned configuration can set them. Neither setting provides a sandbox. See [Read-only Bash and read-only roots](docs/configuration.md#read-only-bash-and-read-only-roots) for the allowlist and its limits.

For Pi/OMP chat models, classification starts with a conservative one-token filter. If the filter requests review, pi-automode requests one internal `classifier_decision` tool call.

The tool exists only in the nested classifier request. It is not registered with `pi.registerTool()`, and the main agent cannot call it.

Pi AI requests schema-constrained sampling with `strict: "prefer"`. Supported providers enforce the schema during generation. Pi-automode validates every returned tool call locally.

Both stages receive the complete current tool input in a dedicated message. Transcript truncation cannot remove action content. If the exact input cannot fit in the classifier context, auto mode blocks the call.

Auto mode records paths that the session's own allowed `mkdir`, `mktemp`, `git clone`, `gh repo clone`, `git worktree add`, and new-file `write` calls created, and lists the 30 newest to the classifier. Cleaning up such a path no longer counts as deleting files that existed before the session, even when the creating call has left the transcript window. A path is recorded only after the call returned without an error and only if it did not exist beforehand. The list does not override permission rules, hard-deny checks, `deniedPaths`, or protected paths. See [Auto-mode classifier flow](docs/automode-classifier-flow.md#paths-created-by-this-session).
Classifier evidence uses newline-delimited JSON records with `kind` (`user`, `delegation`, or `tool`) and `content` fields. Human instructions and verified built-in `ask` answers use `user`; agent-authored assignments use `delegation`; assistant tool-call payloads use `tool`. JSON escaping keeps embedded newlines, labels, and JSON-looking text inside their original content rather than creating new human records. OMP workers also receive retained human instructions and verified built-in `ask` answers from their live parent sessions in this process. Ancestor tool output and agent-authored assignments are excluded. Human intent anchors take priority over delegated text within the transcript budget. Later human restrictions control; an assignment cannot grant consent or expand human-approved scope.

Evidence content is truncated before JSON serialization. Approximate transcript budgets count content, excluding JSON metadata and escaping overhead; the complete serialized request still undergoes context-window checks. A final `{"kind":"omitted"}` record marks omitted or truncated evidence.

Evidence preserves each session's active branch order, even if its clock moves backward. Across sessions, the next entries are merged by finite message time, falling back to a valid session-entry time. An undated next entry precedes a dated one; ties use root-to-leaf session order. These fallback rules make presentation deterministic, not proof of actual cross-session recency.

This sends retained parent human messages to the configured classifier as well as the worker's own evidence. Forks, switched-away parents, parents outside this process, and parents without session files do not supply inherited evidence. Missing authorization is not inferred from a worker's assignment.

The classifier evaluates the current action's security risk, not code quality or previous denials. Non-secret local diagnostic reads, including SQLite `SELECT` queries, are not production mutations or external disclosures merely because a path contains `production`. Secret exposure and external disclosure rules still apply.

Both stages use a classifier-specific session key. They request short cache retention from providers that support it. A missing model, provider failure, or invalid response blocks the action.

With `typesafe/jev-*`, a single native Jev request evaluates hard-deny matches, soft-deny matches, allow exceptions, and remaining direct user authorization. Jev receives the same policy, retained evidence, and complete current action. The extension validates its typed answers before deciding; it does not ask Jev for generated text or tool calls.

Pi-automode parses Bash structure with `unbash` before permission and deterministic hard-deny checks. The analysis includes nested commands and literal shell-wrapper scripts. A Bash parse error blocks the action.

Deterministic path checks include possible directories reached by `cd` and resolve symlink aliases to shell profiles and SSH authorized keys. The checks follow the command order, so a `cd` or `eval` that cannot be resolved safely only affects the commands after it: relative deletion, permission mutation, and redirects that write a relative path fail closed from that point on. Commands in loops and functions are checked against every directory the script can reach, because they can run again later. A path that starts with a variable, such as `$d/out.yml` after `d=$(mktemp -d)`, does not depend on the working directory. After an unresolved directory change it is checked as if the variable were empty, so `rm -rf "$d"/` and `$d/../etc` stay blocked. Descriptor duplication such as `2>&1`, here-documents, and input redirects open no file for writing and do not trigger this. Unquoted pathname expansion in an executable name and decoded NUL characters in shell words also block the call, even when a Bash allow rule matches.

OMP's `eval` tool gets the same checks for the shell commands in its code. Pi-automode extracts literal commands from Python (`subprocess.*`, `os.system`, `os.popen`, IPython `!cmd`) and JavaScript (`child_process`, Bun's `$` and `Bun.spawn`) and runs each through `bash(...)` permission rules and the hard-deny checks. `permissions.*` rules also accept `eval(...)` patterns, optionally scoped as `eval(py: ...)` or `eval(js: ...)`. Code the scanner cannot read, such as computed commands, `getattr(subprocess, ...)`, or `exec`, is opaque: it never matches `permissions.allow` and always gets the detailed classifier review. The scan is lexical and best-effort. It is not a sandbox and cannot see aliases from earlier `eval` calls or file operations. See [Eval tool](docs/configuration.md#eval-tool).

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` (`.omp/automode.local.json` under OMP) in a project and edit the domains, buckets, and source-control org.
- [Permission recipes](docs/permission-recipes.md): use narrow examples for common permission and classifier-policy changes.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.

Classifier authorization depends on retained, token-budgeted evidence and model judgment. Relevant restrictions can be omitted or truncated, and missing timestamps cannot establish cross-session chronology. Intent anchors and fail-closed classifier errors do not turn this into a deterministic authorization boundary.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

Bash permission and hard-deny checks use `unbash` 4.0.10, included under `extensions/vendor/unbash` with Lars Kappert's ISC license. To upgrade it, update the exact `devDependencies.unbash` version, run `npm install`, then run `npm run vendor:unbash` and commit the refreshed distribution with its lockfile. Verify a dependency-free installation with `node --import tsx --test --test-name-pattern='marketplace copy' tests/*.test.ts`.

`extensions/auto-mode/session-tree.ts` owns live session registration, parent linkage, and shared toggles. Extension lifecycle hooks explicitly register and unregister each instance; transcript assembly receives evidence snapshots, not parent contexts. `state.ts` owns persisted counters, denial history, and status formatting.

The tests cover these safety-sensitive areas:

- scoped permission matching
- the `permissions.allow` tier and its precedence
- configuration-source precedence and diagnostics
- `$defaults` behavior
- deterministic hard-deny checks and Bash AST analysis
- classifier routing for `write` and `edit`
- symlink-aware safety-control checks
- token-budgeted transcript selection
- session-created path tracking
- staged classifier tool-call parsing and cache behavior
- hook-level allow and block behavior

## Publishing

When a maintainer publishes a GitHub Release, GitHub Actions publishes the package to npm. The required release tag format is `v<version>`. The `<version>` value must be the same as the version in `package.json`. For example, version `1.0.0` requires tag `v1.0.0`.

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

### Release tag must point at the version bump

The publish workflow checks the commit that the release tag identifies. It compares the version in `package.json` with the tag name.

**The tag must identify a commit that contains the new version.**

1. Commit the version change with `chore: release X.Y.Z`.
2. Push `main`.
3. Create the GitHub release from that commit.

If the tag identifies an older version, the `Check release tag` step fails. It reports `Release tag (vX.Y.Z) does not match package.json version (x.y.z)`.

CAUTION: Do not move a correct release tag. Moving the tag changes a published reference.

1. If the tag identifies the wrong commit, force-move it to the version-change commit.
2. Force-push the corrected tag.
3. Run `gh workflow run publish.yml --ref vX.Y.Z`.

When GitHub creates the tag, the `release` event occurs. A rerun of a failed `release` workflow uses the original reference. It does not use the moved tag.

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@czottmann
