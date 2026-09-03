# Code Mapping

This document maps repository files to runtime responsibilities and features.
Update it in the same change whenever modules or their responsibilities change.

## Runtime dependency map

```text
src/cli.ts
  -> src/node-version.ts
  -> dynamically imports src/cli-main.ts on Node.js 20+

src/cli-main.ts
  -> src/config.ts
  -> src/daemon.ts
  -> src/errors.ts
  -> src/input.ts
  -> src/mcp.ts
  -> src/output.ts
  -> src/skills.ts
  -> src/tool-metadata.ts
  -> src/version.ts

src/config.ts -> src/errors.ts, zod
src/daemon.ts -> src/config.ts, src/errors.ts, src/mcp.ts
src/input.ts  -> src/errors.ts
src/mcp.ts    -> src/config.ts, src/errors.ts, src/version.ts, @modelcontextprotocol/client
src/skills.ts -> src/errors.ts, src/version.ts
src/tool-metadata.ts -> src/errors.ts, @modelcontextprotocol/client
```

## Source modules

| File                   | Responsibility                                                                                                         | Key exports or behavior                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`           | Package bin and dependency-free startup gate                                                                           | Rejects Node.js below 20 with a JSON error, then dynamically loads the command implementation               |
| `src/node-version.ts`  | Runtime compatibility policy                                                                                           | `MINIMUM_NODE_MAJOR`, `isSupportedNodeVersion`                                                              |
| `src/cli-main.ts`      | Commander program, commands, aliases, orchestration, and process exit handling                                         | Project targeting, instances, discovery, curated aliases, skill lifecycle, daemon lifecycle, JSON responses |
| `src/config.ts`        | Config validation, project context, sanitized instance discovery, project-aware selection, and transport normalization | `resolveProjectContext`, `loadConfiguredInstances`, `resolveServer`, parsing and server config types        |
| `src/daemon.ts`        | Persistent MCP connection daemon and authenticated loopback client                                                     | Per-target identity, lossless coded errors, private state, lifecycle, idle shutdown, and request forwarding |
| `src/mcp.ts`           | MCP client and transport adapter                                                                                       | Creates stdio, Streamable HTTP, or legacy SSE transports; connects, describes, lists, and calls             |
| `src/input.ts`         | Tool argument and text loading and validation                                                                          | Reads JSON arguments or SQL text from inline values, files, or stdin                                        |
| `src/output.ts`        | Machine-readable additive output envelopes                                                                             | JSON writing plus stable command timing and error helpers                                                   |
| `src/errors.ts`        | Stable CLI error model and unknown-error formatting                                                                    | Coded `CliError`, retryability, structured details, and serialization                                       |
| `src/skills.ts`        | Bundled skill discovery and safe installation lifecycle                                                                | User/project scopes, subset/all selection, dry-run, ownership markers, symlink guards, atomic replacement   |
| `src/tool-metadata.ts` | Deterministic tool catalog, safety policy, and alias contracts                                                         | Filtering, paging, safety classes/warnings, counts, and live alias validation                               |
| `src/version.ts`       | Runtime compatibility release                                                                                          | Shared `VERSION` for Commander, MCP client, and skill ownership markers                                     |

## Test modules

| File                               | Coverage                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/project.test.ts`             | Node compatibility, manifests, production-bin startup, configuration, direct stdio commands, and persistent daemon lifecycle and reuse |
| `test/interaction-model.test.ts`   | Project targeting, instances/probing, catalogs, aliases, envelopes/errors, safety warnings, and skill filesystem lifecycle             |
| `test/fixtures/mock-mcp-server.ts` | Deterministic annotated alias tools, tool/request failures, delay, argument echoing, and process-start counting                        |

Tests compile to `dist-test/`, but process-level CLI assertions execute the
production bin path from `package.json`.

## Build and repository files

| File                                         | Responsibility                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `package.json`                               | Package metadata, `ijctl` bin mapping, Node engine/Volta pin, dependencies, and build/test scripts |
| `plugin.json`                                | Copilot CLI plugin metadata and the canonical `skills/` component path                             |
| `.github/plugin/marketplace.json`            | Self-hosted `jinloes-plugins` marketplace catalog and installable Copilot CLI plugin entry         |
| `package-lock.json`                          | Reproducible npm dependency graph                                                                  |
| `tsconfig.json`                              | Strict production TypeScript build from `src/` to `dist/`                                          |
| `tsconfig.test.json`                         | Test compilation from `src/` and `test/` to `dist-test/`                                           |
| `README.md`                                  | Installation, configuration, usage, and supported feature contract                                 |
| `ARCHITECTURE.md`                            | System design, boundaries, and end-to-end flows                                                    |
| `AGENTS.md`                                  | Repository-wide implementation and documentation rules                                             |
| `skills/intellij-mcp-tools/SKILL.md`         | Setup/router skill for target selection, daemon/catalog establishment, and focused-skill routing   |
| `skills/intellij-code-intelligence/SKILL.md` | Semantic analysis, inspection, project model, and guarded refactoring workflows                    |
| `skills/intellij-run-debug/SKILL.md`         | Build, run configuration, terminal, and guarded debugger workflows                                 |
| `skills/intellij-database/SKILL.md`          | Read-first connection/schema/SQL workflows and explicit database mutation safeguards               |

## Feature-to-code index

| Feature                                    | Primary implementation                                                                 | Tests                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Node.js minimum-version enforcement        | `src/cli.ts`, `src/node-version.ts`, `package.json`                                    | `test/project.test.ts`                                     |
| Copilot plugin distribution                | `.github/plugin/marketplace.json`, `plugin.json`, `skills/intellij-mcp-tools/SKILL.md` | Manifest alignment in `test/project.test.ts`               |
| CLI command definitions and exit codes     | `src/cli-main.ts`                                                                      | `test/project.test.ts`                                     |
| Configuration precedence and parsing       | `src/config.ts`                                                                        | `test/project.test.ts`                                     |
| Environment interpolation                  | `src/config.ts`                                                                        | `test/project.test.ts`                                     |
| Tool argument JSON/file/stdin input        | `src/input.ts`                                                                         | No focused test yet                                        |
| Stdio MCP transport                        | `src/mcp.ts`                                                                           | `test/project.test.ts`, `test/fixtures/mock-mcp-server.ts` |
| Streamable HTTP transport                  | `src/mcp.ts`                                                                           | No runtime fixture yet                                     |
| Legacy SSE transport                       | `src/config.ts`, `src/mcp.ts`                                                          | Inference test only; no runtime fixture yet                |
| Tool discovery and schema description      | `src/cli-main.ts`, `src/mcp.ts`                                                        | `test/project.test.ts`                                     |
| Tool invocation and tool-level errors      | `src/cli-main.ts`, `src/mcp.ts`                                                        | `test/project.test.ts`                                     |
| Persistent MCP connection reuse            | `src/cli-main.ts`, `src/daemon.ts`, `src/mcp.ts`                                       | `test/project.test.ts`, `test/fixtures/mock-mcp-server.ts` |
| Project targeting and configured instances | `src/config.ts`, `src/cli-main.ts`                                                     | `test/interaction-model.test.ts`                           |
| Catalog filtering, paging, and safety      | `src/tool-metadata.ts`, `src/cli-main.ts`                                              | `test/interaction-model.test.ts`                           |
| Curated IntelliJ workflow aliases          | `src/tool-metadata.ts`, `src/cli-main.ts`                                              | `test/interaction-model.test.ts`, mock fixture             |
| Bundled skill installation lifecycle       | `src/skills.ts`, `src/cli-main.ts`, `skills/*/SKILL.md`                                | `test/interaction-model.test.ts`                           |
| Additive timed JSON/error envelopes        | `src/errors.ts`, `src/output.ts`, `src/cli-main.ts`, `src/daemon.ts`                   | Both production-bin test files                             |
