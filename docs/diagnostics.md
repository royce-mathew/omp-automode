# Agent diagnostics

`automode_inspect` is a model-callable, read-only tool. An agent can use it to inspect active pi-automode state without copied slash-command output.

Use this tool to investigate an unexpected allow or block. Do not use it to change a safety control or to bypass a denial.

## Inspection views

The tool accepts one `action` value.

| Action | Purpose | Result |
| --- | --- | --- |
| `status` | Inspect active state and counters. | A readable status summary; the enabled override and where the enabled state came from; the last decision and its kind; action counters; the agent identity and `hasUI`; and recent classifier errors. |
| `config` | Inspect the effective configuration. | The active configuration, the resolved observability log path, and configuration diagnostics. |
| `defaults` | Inspect built-in rule lists. | The built-in environment, allow, protected-path, soft-deny, and hard-deny lists. |
| `denials` | Find recent rejected actions. | Reverse-chronological timestamps, enforcement kinds, and tool names. |

The tool reads the same in-memory configuration and state that pi-automode enforces. Configuration changes take effect after session start or `/automode reload`.

## Enforcement behavior

An inspection call is not an unrestricted escape hatch.

1. `permissions.deny` runs first.
2. `permissions.ask` runs next.
3. Deterministic hard-deny checks run next.
4. The extension bypasses classifier routing only for its own registered `automode_inspect` tool, including a Bash call that is exactly one `automode_inspect …` command, as OMP 19.1 runs it when tool commands are on.

If a local check blocks the call, pi-automode records it as a blocked action. If the call passes, inspection does not change counters or state. With logging enabled, a passing call writes one `read-only` decision entry.

The extension verifies the registered tool source before it applies the bypass. A tool from another extension with the same name does not receive this exemption.

The tool cannot enable or disable auto mode, reload configuration, reset state, select a model, or edit configuration. The user must run the related `/automode` command directly.

## Status fields

| Field | Meaning |
| --- | --- |
| `state.lastDecisionKind` | Enforcement path of the last decision: the `kind` values in [observability logging](observability-logging.md#decision). |
| `enabledSource` | Where the effective enabled state came from: `default`, `global`, `project-local`, or `inline` (the config scope that set `autoMode.enabled`); `override` (`/automode on\|off` in this session); or `parent` (a subagent following its parent's `/automode on\|off`). |
| `agent` | `{ kind, id, name, depth }` from the host. OMP reports it. Pi reports none, so the field is absent. |
| `hasUI` | Whether this session has an interactive UI. A headless session blocks `permissions.ask` matches. |
| `state.recentClassifierErrors` | The last 12 fail-closed classifier failures, newest first: `{ kind, stage, timestamp, model, retryAfterMs? }`. Kinds are `rate-limit`, `timeout`, `auth`, `server`, `aborted`, `invalid-response`, `context-limit`, and `no-classifier`. |

## Model-visible data

Pi sends tool output to the current model. The output has deliberate privacy limits:

- `status` includes the kind of the last decision (for example `classifier` or `deterministic-hard-deny`), but not its reason.
- `status` lists recent classifier errors as a typed `kind`, `stage`, `timestamp`, `model`, and `retryAfterMs` when the provider gave one. It never includes the provider's error text or payloads.
- `denials` does not include denial reasons or action payloads.
- `config` removes configuration-parser details from invalid JSON diagnostics.

The `config` view returns effective rule text. Do not put credentials, tokens, private keys, signed URLs, or other secrets in pi-automode rules or configuration.

The tool serializes output defensively. Arrays longer than 30 entries become an object with these fields:

```json
{
  "$truncatedArray": true,
  "items": ["first entries"],
  "omittedEntries": 18,
  "totalEntries": 48
}
```

String values and the complete serialized result also have size limits. Treat a truncated result as incomplete. An omitted rule can still exist.

## Observability log path

Use the `config` view to get the log path and the selected config files (`configSources`) for the current session. Its `logFile` value uses the same resolution as observability logging:

- A persisted session uses a sidecar beside its Pi session file.
- An in-memory session uses the application-owned log directory for the effective session working directory.

For in-memory sessions, pi-automode uses this default location:

```text
~/.pi/agent/extensions/pi-automode/logs/<encoded-session-cwd>/YYYY-MM-DD/<session-id>-pi-automode.jsonl
```

Under OMP, the root is `<agentDir>/automode/logs/` instead.

This includes `--no-session` runs and non-persisted subagents. The path does not use the launching process working directory.

See [Observability logging](observability-logging.md) for log configuration and entry schemas.

## Classifier protocol failures

When classifier I/O logging is active, a detailed-stage tool call appears in `attempts[].response.toolCalls`. The field contains each tool name and argument object.

The field does not contain provider call IDs or hidden reasoning. Use it to distinguish a missing tool call from invalid tool arguments.

## Diagnosis workflow

Classifier rules cannot override permission or deterministic denials.

1. Call `automode_inspect` with `status`, `config`, and `denials`.
2. If observability logging is enabled, use the reported log path.
3. Read a matching decision entry before you propose a rule change.
4. Identify the enforcement layer before you change a rule.
5. If a configuration change is necessary, explain the change.
6. Ask the user to run `/automode off`.
7. Make only the requested configuration change during that maintenance window.
8. Ask the user to run `/automode reload` and `/automode on`.
9. Use `automode_inspect` to make sure that auto mode is enabled.
10. Retry only an action that you know is safe.

Do not replay an unsafe action because auto mode is off. Do not print sensitive tool input or log content in a diagnosis report.
