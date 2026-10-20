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

The upstream npm package `@czottmann/pi-automode` does not contain this fork's Jev integration.

## Choosing the classifier

For Jev, set `TYPESAFE_API_KEY` in the environment before starting OMP or Pi, then run:

```text
/automode model typesafe/jev-latest
```

Use a pinned version such as `typesafe/jev-1.14.0` if needed. Jev appears in the interactive `/automode model` picker when the key is present. It uses TypeSafe's native [System One API](https://docs.typesafe.ai/api), not a chat-completions endpoint, and needs no Pi provider registration.

To switch back, run `/automode model provider/model-id` with any configured Pi/OMP model. If `classifierModel` is omitted from configuration, the current session model remains the default. Jev is never selected merely because its key exists.

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
/automode model     # open classifier model selector and save to ~/.pi/agent/extensions/pi-automode/config.json
/automode model provider/model-id # save classifier model to ~/.pi/agent/extensions/pi-automode/config.json
```

`/auto-mode` is an alias.

## Agent diagnostics

The package registers one model-callable, read-only tool:

`automode_inspect` accepts one `action`:

- `status`: active state and counters
- `config`: active effective configuration, log path, and diagnostics
- `defaults`: built-in rule lists
- `denials`: recent denial timestamps, kinds, and tool names

The tool reads the same in-memory configuration and state that the guardrail enforces. Permission and deterministic checks run before the bypass.

The bypass does not change automode counters, persisted state, or observability logs. The extension verifies the source of the tool before it applies the exemption. Thus, a name collision does not exempt a tool from another extension.

The tool cannot enable or disable auto mode. It cannot reload configuration, reset state, select a model, or change configuration.

Pi sends tool output to the current model. The `status` and `denials` views omit denial reasons and action payloads.

If a diagnosis requires a reason, inspect a known-safe entry in the local observability log. The `config` view includes effective rule text. It removes raw JSON parser details from diagnostics.

Do not put credentials or other secrets in automode rules.

The bundled `automode-diagnostics` skill uses this tool to diagnose unexpected decisions without asking the user to copy output from slash commands. Configuration edits and automode state changes remain user-controlled. See [Agent diagnostics](docs/diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Status line

When the Pi TUI is available, the extension renders a persistent status line:

```text
AM ● a:12 d:2 ca:5 cd:1
```

- `AM` — auto-mode prefix. `●` means enabled. `○` means disabled through configuration or `/automode off`.
- `a:` — actions allowed so far (checked minus denied).
- `d:` — actions denied so far, for any reason (permission rule, deterministic hard-deny, or classifier).
- `ca:` / `cd:` — classifier decisions split into allowed and denied. These segments appear after the first classifier call. `d:` counts all denials, so `d:` is always `>= cd:`.

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
- edits to `.pi/automode*`, `.pi` auto-mode files, and this extension's safety-control files

After these checks, pi-automode applies `permissions.allow`. Protected `write` and `edit` targets continue to the classifier.

Accepted ask rules also continue to the classifier. They cannot use an allow tier. Pi-automode then allows the read-only tools `read`, `grep`, `find`, and `ls`. Every remaining action goes to the classifier.

A `permissions.allow` rule intentionally skips classifier policy, including classifier `hard_deny` rules. Use narrow patterns and user-owned configuration. Deterministic hard-deny and path controls remain unconditional.

Set `classifyReadOnlyTools: true` (default `false`) to route read-only tools through the classifier. This configuration value increases model calls, latency, and session cost.

Pi-automode blocks a `deniedPaths` match before classifier review or an allow tier. Thus, file tools cannot send matching secret or system paths to the model.

The list does not govern `bash`. The classifier and deterministic hard-deny checks govern shell access to these paths.

The value `allowInsideWorkingDirectory: true` allows file access inside the working directory locally. Pi-automode sends all outside file access to the classifier, including reads.

For Pi/OMP chat models, classification starts with a conservative one-token filter. If the filter requests review, pi-automode requests one internal `classifier_decision` tool call.

The tool exists only in the nested classifier request. It is not registered with `pi.registerTool()`, and the main agent cannot call it.

Pi AI requests schema-constrained sampling with `strict: "prefer"`. Supported providers enforce the schema during generation. Pi-automode validates every returned tool call locally.

Both stages receive the complete current tool input in a dedicated message. Transcript truncation cannot remove action content. If the exact input cannot fit in the classifier context, auto mode blocks the call.

Both stages use a classifier-specific session key. They request short cache retention from providers that support it. A missing model, provider failure, or invalid response blocks the action.

With `typesafe/jev-*`, a single native Jev request evaluates hard-deny matches, soft-deny matches, allow exceptions, and remaining direct user authorization. Jev receives the same policy, retained evidence, and complete current action. The extension validates its typed answers before deciding; it does not ask Jev for generated text or tool calls.

Pi-automode parses Bash structure with `unbash` before permission and deterministic hard-deny checks. The analysis includes nested commands and literal shell-wrapper scripts. A Bash parse error blocks the action.

Deterministic path checks include possible directories reached by `cd` and resolve symlink aliases to shell profiles and SSH authorized keys. If a directory change cannot be resolved safely, relative deletion, permission mutation, and redirects that write a relative path fail closed. Descriptor duplication such as `2>&1`, here-documents, and input redirects open no file for writing and do not trigger this. Unquoted pathname expansion in an executable name and decoded NUL characters in shell words also block the call, even when a Bash allow rule matches.

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` in a project and edit the domains, buckets, and source-control org.
- [Permission recipes](docs/permission-recipes.md): use narrow examples for common permission and classifier-policy changes.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

Bash permission and hard-deny checks use `unbash` 4.0.10, included under `extensions/vendor/unbash` with Lars Kappert's ISC license. To upgrade it, update the exact `devDependencies.unbash` version, run `npm install`, then run `npm run vendor:unbash` and commit the refreshed distribution with its lockfile. Verify a dependency-free installation with `node --import tsx --test --test-name-pattern='marketplace copy' tests/*.test.ts`.

The tests cover these safety-sensitive areas:

- scoped permission matching
- the `permissions.allow` tier and its precedence
- configuration-source precedence and diagnostics
- `$defaults` behavior
- deterministic hard-deny checks and Bash AST analysis
- classifier routing for `write` and `edit`
- symlink-aware safety-control checks
- token-budgeted transcript selection
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
