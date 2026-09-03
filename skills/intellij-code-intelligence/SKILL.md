---
name: intellij-code-intelligence
description: Use ijctl's IntelliJ-backed semantic search, call hierarchy, inspections, project model, dependency, and rename workflows for one explicitly targeted project or worktree.
---

Use this skill after `intellij-mcp-tools` has selected the project/server and
loaded the live catalog. Prefix every command with the same `--project` and
`--server` values.

## Read-only analysis

Prefer the stable aliases:

```sh
ijctl --project PROJECT --server SERVER search symbol QUERY
ijctl --project PROJECT --server SERVER analyze calls FQN --kind incoming
ijctl --project PROJECT --server SERVER analyze problems src/file.ts
ijctl --project PROJECT --server SERVER analyze modules
ijctl --project PROJECT --server SERVER analyze dependencies
```

Use `search symbol` before call analysis when the fully qualified callable is
unknown. Use project-relative path filters and page or narrow results instead of
requesting an unbounded search. Inspection output reflects IntelliJ's current
indexes and enabled inspections.

## Refactoring

`refactor rename` is a workspace write:

```sh
ijctl --project PROJECT --server SERVER refactor rename PATH SYMBOL NEW_NAME
```

Run it only when the user explicitly authorized that exact rename and target.
Inspect the working-tree diff afterward. Do not broaden a requested rename into
formatting or cleanup.

## Generic fallback

If an alias reports `TOOL_NOT_FOUND` or `TOOL_SCHEMA_CHANGED`, run `tools` and
`describe` and use `call` only with the live schema. Do not invent argument
names or retry a possibly delivered mutation.
