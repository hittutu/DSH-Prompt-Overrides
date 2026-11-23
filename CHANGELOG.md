# Changelog

## 0.1.1

- Fixes runtime-context overrides by registering scoped providers through each `agent.ctx.systemPrompt.context()`.
- Preserves the original `required` flags for all four runtime contexts.
- Moves the time-context wrapper into each Agent scope and registers it during `agent/created`, after the stock time-context listener has mounted.
- Keeps immutable cloning for prompt sections and newly generated time-context snapshots.
- Adds cleanup for scoped registrations when this plugin unloads.
- Clarifies that old Session history is not rewritten and the stock time-context provider may wait up to its configured refresh interval (10 minutes by default) before emitting a new snapshot.
