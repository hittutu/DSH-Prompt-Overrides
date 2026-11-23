# DSH Prompt Overrides

A small Cordis plugin for DeepSeek Harness that lets you rewrite model-visible prompt wording from one editable JSON file, without patching DSH Base or changing policy enforcement.

## What it changes

- `tool:read`
- `working-directory:current`
- `sandbox:policy`
- `approval:policy`
- `subagent:identity`
- `harness:source`
- `app:web-surface`
- `time-context`

It also supports optional `extraSections` and `extraContexts`.

## Important implementation detail

The four runtime contexts (`working-directory:current`, `sandbox:policy`, `approval:policy`, `subagent:identity`) are registered as **per-Agent scoped providers** through `agent.ctx.systemPrompt.context()`. This is intentional: DSH refreshes registered runtime-context providers after the `system-prompt/assemble` presentation waterfall. Editing an assembled context snapshot alone can therefore be overwritten by the original provider.

Ordinary system sections are transformed through `system-prompt/assemble` using cloned objects. No original/frozen object is mutated.

`time-context` is a durable user-role snapshot added by DSH's `agent/pre-step` listener. This plugin installs a per-Agent prepended wrapper during `agent/created`, so the wrapper can inspect the downstream decision after the time-context provider has appended a new snapshot. It clones the message, content block, and source sections rather than mutating them.

Historical time-context messages already committed to a Session are not rewritten. Only newly generated snapshots are transformed. The stock time-context plugin defaults to a 10-minute refresh interval, so a test performed shortly after a previous injection may not create a new snapshot to transform.

## Install from GitHub

Publish this directory as the root of a GitHub repository, then install it with DSH:

```bash
dsh plugin --profile <profile-name> add github:<owner>/<repo>#<commit-sha>
```

Pinning a commit is recommended for reproducible installs.

## Editable configuration

On first activation the plugin creates `prompt-overrides.json` in the active DSH profile directory (or the configured absolute `configFile` path).

Edit that file; the plugin checks its modification time and reloads valid JSON on the next prompt assembly / runtime-context render. The installed package's default JSON is only a seed and is not copied over an existing user file during upgrades.

If the JSON becomes invalid, the plugin keeps the last successfully parsed configuration. If no valid configuration has ever been loaded, it fails open and leaves original wording unchanged.

## Template variables

Templates use `{{variable}}` placeholders. Available values depend on the item:

- `working-directory:current`: `cwd`
- `sandbox:policy`: `policy`, `workspaceRoot`, `additionalWritableRoots`
- `approval:policy`: `approvalMode`
- `subagent:identity`: `agentRole`, `agentName`, `parentAgentName`, `rootAgentName`, `communicationHelp`
- `harness:source`: `sourceRoot`
- `app:web-surface`: `webUrl`
- `time-context`: `turn`, `step`, `timestamp`, `browserContext`, `baseline`, `baselineZh`, `elapsed`

For `sandbox:policy` and `approval:policy`, the `variants` key is selected from the actual active policy. Keep the wording truthful: this plugin changes what the model reads, not the sandbox or approval services that enforce actions.

## Safety properties

- Does not edit DSH Base files.
- Does not mutate `decision.messages`, `message.content`, source sections, or prompt section/context objects.
- Uses Agent-scoped registrations for runtime contexts, preserving their original `required` flags.
- Keeps actual sandbox and approval enforcement unchanged.
- Removes its Agent-scoped registrations when the plugin unloads; registrations are also owned by the Agent scope and unwind on Agent disposal.
- Does not rewrite existing Session history.
- Keeps the last valid JSON configuration if the editable file is temporarily malformed.

## Test

```bash
npm test
```

The included tests use frozen objects and mocked Cordis contexts. They verify the transformation logic and registration contracts; they are not a live test against a user's DSH process. A first live smoke test should use a fresh test session.
