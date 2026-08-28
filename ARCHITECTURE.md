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
   ijctl command
        | \
        |  \ authenticated loopback request
        |   v
        |  ijctl daemon (optional persistent MCP client)
        |   |
        +---+
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
| Commands, backend selection, lifecycle, and exit status     |
+--------------+-----------------+-----------------+----------+
               |                 |                 |
               v                 v                 v
        src/config.ts      src/input.ts       src/output.ts
               |
               +-----------> src/daemon.ts
               |                    |
               +-----------> src/mcp.ts ------> MCP SDK / IntelliJ

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

Every MCP-backed command resolves the configured server first. Unless
`--no-daemon` is present, it then checks for a daemon whose identity matches the
fully resolved server configuration:

1. If the daemon is reachable, send one authenticated loopback request over its
   existing MCP connection.
2. If no daemon is running and the request was not delivered, construct a direct
   MCP client, connect, execute the command, and close it in a `finally` block.
3. If communication fails after a daemon request may have been delivered, report
   the failure without retrying directly; retrying could duplicate a
   side-effecting tool call.
4. Serialize one JSON result with `connectionMode` set to `daemon` or `direct`.

Command behavior:

| Command           | MCP operation                  | Output                                                                        |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `doctor`          | Connect and list tools         | Server metadata, negotiated protocol, capabilities, transport, and tool count |
| `tools`           | `tools/list`                   | Compact tool metadata or full schemas                                         |
| `describe <tool>` | `tools/list` plus local lookup | Full schema for one tool                                                      |
| `call <tool>`     | `tools/call`                   | Complete MCP tool result                                                      |

Tool arguments come from inline JSON, a file, stdin, or an empty object.

## Persistent connection daemon

`ijctl daemon start` launches a detached process that owns one MCP client and
reuses it across separate CLI invocations. Starting is idempotent for the same
resolved server; `daemon status` inspects it and `daemon stop` closes it. Normal
MCP-backed commands use a running daemon automatically but never start one
implicitly. `daemon list` and `daemon stop --all` scan the private runtime
directory without resolving the current config, so daemons remain manageable
after their source configuration changes.

Daemon isolation and lifecycle:

- The daemon identity is a SHA-256 digest of the complete normalized server
  selection, including interpolated dynamic project paths. Different projects,
  worktrees, IDE ports, transports, or configurations cannot share a daemon.
- State is stored in a per-user runtime directory with mode `0700`; each state
  file has mode `0600` and contains an unreported random authentication token.
- The daemon listens only on `127.0.0.1`. Each short-lived CLI request must
  present the state-file token.
- Startup uses a per-identity lock, and state publication is atomic. PID and
  token checks prevent an old daemon from deleting a replacement's state.
- Client socket resets, malformed requests, and abandoned responses are isolated
  to that client. Server, MCP transport, or process-signal failures shut down the
  daemon and remove its state.
- The default idle timeout is 15 minutes. Active requests suspend idle shutdown,
  and shutdown destroys incomplete local connections before closing MCP.

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
- Daemon integration tests assert that multiple production-bin invocations share
  one mock MCP process and that reset or half-open local clients do not terminate
  or block the daemon.
- The suite simulates Node 16 before importing the production bin to verify the
  runtime gate without requiring an obsolete Node installation.

## Distribution architecture

`.github/plugin/marketplace.json` makes the repository a self-hosted marketplace
named `jinloes-plugins`. Its `intellij-mcp-tools` entry points to the repository
root, where `plugin.json` identifies the plugin and its `skills` field points to
the existing `skills/` directory.

Installation has two explicit steps:

1. Register `jinloes/intellij-mcp-cli` as a marketplace.
2. Install `intellij-mcp-tools@jinloes-plugins`.

The plugin name and npm package name differ intentionally:

- `intellij-mcp-tools` identifies the Copilot plugin and skill.
- `intellij-mcp-cli` identifies the npm package that supplies `ijctl`.

The npm package version, plugin manifest version, and marketplace plugin-entry
version remain aligned so a repository revision describes one compatible
CLI-and-skill release. The marketplace metadata has its own catalog version.

## Trust and security boundaries

- MCP configuration and tool results are untrusted input.
- URLs may use only HTTP or HTTPS and cannot contain embedded credentials.
- Environment placeholders fail when their variables are missing.
- Stdio commands originate from the user's IntelliJ-generated configuration;
  `ijctl` does not invent or shell-expand them.
- Tool schemas and behavior come from the connected IntelliJ instance and may
  change between IDE versions.
- Daemon state contains a bearer token and is restricted to the current user.
  The token is never included in command output.
- Agents must inspect live schemas before invoking unfamiliar tools and require
  user authorization for side-effecting IDE operations.
