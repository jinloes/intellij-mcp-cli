---
name: intellij-run-debug
description: Use ijctl for IntelliJ builds and run configurations, with explicit authorization gates for execution, terminal operations, and stateful debugger actions.
---

Use this skill after `intellij-mcp-tools` has fixed the `--project` and
`--server` target. Keep those values on every command.

## Build and run

Discover before executing:

```sh
ijctl --project PROJECT --server SERVER run list
ijctl --project PROJECT --server SERVER run list --file src/file.ts
```

Builds and launches can execute code. Require authorization for the intended
build or run, then use:

```sh
ijctl --project PROJECT --server SERVER build
ijctl --project PROJECT --server SERVER run execute --configuration NAME
ijctl --project PROJECT --server SERVER run execute --file PATH --line LINE
```

Pass launch-only environment, arguments, working directory, timeout, or
`--wait-for-exit` only when needed. Never add hidden credentials.

## Debugger and terminal fallback

Debugger and terminal tools are intentionally not wrapped. Find the exact live
tool with `tools --query`, inspect it with `describe`, and use generic `call`
only after the user authorizes the state change or command. Do not start,
resume, step, terminate, or alter breakpoints merely because a tool is
available.

Treat `execution`, `debug-state`, and `unknown` warnings as side-effect signals.
Never automatically retry an operation that may already have reached IntelliJ.
