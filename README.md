# dsh-prompt-overrides

A small DeepSeek Harness bundle for **safe, hot-reloadable wording overrides**.

It is deliberately boring:

- it does **not** patch DeepSeek Harness source files;
- it does **not** mutate DSH-owned/frozen message objects;
- it does **not** regex-rewrite the entire final prompt;
- it does **not** replace execution policy (sandbox / approval); it only changes the model-visible wording;
- all editable wording lives in one profile-local JSON file.

The bundle targets these prompt/context names:

1. `tool:read`
2. `working-directory:current`
3. `sandbox:policy`
4. `approval:policy`
5. `subagent:identity`
6. `harness:source`
7. `app:web-surface`
8. `time-context`

It also supports optional `extraSections` and `extraContexts` for your own instructions.

## Why this implementation is safe

Items 1–7 are transformed through DSH's documented `system-prompt/assemble` waterfall. The plugin calls `next()` first, then returns a **new presentation** containing cloned replacement objects. It never does `section.text = ...` or `message.content[0].text = ...` on framework-owned objects.

`time-context` is different: the shipped plugin appends it as a durable user-role snapshot during `agent/pre-step`. This bundle delegates first, recognizes only messages whose source is exactly `time-context`, and returns a new decision/message/content/source tree.

If `prompt-overrides.json` temporarily contains invalid JSON, the plugin keeps the **last known good configuration**. If no valid configuration has ever loaded, it falls back to disabled/no-op behavior instead of breaking DSH.

## Install from GitHub

Put the files in this repository at the repo root, then install the repository into the DSH profile you actually use.

CLI example:

```bash
dsh plugin --profile <your-profile> add github:<your-user>/<your-repo>#<commit>
```

Pinning a commit is recommended.

This package is plain JavaScript and has no build/`prepare` step, so a GitHub install does not need a source-build stage.

You can also use the DSH Plugin Manager UI and choose **Install a third-party plugin**, then provide the Git repository.

## Editable file

On first load the plugin creates:

```text
<DSH profile directory>/prompt-overrides.json
```

The startup log prints the exact path:

```text
[dsh-prompt-overrides] editable prompt file: ...
```

Edit that JSON file, save it, and the plugin reloads it on the next prompt assembly / pre-step when the file mtime changes. No source edit is needed, and updating the GitHub plugin will not overwrite the profile-local file.

> JSON has no comments and no trailing commas.

## Template variables

Every override can use `{{original}}`.

Known names also expose:

| Name | Variables |
|---|---|
| `working-directory:current` | `{{cwd}}` |
| `sandbox:policy` | `{{policy}}` |
| `approval:policy` | `{{approvalMode}}` (`ask` / `never`) |
| `subagent:identity` | `{{agentRole}}`, `{{agentName}}`, `{{communicationHelp}}` |
| `harness:source` | `{{sourceRoot}}` |
| `app:web-surface` | `{{webUrl}}` |
| `time-context` | `{{turn}}`, `{{step}}`, `{{timestamp}}`, `{{browserContext}}`, `{{baseline}}`, `{{baselineZh}}`, `{{elapsed}}`, `{{original}}` |

Unknown placeholders are left literally in the result. Overridden DSH sections/contexts are returned with `interpolate: false`, so those literals will not accidentally become DSH prompt-variable references.

## Variants

An entry may use `variants` instead of one `text` string.

The default config uses variants for:

- `sandbox:policy`: selected by the actual policy name such as `danger-full-access`;
- `approval:policy`: selected as `ask` or `never`.

Always include a `default` variant if you want graceful behavior for future DSH values.

## Extra instructions

The default JSON includes a disabled example section named:

```text
custom:dsh-construction-manual
```

Flip its `enabled` field to `true` if you want the ten-step construction rules injected as an ordinary system-prompt section.

You may add more entries to `extraSections` or `extraContexts`. Existing names are not silently replaced by the `extra*` lists; duplicate names are skipped with a warning. Use `overrides` for existing DSH names.

## Recovery / disable

The normal uninstall path is:

```bash
dsh plugin --profile <your-profile> remove dsh-prompt-overrides
```

If you only want to stop wording changes, set the profile-local JSON to:

```json
{
  "version": 1,
  "enabled": false,
  "overrides": {},
  "extraSections": [],
  "extraContexts": []
}
```

Because parse failures retain the last good configuration, intentionally breaking the JSON is **not** a disable mechanism.

## Self-test

From a checkout of this repository:

```bash
npm test
```

The test deep-freezes representative prompt presentations and `time-context` messages, then verifies that all replacements happen by cloning rather than mutation.

## Important semantic boundary

This plugin changes **model-visible wording only**.

For example, replacing the prose of `sandbox:policy` does not change the real sandbox policy, and replacing the prose of `approval:policy` does not change whether approvals are enabled. Keep your wording truthful to the actual runtime state.
