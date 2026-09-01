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

src/config.ts -> src/errors.ts, zod
src/daemon.ts -> src/config.ts, src/errors.ts, src/mcp.ts
src/input.ts  -> src/errors.ts
src/mcp.ts    -> src/config.ts, src/errors.ts, @modelcontextprotocol/client
```

## Source modules

| File                  | Responsibility                                                                                                   | Key exports or behavior                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`          | Package bin and dependency-free startup gate                                                                     | Rejects Node.js below 20 with a JSON error, then dynamically loads the command implementation               |
| `src/node-version.ts` | Runtime compatibility policy                                                                                     | `MINIMUM_NODE_MAJOR`, `isSupportedNodeVersion`                                                              |
| `src/cli-main.ts`     | Commander program, commands, orchestration, and process exit handling                                            | Direct or daemon-backed `doctor`, `tools`, `describe`, and `call`; daemon lifecycle; JSON responses         |
| `src/config.ts`       | Config validation, environment interpolation, file discovery, server selection, and HTTP transport normalization | `parseConfigText`, `findConfigPath`, `loadConfig`, `selectServer`, `resolveServer`, and server config types |
| `src/daemon.ts`       | Persistent MCP connection daemon and authenticated loopback client                                               | Per-server identity, private state, list/start/status/stop lifecycle, idle shutdown, and request forwarding |
| `src/mcp.ts`          | MCP client and transport adapter                                                                                 | Creates stdio, Streamable HTTP, or legacy SSE transports; connects, describes, lists, and calls             |
| `src/input.ts`        | Tool argument loading and validation                                                                             | Reads `--args-json`, files, or stdin and requires a JSON object                                             |
| `src/output.ts`       | Machine-readable output                                                                                          | Writes compact or pretty JSON followed by a newline                                                         |
| `src/errors.ts`       | CLI error model and unknown-error formatting                                                                     | `CliError`, `errorMessage`                                                                                  |

## Test modules

| File                               | Coverage                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/project.test.ts`             | Node compatibility, manifests, production-bin startup, configuration, direct stdio commands, and persistent daemon lifecycle and reuse |
| `test/fixtures/mock-mcp-server.ts` | Line-delimited JSON-RPC MCP fixture exposing tool success, delay, failure, and process-start counting                                  |

Tests compile to `dist-test/`, but process-level CLI assertions execute the
production bin path from `package.json`.

## Build and repository files

| File                                 | Responsibility                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `package.json`                       | Package metadata, `ijctl` bin mapping, Node engine/Volta pin, dependencies, and build/test scripts |
| `plugin.json`                        | Copilot plugin metadata and the `skills/` component path used by direct repository installation    |
| `.github/plugin/marketplace.json`    | Self-hosted `jinloes-plugins` marketplace catalog and installable plugin entry                     |
| `package-lock.json`                  | Reproducible npm dependency graph                                                                  |
| `tsconfig.json`                      | Strict production TypeScript build from `src/` to `dist/`                                          |
| `tsconfig.test.json`                 | Test compilation from `src/` and `test/` to `dist-test/`                                           |
| `README.md`                          | Installation, configuration, usage, and supported feature contract                                 |
| `ARCHITECTURE.md`                    | System design, boundaries, and end-to-end flows                                                    |
| `AGENTS.md`                          | Repository-wide implementation and documentation rules                                             |
| `skills/intellij-mcp-tools/SKILL.md` | Copilot instructions for safe, observable, progressive use of `ijctl`                              |

## Feature-to-code index

| Feature                                | Primary implementation                                                                 | Tests                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Node.js minimum-version enforcement    | `src/cli.ts`, `src/node-version.ts`, `package.json`                                    | `test/project.test.ts`                                     |
| Copilot plugin distribution            | `.github/plugin/marketplace.json`, `plugin.json`, `skills/intellij-mcp-tools/SKILL.md` | Manifest alignment in `test/project.test.ts`               |
| CLI command definitions and exit codes | `src/cli-main.ts`                                                                      | `test/project.test.ts`                                     |
| Configuration precedence and parsing   | `src/config.ts`                                                                        | `test/project.test.ts`                                     |
| Environment interpolation              | `src/config.ts`                                                                        | `test/project.test.ts`                                     |
| Tool argument JSON/file/stdin input    | `src/input.ts`                                                                         | No focused test yet                                        |
| Stdio MCP transport                    | `src/mcp.ts`                                                                           | `test/project.test.ts`, `test/fixtures/mock-mcp-server.ts` |
| Streamable HTTP transport              | `src/mcp.ts`                                                                           | No runtime fixture yet                                     |
| Legacy SSE transport                   | `src/config.ts`, `src/mcp.ts`                                                          | Inference test only; no runtime fixture yet                |
| Tool discovery and schema description  | `src/cli-main.ts`, `src/mcp.ts`                                                        | `test/project.test.ts`                                     |
| Tool invocation and tool-level errors  | `src/cli-main.ts`, `src/mcp.ts`                                                        | `test/project.test.ts`                                     |
| Persistent MCP connection reuse        | `src/cli-main.ts`, `src/daemon.ts`, `src/mcp.ts`                                       | `test/project.test.ts`, `test/fixtures/mock-mcp-server.ts` |
| JSON output formatting                 | `src/output.ts`, `src/cli-main.ts`                                                     | Covered through CLI integration assertions                 |
