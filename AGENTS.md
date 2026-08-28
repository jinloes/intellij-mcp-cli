# Repository Agent Guide

This file applies to the entire repository.

## Project overview

`ijctl` is a TypeScript command-line client for IntelliJ IDEA's MCP server. It
turns MCP tool discovery and invocation into deterministic JSON commands for
shells and coding agents.

Read these documents before changing behavior or module boundaries:

- [CODE_MAPPING.md](CODE_MAPPING.md) maps features and files.
- [ARCHITECTURE.md](ARCHITECTURE.md) describes runtime flows and design
  constraints.
- [README.md](README.md) defines the user-facing contract.

## Toolchain

- Node.js 20 or newer is required.
- Volta is pinned to Node.js 20.20.2 in `package.json`.
- The project uses npm, ESM, TypeScript strict mode, Prettier, and `node:test`.
- Run `npm run check` before handing off a code change.

Useful focused commands:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
```

Do not commit generated `dist/`, `dist-test/`, local `ijctl.config.json`, or
`node_modules/`.

## Architecture constraints

- Keep `src/cli.ts` dependency-free except for local modules that are safe on
  unsupported Node versions. It must reject Node.js below 20 before importing
  third-party packages.
- Keep command definitions and orchestration in `src/cli-main.ts`.
- Keep configuration parsing and selection in `src/config.ts`; do not duplicate
  precedence or transport normalization in command handlers.
- Keep MCP SDK and transport details in `src/mcp.ts`.
- Keep `plugin.json`, `package.json`, and the plugin entry in
  `.github/plugin/marketplace.json` version-aligned. The Copilot plugin
  distributes the skill but does not install the npm CLI.
- Preserve the output contract: successful and tool-level results go to stdout;
  operational errors go to stderr; MCP tool errors exit with status 2.
- Close direct MCP clients in all command success and failure paths. Daemon-owned
  clients may persist between commands but must close on idle, explicit stop,
  transport failure, or process shutdown.
- Do not embed credentials in MCP URLs. Use supported header configuration for
  Streamable HTTP; legacy SSE does not support custom headers.

## Testing expectations

- Add or update tests for every behavior change.
- Integration tests must execute the production bin declared by
  `package.json#bin`, not a separately compiled CLI copy.
- Keep tests deterministic and independent of a locally running IntelliJ
  instance.
- Use the stdio mock server for end-to-end command behavior.
- Test exit status, stdout, and stderr whenever changing CLI error handling.

## Documentation synchronization

Documentation changes are part of the code change, not follow-up work:

- Update `CODE_MAPPING.md` whenever a source/test file is added, removed,
  renamed, or changes responsibility, public symbols, or important dependencies.
- Update `ARCHITECTURE.md` whenever component boundaries, startup, configuration
  precedence, transports, request flow, security boundaries, output semantics,
  or build/test architecture changes.
- Update `README.md` whenever installation, configuration, commands, supported
  behavior, or user-visible output changes.
- Update `plugin.json` and `.github/plugin/marketplace.json` whenever plugin
  metadata, versions, or component paths change.
- Update this file when contributor workflow or repository-wide constraints
  change.

The test suite verifies that every `src/*.ts` module appears in
`CODE_MAPPING.md`. Architectural accuracy still requires reviewer judgment.
