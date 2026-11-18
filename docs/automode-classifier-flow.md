# Auto-mode classifier flow

This document describes how `pi-automode` decides whether an agent tool call can run. The classifier is only one part of the flow. Several checks happen before any model call, and some tool calls never reach the classifier at all.

## Short version

For each Pi `tool_call` event, the extension does this:

1. Load the effective auto-mode configuration for the current session.
2. If auto mode is disabled, ignore the call.
3. If the agent turn was cancelled, block the call.
4. Block a matching `permissions.deny` rule.
5. If a `permissions.ask` rule matches, ask the user. A session without UI asks the nearest ancestor session that has one, or follows `headlessAsk`.
6. If the user declines or nobody can be asked, block the call.
7. Mark an accepted ask call for required classifier review.
8. Run deterministic hard-deny checks.
9. If no accepted ask rule requires review, let the extension-owned `automode_inspect` tool run locally.
10. Run path-deny checks, including recursive search scopes and symlink aliases. OMP's `grep` is narrowed with exclusions instead of blocked when a scope can reach a denied path.
11. If an ask rule was accepted, skip all deterministic allow tiers.
12. Otherwise, apply the read-only-root, `scheme://`, inside-working-directory, `permissions.allow`, read-only Bash, and read-only built-in tiers in that order. The read-only-root and read-only Bash tiers apply only when `readOnlyRoots` or `allowReadOnlyBash` is set.
13. For a configured `typesafe/jev-*` classifier, evaluate typed policy questions in one native request.
14. Otherwise, under `classifierStrategy: "hybrid"` (OMP only), ask a calibrated native judge from the `judge` role chain. It can only approve; a confident approval allows the call.
15. Otherwise, run the detailed review directly (`detailed`, or `hybrid` after the judge), or the one-token conservative filter followed by structured review when requested (`staged`, the default).
16. Persist state and update the UI status and denial history.
17. After an allowed `bash` or `write` call returns without an error, record the paths it created (see [Paths created by this session](#paths-created-by-this-session)).

The default posture is fail-closed. If model resolution, authentication, a classifier call, or response parsing fails, pi-automode blocks the action.

For OMP's `eval` tool, steps 4, 5, and 8 also run on every shell command pi-automode can extract from the code literally, as if it were a `bash` call. Step 12 never lets an opaque eval (code with commands the scanner cannot read) use `permissions.allow`, and step 14 skips the one-token filter for it. See [Eval tool](configuration.md#eval-tool).

## Diagram

```mermaid
flowchart TD
  A[Pi emits tool_call] --> B[Build effective config]
  B --> C{Auto-mode enabled?}
  C -- no --> Z[Let tool run]
  C -- yes --> D{Agent turn cancelled?}
  D -- yes --> X[Block: cancelled]
  D -- no --> F{Matches permissions.deny?}
  F -- yes --> F1[Block locally]
  F -- no --> G{Matches permissions.ask?}

  G -- yes --> H{UI available?}
  H -- no --> H2{headlessAsk}
  H2 -- block --> H1[Block locally]
  H2 -- classifier --> J
  H2 -- parent --> H3{Ancestor with UI?}
  H3 -- no --> H1
  H3 -- yes --> I
  H -- yes --> I[Ask user]
  I -- declined --> I1[Block locally]
  I -- accepted --> J[Require classifier review]
  G -- no --> J0[Continue normally]

  J --> K{Deterministic hard-deny?}
  J0 --> K
  K -- yes --> K1[Block locally]
  K -- no --> E{Extension-owned automode_inspect?}
  E -- yes --> E2{Classifier required by ask?}
  E2 -- no --> E1[Allow without state or log changes]
  E2 -- yes --> N[Resolve classifier backend]
  E -- no --> K2{Path denied or recursive scope unsafe?}

  K2 -- yes --> K1
  K2 -- no --> K3{Classifier required by ask?}
  K3 -- yes --> N
  K3 -- no --> K4{Inside-CWD allow tier?}
  K4 -- yes, non-protected --> L1[Allow locally]
  K4 -- no or protected --> K5{Matches permissions.allow?}
  K5 -- yes, non-protected --> L1
  K5 -- no or protected --> L{Read-only built-in fast path?}
  L -- yes --> L1
  L -- no --> N

  N --> N0{TypeSafe Jev?}
  N0 -- yes --> JV[Evaluate typed policy questions]
  JV --> JV0{Valid answers allow action?}
  JV0 -- yes --> Q
  JV0 -- no or error --> R
  N0 -- no --> NJ{hybrid and a calibrated native judge?}
  NJ -- confident approval --> Q
  NJ -- doubtful, no calibrated judge, or error --> ND[Run detailed review]
  ND --> P1
  NJ -- not hybrid --> N1[Run one-token filter]
  N1 --> O{Exact safe token?}
  O -- yes --> Q[Allow tool]
  O -- malformed or error --> O1[Block: fail closed]
  O -- review --> P[Request classifier_decision tool call]
  P --> P1{Valid allow decision tool call?}
  P1 -- yes --> Q
  P1 -- no or error --> R[Block with classifier reason]

  X --> S[Persist state and update UI]
  F1 --> S
  H1 --> S
  I1 --> S
  K1 --> S
  O1 --> S
  R --> S
  L1 --> T[Persist allow state and update UI]
  Q --> T
```

## Configuration loading

Pi-automode loads global and inline configuration during extension initialization. It loads project configuration on `session_start`. `/automode reload` reloads the effective configuration.

The effective configuration combines these sources:

- `~/.pi/agent/extensions/pi-automode/config.json`
- `.pi/automode.local.json` for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`
- shared `.pi/automode.json` for trusted projects, but only for `permissions.deny` and `permissions.ask`

Before `session_start`, pi-automode loads only global and inline configuration. If `ctx.isProjectTrusted()` returns `true`, it reads project configuration during `session_start` and `/automode reload`.

OMP never emits `session_start` for `/tan` clones. Pi-automode therefore initialises such a session on its first `before_agent_start` or `tool_call`, with the same steps as `session_start`: it loads the configuration for the session's own working directory and project trust, restores the persisted state, and binds the `/automode on|off` choice. A session that gets `session_start` later is initialised again.

For an untrusted project, pi-automode ignores both project files. `/automode config` reports each ignored file that exists.

Shared `.pi/automode.json` cannot change `autoMode` rules or add `permissions.allow`. A checked-in file must not reduce classifier coverage. If shared configuration contains `permissions.allow`, `/automode config` reports a diagnostic.

Deny and ask patterns use this source order: global, shared project, project-local, inline. Allow patterns use this source order: global, project-local, inline.

To disable pi-automode for the current project, set `autoMode.enabled` to `false` in `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This affects only the trusted project-local configuration. Shared project `.pi/automode.json` cannot disable auto mode.

List fields such as `allow`, `soft_deny`, `hard_deny`, `environment`, and `protectedPaths` support `$defaults`. Omitting `$defaults` replaces the built-ins for that section only. See [Defaults and rule-list behavior](defaults.md).

## Context captured before classification

On `before_agent_start`, the extension appends `AUTO_MODE_GUIDANCE` to the system prompt. This text states that auto mode is active. It also prohibits bypasses or weaker controls.

The same hook extracts context files from Pi's `systemPromptOptions.contextFiles`. The extracted text becomes `loadedContext`. Pi-automode formats each context file as follows:

```text
# path/to/file
<truncated content>
```

Pi-automode truncates the middle of each file to 4000 UTF-16 code units.

## Local checks before the classifier

### `permissions.deny`

Pi-automode checks `permissions.deny` first. A matching rule blocks immediately. Pi-automode does not call the classifier.

Example rule:

```json
"bash(git push --force*)"
```

Permission patterns apply to a Pi tool and its primary argument. `bash` uses `input.command`. `read`, `write`, `edit`, `find`, and `ls` use the normalized resolved `input.path`.

`grep` uses `input.pattern`. If the applicable argument is absent, the matcher uses the serialized input object.

The `*` wildcard matches zero or more characters, including newlines and path separators. Matching is case-insensitive and uses a bounded linear-time algorithm. A configured pattern can contain at most 4,096 UTF-16 code units. A primary argument can contain at most 1,048,576 UTF-16 code units. A longer argument conservatively matches a scoped deny or ask rule.

### `permissions.ask`

`permissions.ask` runs after `permissions.deny`.

If a rule matches in a session with a UI, pi-automode shows a confirmation dialog. The dialog contains the matched rule and the action summary.

If a rule matches in a session without a UI, `headlessAsk` decides. The default `parent` shows the dialog in the nearest ancestor session of the same process that has a UI, with the asking agent's name in the title, and waits 25 seconds. `classifier` skips the dialog, treats the rule as matched, and adds a note to the classifier context. `block` blocks the call. With `parent`, a missing ancestor, a decline, a timeout, or an abort blocks the call. See [Configuration](configuration.md) for the security trade-offs.

Approving that dialog does not run the tool directly. Deterministic denial checks continue first. After these checks pass, the classifier reviews the call. The call cannot use `allowInsideWorkingDirectory`, `permissions.allow`, or the read-only fast path.

### `permissions.allow`

`permissions.allow` is a deterministic allow tier. It uses the same patterns as `deny` and `ask`. Thus, it covers built-in, MCP, and extension tools:

```json
"permissions": { "allow": ["bash(git status*)", "example-extension-tool"] }
```

The matcher understands primary arguments for `bash`, the file tools, and `grep`. It uses the serialized input object for other tools.

Use a bare tool name for an MCP or extension tool. An argument pattern compares against the serialized input object.

A match skips only the classifier call. The tier cannot override permission denials, hard-deny checks, path denials, or protected-path controls. An accepted ask rule also disables this tier for the current call.

Pi-automode reads allow entries from global, trusted project-local, and inline configuration. It ignores allow entries in shared project configuration and reports a diagnostic.

A configured pattern can contain at most 4,096 UTF-16 code units. An input can contain at most 1,048,576 UTF-16 code units for allow matching. A longer input returns no match and continues to classifier review. Deny and ask matching uses the opposite overflow result so these rules fail closed.

The default list is empty. Thus, behavior does not change without explicit user configuration. Decision logs use `kind: permissions.allow`.

`/automode status` reports the rule count. `/automode config` shows the resolved patterns.

[ADR-001](adr/ADR-001-permission-precedence-and-trust-boundaries.md) records the precedence and trust-boundary rationale.

### Deterministic hard-deny checks

Some actions are too risky to leave to the classifier. Pi-automode blocks these actions before classifier review.

Current deterministic blocks include these actions:

- writes to shell profile files
- writes to `~/.ssh/authorized_keys`
- edits to the loaded extension (entry file, source directory, vendored parser), to Pi permission and settings files, and to `automode*` config files under `.pi`. Other checkouts of the extension's source are not covered. The checks resolve symlinks first and cover `write`, `edit`, write redirects, and file commands such as `sed`, `cp`, `mv`, `rm`, and `tee`.
- weaker TLS or certificate verification
- persistence changes such as cron jobs, launch agents, and system service enablement
- dangerous recursive deletes of root, home, or system paths
- selected system or SSH permission mutations

The `bash` checks use the `unbash` abstract syntax tree. They inspect chains, pipelines, compound commands, substitutions, redirects, and literal shell-wrapper scripts.

Recursive-delete checks hard-deny `/`, the user home root, and top-level system roots. They exempt subpaths of the user home because these paths contain user data.

Some distributions store `HOME` under `/var`. Fedora Silverblue uses `/var/home/<user>`, for example. Pi-automode does not treat `rm -rf` on this home subtree as a system-path delete. It still blocks `rm -rf ~`.

### Read-only bypass and the path gate

Pi-automode allows read-only built-in tools after the prior checks and the `permissions.allow` tier. `classifyReadOnlyTools: true` sends them to the classifier instead.

The read-only tool set is:

```text
read, grep, find, ls
```

Pi-automode still allows reads to protected paths.

Two optional fields change the deterministic tier. `deniedPaths` blocks matching file-tool paths before classifier review or an allow tier.

`allowInsideWorkingDirectory: true` allows file access inside the working directory without classifier review. This access includes writes and edits. Pi-automode sends all out-of-tree file access to the classifier, including reads.

Protected in-tree writes and edits do not use the local allow tier. They still reach the classifier.

A `scheme://` path is not a filesystem path. Pi-automode splits file-tool paths into URL entries and filesystem entries before it resolves anything. Reads of built-in OMP schemes (`skill`, `local`, `artifact`, `omp`, `history`, `issue`, `pr`, `mr`, `agent`, `proc`, `mcp`, `xd`) are allowed locally and logged with kind `url-scheme`. Every other scheme, including `http`, `https`, `ssh`, and server-defined MCP resource schemes, reaches the classifier even when `classifyReadOnlyTools` is off. A write to `xd://<tool>` is allowed because OMP runs the named tool as a nested call that emits its own `tool_call`. A write to `local://` follows `allowInsideWorkingDirectory`. Writes to `proc://`, `agent://`, `ssh://`, and any other scheme reach the classifier.

By default, both fields are off and `permissions.allow` is empty. Thus, every write and edit reaches the classifier.

Two more opt-in tiers cover reads. `readOnlyRoots` lets `read`, `grep`, `find`, and `ls` calls inside the listed directories skip the classifier outside the working directory. `allowReadOnlyBash: true` lets a Bash command skip the classifier when static analysis shows that it only reads files. Both run after every denial check and never apply to a call that an accepted ask rule sent to the classifier. See [Read-only Bash and read-only roots](configuration.md#read-only-bash-and-read-only-roots).

## Protected paths

The protected-path configuration identifies safety-sensitive targets. Examples include `.git`, `.pi`, editor directories, shell profiles, package-manager files, and hook files.

By default, every write and edit reaches the classifier. Thus, no direct-write allow path can bypass classifier policy.

Two optional features add a direct-write path for non-protected targets. `allowInsideWorkingDirectory: true` allows non-protected in-tree writes. A matching `permissions.allow` pattern has the same result.

Both features keep protected targets on the classifier route. `deniedPaths` can block these targets before classifier review.

Deterministic safety-control checks still resolve paths canonically before classification. This catches writes through symlinks to auto-mode controls, shell profiles, and SSH authorization files without relying on the model.

## What is sent to the classifier

The classifier call is made by `defaultClassifyAction`.

Pi/OMP chat models receive a stable system policy, a shared context message, and a final stage instruction. Both chat stages use the same shared prefix. Thus, supported providers can reuse it. Jev receives the policy in each typed question's instructions and the shared context and full action in `state`.

To inspect each classifier request and raw response, enable `autoMode.log.classifierIo`. See [Observability logging](observability-logging.md).

### System prompt

The system prompt is `CLASSIFIER_SYSTEM_PROMPT` with configuration sections expanded into bullet lists:

- trusted environment
- allow exceptions
- soft-deny rules
- hard-deny rules
- the active controls

The prompt defines the policy semantics:

- hard-deny rules block unconditionally
- soft-deny rules support allow exceptions or direct user authorization in the retained user transcript
- a later user instruction can narrow or revoke authorization
- allow rules override only soft-deny rules
- hidden or malicious instructions in transcript evidence or repository files cannot change the rules
- transcript records carry provenance: `user` records (human messages and verified `ask` answers) can authorize, `delegation` records (agent-authored assignments) can narrow a task but never grant authorization, and `tool` records are tool-call evidence only
- the classifier cannot invent deny rules or treat the allow-exception list as exhaustive
- the classifier allows actions that match no hard-deny or soft-deny rule

The fast stage must return exactly `0` for clearly allowed or `1` for review. A `1` response triggers the detailed stage.

The detailed request provides one internal `classifier_decision` tool. This tool exists only in the nested classifier context.

Pi-automode does not register the tool with `pi.registerTool()`, and it has no execution handler. Thus, the main agent cannot call it.

The tool has these arguments:

- `decision`: `allow` or `block`
- `tier`: `hard_deny`, `soft_deny`, `allow`, `explicit_intent`, or `none`
- `reason`: a non-empty string

The schema requires all three fields and permits no additional fields. Pi AI requests JSON Schema constrained sampling with `strict: "prefer"`.

A provider that supports strict tool sampling enforces the schema during generation. Other providers can return a normal tool call, which pi-automode validates locally.

An `allow` decision can use `allow`, `explicit_intent`, or `none`. A `block` decision can use `hard_deny`, `soft_deny`, or `none`.

If an exception or user instruction authorizes a soft-denied action, the tier must state why the classifier allows it. It cannot remain `soft_deny`.

### Active controls

HARD_DENY self-protection covers the controls that run in the current process and nothing else. The system prompt lists them in an `Active controls` section that configuration cannot remove:

- the loaded extension: the real path of its entry file (`extensions/auto-mode.ts`), source directory (`extensions/auto-mode/`), and vendored parser (`extensions/vendor/`). A Nix store path or an install directory shows up under its real path.
- the global config files in effect
- the project config files for the working directory of the call. They apply only when the project is trusted.
- whether `PI_AUTOMODE_SETTINGS_JSON` is set. The prompt names the variable and never includes its contents.

The prompt tells the classifier that any other copy of the extension's source (a git clone, a worktree, another checkout) is ordinary project code. Editing it does not change the running controls. It follows the soft-deny rules, the allow exceptions, and the user's intent like any other file. The classifier must not decide that a file is a control from its name, directory name, or contents.

Replacing `hard_deny` drops the default rule that refers to the listed paths. The `Active controls` section and the scoping rule stay, because they are part of the fixed prompt. A custom `hard_deny` rule about "the agent's safety controls" is read against the listed paths.

If the loaded extension directory is itself a git checkout (a development install such as `omp -e <checkout>/extensions/auto-mode.ts`), that checkout is the running copy. Its entry file, `extensions/auto-mode/`, and `extensions/vendor/` stay protected. Its docs, tests, and other files are ordinary project code. To develop the extension, edit a second checkout or worktree that the session did not load.

### User messages

The first user message contains shared context:

```text
<loaded-project-instructions>
${loadedContext || "(none)"}
</loaded-project-instructions>

<classifier-transcript>
${buildClassifierTranscript(...) || "(none)"}
</classifier-transcript>
```

`loadedContext` holds the context files the host loaded, such as `AGENTS.md`, each cut to 4000 characters. Their `<` characters are written as `\u003c`, so a repository file cannot close the block or start a `<classifier-transcript>` of its own.

When `headlessAsk` is `classifier` and a `permissions.ask` rule matched in a session without UI, the message ends with an `<extension-notes>` block. The block holds a note from the extension, not from the transcript:

```text
<extension-notes>
- A permissions.ask rule (bash(git push*)) matched this action, but this session has no interactive UI, so no user approved it. ...
</extension-notes>
```

Without notes, the block is absent.

When the session has created paths (see below), a `<session-created-paths>` block follows the transcript, ahead of any `<extension-notes>` block. The block is absent otherwise.

The next user message contains the complete current action as JSON. It is
separate from the transcript. Pi-automode does not truncate it:

```json
{"toolName":"bash","input":{"command":"npm test"}}
```

The fast and detailed stages receive the same context message and complete action message. Pi-automode checks each request before it sends the request. The estimate includes the system prompt, user-message text, and the stage instruction. For the detailed stage, the estimate also includes the serialized tool schema.

The estimate matches Pi 0.86. It uses `Math.ceil(text.length / 4)`, where `text.length` counts UTF-16 code units. Pi-automode also reserves the stage output limit and the configured reasoning budget. It keeps Pi's 4,096-token context margin.

Pi-automode checks the fast request before the fast-stage call. A fast result of `0` allows the action. Pi-automode does not check the unused detailed request. After a fast result of `1`, pi-automode checks the detailed request. This request includes the `classifier_decision` schema and the larger detailed output reserve.

If a stage request cannot fit in the classifier model's context window, auto mode blocks the call. It does not truncate the action.

Pi-automode builds the transcript from active context and branch snapshots supplied by `session-tree.ts`. Extension lifecycle hooks explicitly register and unregister each live session. The tree owns parent linkage and shared toggles; transcript assembly does not receive parent contexts.

The current session contributes:

- human text as `{"kind":"user","content":"..."}`
- agent-authored assignments as `{"kind":"delegation","content":"..."}`, which cannot grant human consent
- answers from OMP's built-in `ask` tool as `user` records, captured from structured result details when its provenance is `<builtin:ask>`
- assistant tool-call names and payloads as `{"kind":"tool","content":"..."}`

The transcript is newline-delimited JSON. Escaping keeps embedded newlines, labels, and JSON-looking text within a record's `content`; they cannot create new human records. This preserves structural provenance, not a deterministic guarantee that the model will judge authorization correctly.

Live OMP ancestors in this process contribute only retained human text and verified ask answers. Forks, switched-away parents, unavailable parents, and parents without session files contribute no inherited evidence. Assistant prose, hidden reasoning, and other tool results are excluded. Timeout auto-selections and chat redirects from `ask` are not user answers.

Each source retains its active branch order, even when timestamps regress. The merge compares only each source's next eligible entry, using a finite message timestamp or a valid session-entry timestamp. An undated next entry precedes a dated one; ties use root-to-leaf source order. Missing times cannot establish actual cross-session recency.

Human evidence and delegated assignments share the user-token budget; tool-call evidence has a separate budget. Both default to 4000 approximate tokens. These budgets count content, excluding JSON metadata and escaping overhead; the full serialized request remains subject to the context-window checks above. The selector prioritizes the latest and first human entries, then the latest and first entries overall, before filling remaining space from the newest eligible entries. Content is truncated before serialization, and a final `{"kind":"omitted"}` record marks any omitted or truncated evidence. These bounds and model judgment do not provide deterministic authorization.

Transcript truncation does not change the dedicated current-action message.

### Paths created by this session

The classifier sees only the most recent tool calls. A call that created a directory early in a long session can age out of the transcript before the agent cleans it up. The classifier would then treat the cleanup as deleting files that existed before the session started.

Pi-automode therefore records the paths that the session's own allowed calls created, and lists them to the classifier.

Tracked creators:

- `mkdir` (`-p` and several operands are supported)
- `mktemp`, when the call prints exactly one fresh path that matches the template
- `git clone [dir]` and `gh repo clone <repo> [dir]`, including the default directory name
- `git worktree add [-b branch] <path> [commit-ish]`
- the `write` tool, when it creates a new file

Rules for recording a path:

- The call must pass every check and run. A blocked call records nothing.
- The path must not exist when the call starts. A pre-existing directory, or a file that `write` overwrites, is never recorded.
- The path must exist when the result arrives, and the result must not be an error. A failed call records nothing, even if it created part of the path first.
- Calls that create missing parents (`mkdir -p`, `git clone`, `git worktree add`, `write`) record the topmost directory they created. Deleting that directory is the cleanup.
- Relative paths resolve against the working directory. Pi-automode follows `cd` only in a plain sequence or a `&&` chain. A path that depends on a variable, command substitution, glob, brace expansion, or a `cd` that it cannot follow is not recorded. It is never guessed.
- A path inside an already tracked path only refreshes that entry.

Pi-automode keeps the last 100 paths in the `pi-automode-state` entry (`createdPaths`, newest last). The list survives reloads and `/resume`. State entries from earlier versions have no such field and restore as an empty list. Tracking is off while auto mode is off.

The classifier receives at most the 30 newest paths. The block states what the list means:

- An action that only deletes, moves, overwrites, or modifies a listed path, or something beneath it, is the agent cleaning up its own artifact. It does not count as deleting files that existed before session start.
- A path that only shares a prefix with an entry, or a parent of an entry, is not covered.
- The list does not override hard-deny rules, denied or protected paths, or any other deny rule such as exfiltration or credential handling.

This list is evidence for the classifier only. Permission rules, hard-deny checks, `deniedPaths`, and protected-path handling run before the classifier and ignore it. Paths that contain control characters or angle brackets are never recorded or listed.

## Classifier strategies and the judge stage

`autoMode.classifierStrategy` picks the review path after the deterministic checks:

- `staged` (default): the one-token gate, then the detailed review on `1`.
- `detailed`: the detailed review only.
- `hybrid` (OMP only): the judge stage, then the detailed review unless the judge approved.

The judge stage asks OMP's `judge` role chain the four policy questions Jev uses. It runs only on a calibrated native judge (TypeSafe Jev). Prompted chat models answer one-hot, so `judgeConfidence` could not tell a sure answer from a guess, and on-device models are too weak. Both are skipped. When the chain has no usable native judge, the stage logs `judge-unavailable: no calibrated judge` as the attempt error and the detailed review decides.

The judge approves only when the safe-side probabilities reach `judgeConfidence`. Anything else, including errors and timeouts, escalates. It never blocks, and actions forced to review by `permissions.ask`, plus `eval`, skip it. See [Classifier strategy and the OMP judge](configuration.md#classifier-strategy-and-the-omp-judge).

## Classifier model resolution

Pi-automode selects the classifier model in this order:

1. `autoMode.classifierModel` from configuration. A `provider/model-id` value resolves through the model registry. An `@role` value (OMP only) resolves to that role's chain of models in attempt order, skipping models that are not chat-capable. The classifier uses the first model in the chain that has credentials.
2. Under OMP, the `@smol` role chain. If it resolves to nothing, the current session model.
3. Under Pi, the current session model.

`/automode model provider/model-id`, `/automode model @role`, the interactive model picker, and `/automode settings` save `autoMode.classifierModel` and the other editable settings to `~/.pi/agent/extensions/pi-automode/config.json`. Project-local `.pi/automode.local.json` can still override that global choice.

`typesafe/jev-*` selects the native TypeSafe API and reads `TYPESAFE_API_KEY` from the environment instead of consulting the Pi registry. One request evaluates four yes/no Choice questions. Local code gives hard-deny matches unconditional precedence, then permits soft-denied effects only when ALLOW exceptions or retained direct user authorization cover all of them. Missing or invalid answers block the action.

Jev uses the configured request deadline and `ctx.signal`, but no chat reasoning preference, output-token budget, tool call, session-cache key, or retry stage. Explicit reasoning requests are logged as effective `off`. Its response's versioned model ID, token usage, raw valid response, and tier decision use the existing observability format as one detailed-stage attempt. See [Jev configuration](configuration.md#typesafe-jev).

The remaining model-resolution and staged-parsing details below apply to Pi/OMP chat models.


`autoMode.classifierReasoningLevel` can request `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both stages.

When the key is absent, classifier calls omit a reasoning preference. The server then selects its default. When the key is present, classifier calls use the normalized Pi AI path.

Pi AI clamps the request to the nearest supported level. Models without reasoning support resolve to `off`. They remain on the normalized path without a reasoning preference.

Reasoning does not increase the stage token limits. A high level can use all stage tokens before it produces valid visible output. Truncation fails closed.

The fast-stage limit is 512 tokens. The detailed-stage limit is 1200 tokens. `low` matches the reasoning effort of Codex Auto Review.

The extension asks Pi's model registry for API credentials. If the model cannot be found or credentials are unavailable, classification returns a blocking decision:

```text
No classifier model/API key available; auto mode fails closed.
```

Classifier calls use `ctx.signal`, a stable classifier-specific session ID, and `cacheRetention: "short"`. They do not set a temperature because some providers reject it. The calls use provider defaults instead. Providers without cache affinity ignore that option.

The detailed request does not use provider-specific forced tool selection. Its instruction requires exactly one `classifier_decision` call. Missing or invalid calls fail closed.

`autoMode.classifierTimeoutMs` limits each fast-stage and detailed-stage request. The default is 20000 ms.

If a request exceeds its budget, pi-automode aborts it and blocks the action. A stalled provider stream has the same result.

The fast stage requires one visible digit and uses `maxTokens: 512`. Reasoning models can use hidden tokens before they emit the digit.

Extra visible content fails fast-stage parsing. Detailed review uses `maxTokens: 1200`. It can retry once after a missing, invalid, or truncated decision tool call.

## Parsing the classifier result

The fast-stage parser requires `stopReason: "stop"`. It removes surrounding whitespace and accepts only `0` or `1`.

Empty responses, additional content, malformed output, and non-stop responses block immediately. Observability logs preserve the untrimmed model response.

The detailed parser requires `stopReason: "toolUse"` and exactly one `classifier_decision` call. The response must not contain non-empty visible text.

The arguments must contain exactly `decision`, `tier`, and `reason`. Each value must have the required type and an allowed enum value.

The parser also checks the decision and tier combination. It rejects extra fields, unknown tiers, contradictory combinations, and empty reasons.

A response with `stopReason: "length"` can cause one retry. A missing or invalid decision tool call also can cause one retry.

A truncated or invalid response cannot authorize an action. Error and aborted responses block immediately.

If detailed parsing fails after its retry, pi-automode blocks the action with this reason:

```text
Classifier response did not contain a valid classifier decision tool call; auto mode fails closed.
```

If the model call throws, pi-automode blocks the action immediately. It uses a classifier failure message.

## Agent behavior after a blocked tool call

Pi converts a blocked hook response into an error result and does not run the tool. Pi-automode does not set `terminate: true`, so Pi can request the next model response.

The result states that the tool did not run and preserves the denial reason. The result and the Auto Mode guidance instruct the agent to:

- report the block to the user before work that depends on the blocked action continues
- not claim success or rely on effects from the blocked action
- not try an equivalent workaround

Independent work can continue. Interactive approval stays limited to configured `permissions.ask` rules. Classifier and deterministic denials stay final.

These instructions decrease ambiguity in the model context. They do not guarantee that each model will follow the instructions.

## State, UI, and denial history

Every checked action increments `checkedActions`.

Allowed actions store:

- `lastDecision: "allow"`
- `lastReason`

Blocked actions also increment `blockedActions` and add a denial record. Each denial record contains:

- timestamp
- tool name
- reason
- action summary
- denial kind

Recent denial history has a limit of 12 entries. Created paths are kept as a list of at most 100 entries. Pi-automode persists state with `pi.appendEntry("pi-automode-state", state)`. Thus, state survives reloads and session restoration.

When UI is available, the extension updates the footer status and shows a warning notification for blocked actions.

## Agent inspection tool

`automode_inspect` exposes `status`, `config`, `defaults`, and `denials` views to the agent. The extension verifies the source of the registered tool before it applies the exemption.

A tool from another extension with the same name still uses normal enforcement. Every view is read-only. After local checks pass, the hook returns before classifier routing and state updates.

Pi sends tool output to the model. Therefore, the `status` and `denials` views omit denial reasons and action summaries.

The `config` view contains effective rule text. Do not store secrets in automode rules.

No state-changing command has a tool equivalent. The user must run `/automode on`, `/automode off`, `/automode reload`, `/automode reset`, `/automode settings`, and `/automode model` directly. See [Agent diagnostics](diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Command interactions

The classifier flow can be inspected or changed through slash commands:

```text
/automode status
/automode on
/automode off
/automode reload
/automode reset
/automode defaults
/automode config
/automode denials
/automode settings
/automode model
/automode model provider/model-id
```

`/automode off` disables the whole flow for the current session and its OMP subagents, including subagents that are already running. `/automode on` re-enables it for the same sessions. This covers `/tan` clones as well as task subagents. A subagent finds its parent by the parent's session file or session id, whichever its session header names. Subagents follow the main session only when the main session is saved to a session file; under `--no-session` they keep the configured `enabled` value. `/automode model` saves the classifier model to `~/.pi/agent/extensions/pi-automode/config.json`.
