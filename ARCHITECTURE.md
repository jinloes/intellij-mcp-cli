# Architecture

## Purpose

`ijctl` adapts IntelliJ IDEA's MCP server to a shell-friendly JSON CLI. It keeps
coding agents independent of IntelliJ's changing tool schemas by discovering
tools at runtime rather than embedding IDE-specific operations.

The CLI exposes MCP tools only. MCP resources, prompts, sampling, elicitation,
and OAuth are outside the current scope.

The repository has two independently installed parts:

- The npm CLI provides the `ijctl` executable.
- The Copilot plugin provides instructions for using that executable.

Installing the plugin does not install or configure the CLI.

## System context

```text
Coding agent or shell
        |
        | argv / stdin
        v
      ijctl
        |
        | MCP over stdio, Streamable HTTP, or legacy SSE
        v
IntelliJ IDEA MCP server
        |
        v
Open IntelliJ project model and IDE capabilities
```

## Component boundaries

```text
+-------------------------------------------------------------+
| src/cli.ts                                                  |
| Dependency-free bin: enforce Node.js 20+                    |
+-----------------------------+-------------------------------+
                              | dynamic import
                              v
+-------------------------------------------------------------+
| src/cli-main.ts                                             |
| Commands, orchestration, connection lifecycle, exit status  |
+--------------+-----------------+-----------------+----------+
               |                 |                 |
               v                 v                 v
        src/config.ts      src/input.ts       src/output.ts
               |
               v
          src/mcp.ts ----------------> MCP SDK / IntelliJ

Shared failure representation: src/errors.ts
Runtime policy: src/node-version.ts
```

The startup split is intentional. `src/cli.ts` must not eagerly import the MCP
SDK because its dependencies require Web Platform globals unavailable on older
Node versions.

## Startup flow

1. The executable declared by `package.json#bin` starts `dist/cli.js`.
2. The launcher checks `process.versions.node` using `src/node-version.ts`.
3. Node.js below 20 receives a single JSON error on stderr and exit status 1.
4. Supported runtimes dynamically import `src/cli-main.ts`.
5. Commander parses global options and dispatches a subcommand.

Volta users entering this repository automatically select Node.js 20.20.2.
The launcher remains necessary because a linked or installed `ijctl` can be
invoked from a directory with a different runtime selection.

## Configuration resolution

For configured servers, the config file precedence is:

1. `--config <path>`
2. `IJCTL_CONFIG`
3. `./ijctl.config.json`
4. `~/.config/ijctl/config.json`

`--url` bypasses config-file loading and cannot be combined with `--config` or
`--server`.

Within a config file, server selection is:

1. `--server <name>`
2. A server named `intellij`
3. The only configured server
4. An explicit selection error

`src/config.ts` validates configuration with Zod, interpolates `${VARIABLE}`
references, resolves relative `cwd` values from the config file's directory,
and normalizes transport aliases.

## Transport boundary

`src/mcp.ts` owns all MCP SDK interaction:

| Transport       | Input                                        | Behavior                                                                       |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| stdio           | `command`, optional `args`, `env`, and `cwd` | Spawns the IntelliJ-provided MCP command and exchanges line-delimited messages |
| Streamable HTTP | `url`, optional headers                      | Uses `StreamableHTTPClientTransport`                                           |
| Legacy SSE      | `url` ending in `/sse` or explicit `sse`     | Uses `SSEClientTransport`; custom headers are rejected                         |

Transport inference defaults HTTP URLs to Streamable HTTP unless their path
ends in `/sse`. Users can override the transport explicitly.

## Command execution flow

All MCP-backed commands use the same lifecycle:

1. Resolve the configured server.
2. Construct the MCP client and selected transport.
3. Connect with the global timeout.
4. Execute command-specific MCP requests.
5. Serialize one JSON result.
6. Close the MCP client in a `finally` block.

Command behavior:

| Command           | MCP operation                  | Output                                                                        |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `doctor`          | Connect and list tools         | Server metadata, negotiated protocol, capabilities, transport, and tool count |
| `tools`           | `tools/list`                   | Compact tool metadata or full schemas                                         |
| `describe <tool>` | `tools/list` plus local lookup | Full schema for one tool                                                      |
| `call <tool>`     | `tools/call`                   | Complete MCP tool result                                                      |

Tool arguments come from inline JSON, a file, stdin, or an empty object.

## Output and exit contract

| Condition                                            | Stream                 | Exit status                               |
| ---------------------------------------------------- | ---------------------- | ----------------------------------------- |
| Successful command                                   | JSON on stdout         | 0                                         |
| MCP result with `isError: true`                      | JSON on stdout         | 2                                         |
| Unsupported Node.js runtime                          | JSON on stderr         | 1                                         |
| Configuration, input, connection, or request failure | JSON on stderr         | 1 unless a `CliError` specifies otherwise |
| Commander help or version                            | Commander output       | 0                                         |
| Commander usage error                                | Commander error output | Nonzero                                   |

`IJCTL_DEBUG=1` adds stack information to caught operational error JSON.

## Build and test architecture

- `npm run build` compiles `src/` to ESM in `dist/`.
- `postbuild` marks the package bin executable.
- `npm test` removes prior build outputs, builds the production bin, compiles
  tests to `dist-test/`, and runs `node:test`.
- Integration tests read the bin target from `package.json` and execute that
  production file.
- A mock stdio MCP server makes end-to-end tests independent of IntelliJ.
- The suite simulates Node 16 before importing the production bin to verify the
  runtime gate without requiring an obsolete Node installation.

## Distribution architecture

`plugin.json` makes the repository directly installable with
`copilot plugin install jinloes/intellij-mcp-cli`. Its `skills` field points to
the existing `skills/` directory, where `intellij-mcp-tools/SKILL.md` defines
the capability loaded by Copilot.

The plugin name and npm package name differ intentionally:

- `intellij-mcp-tools` identifies the Copilot plugin and skill.
- `intellij-mcp-cli` identifies the npm package that supplies `ijctl`.

Their versions remain aligned so a repository revision describes one compatible
CLI-and-skill release.

## Trust and security boundaries

- MCP configuration and tool results are untrusted input.
- URLs may use only HTTP or HTTPS and cannot contain embedded credentials.
- Environment placeholders fail when their variables are missing.
- Stdio commands originate from the user's IntelliJ-generated configuration;
  `ijctl` does not invent or shell-expand them.
- Tool schemas and behavior come from the connected IntelliJ instance and may
  change between IDE versions.
- Agents must inspect live schemas before invoking unfamiliar tools and require
  user authorization for side-effecting IDE operations.
