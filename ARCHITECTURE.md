# Architecture

## Purpose

`ijctl` is a thin, agent-oriented broker over IntelliJ IDEA's bundled MCP
server. It adds deterministic project targeting, JSON commands, live tool
discovery, safety metadata, stable aliases, optional connection reuse, and
version-matched skill installation. IntelliJ remains the owner of the project
model, indexes, IDE processes, tool schemas, confirmations, and actual
operations.

MCP resources, prompts, sampling, elicitation, OAuth, IDE installation,
MCP-server enablement, Brave Mode changes, and undocumented process discovery
remain outside the boundary.

## System context

```text
Coding agent or shell
        |
        | argv / stdin
        v
   ijctl command ---------------------> bundled skill filesystem operations
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

The npm CLI and Copilot plugin remain independently installed. Both releases
are version-aligned at `0.3.0`, and the npm package contains the same four skill
directories exposed by the plugin.

## Component boundaries

```text
+------------------------------------------------------------------+
| src/cli.ts                                                       |
| Dependency-free Node.js 20 gate                                  |
+--------------------------------+---------------------------------+
                                 | dynamic import
                                 v
+------------------------------------------------------------------+
| src/cli-main.ts                                                  |
| Commander definitions, orchestration, aliases, and exit behavior |
+----------+-----------+----------+-----------+----------+---------+
           |           |          |           |          |
           v           v          v           v          v
   src/config.ts src/daemon.ts src/input.ts src/skills.ts src/output.ts
           |           |                                   |
           +-----> src/mcp.ts <-----------------------------+
                       |
                       v
              MCP SDK / IntelliJ

Cross-cutting:
  src/errors.ts        stable coded failures
  src/tool-metadata.ts catalog, safety, warnings, alias contracts
  src/version.ts       shared compatibility version
```

`src/cli.ts` stays free of third-party imports so Node.js below 20 receives the
existing JSON startup failure before the MCP SDK loads.

Configuration interpolation and selection stay in `src/config.ts`; MCP
transport details stay in `src/mcp.ts`; the daemon forwards those results
without reimplementing either policy. `src/cli-main.ts` owns only command
mapping and orchestration.

## Project and server resolution

### Project context

Every normal invocation derives one canonical existing directory:

1. explicit `--project`
2. `IJCTL_PROJECT_PATH`
3. `git -C <cwd> rev-parse --show-toplevel`
4. canonical cwd

The first two sources are authoritative. A worktree's own root survives
canonicalization and is never changed to the primary checkout.

### Configuration and target selection

Configuration file precedence remains:

1. `--config`
2. `IJCTL_CONFIG`
3. `./ijctl.config.json`
4. `~/.config/ijctl/config.json`

Raw entries are validated before interpolation. Project-aware matching examines
only `IJ_MCP_SERVER_PROJECT_PATH`:

- `${IJCTL_PROJECT_PATH}` receives the canonical context.
- Static paths are canonicalized before comparison.
- Explicit `--server` always wins by name and is checked for an authoritative
  project mismatch.
- Without `--server`, one matching static or dynamic candidate is selected.
- Multiple matches return `PROJECT_TARGET_AMBIGUOUS`.
- No match for an authoritative context returns `PROJECT_TARGET_MISMATCH`.
- With derived context and no match, the compatible server named `intellij`,
  single-entry, or explicit-selection behavior is retained.

Only the selected server is normalized for execution. Environment placeholders,
relative stdio cwd, URL validation, and HTTP transport normalization remain
centralized in the configuration module.

`--url` bypasses configuration entries but retains the resolved project in
output and daemon identity.

## Configured instance discovery

`loadConfiguredInstances` reads raw candidates without requiring every dynamic
environment placeholder to be populated. Public records contain only:

- configured name
- stdio/HTTP kind and transport
- target project path and whether it was dynamic
- the IntelliJ MCP port, when configured
- resolvability and a coded resolution failure

Unrelated environment values and all headers are omitted.

`instances` does not claim liveness. `instances --probe` normalizes each safely
resolvable candidate, opens an MCP connection, records reachability and
latency, and closes it without listing or invoking tools. No IDE or
configuration state is changed.

## Transport boundary

`src/mcp.ts` creates one of:

| Transport       | Configuration                                     | Behavior                                                     |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| stdio           | command, args, environment, optional cwd          | Spawns the IntelliJ-provided command without shell expansion |
| Streamable HTTP | HTTP/HTTPS URL and optional headers               | Uses `StreamableHTTPClientTransport`                         |
| legacy SSE      | HTTP/HTTPS URL ending in `/sse` or explicit `sse` | Uses `SSEClientTransport`; custom headers are rejected       |

The MCP `Client` identifies release `0.3.0` through `src/version.ts`.
Connection failures are coded and retryable because delivery has not happened.
Read-only `tools/list` failures may be retryable. A `tools/call` transport or
protocol failure is marked non-retryable with `delivery:
possibly-delivered`; no mutation-capable call is automatically replayed.

Direct clients always close in `finally` paths.

## Command execution

For each MCP-backed command:

1. Resolve the project and selected target.
2. Unless `--no-daemon` is set, locate the daemon identity for the normalized
   server configuration and canonical project path.
3. Use one authenticated daemon request if available.
4. Otherwise connect directly, perform the operation, and close.
5. Serialize one additive JSON result.

Generic `call` and every alias first obtain the live catalog. That catalog
provides safety classification and validates alias availability. Direct mode
uses the same connection for catalog validation and invocation; daemon mode
uses the daemon's existing MCP connection.

The generic `describe` and `call` commands remain the forward-compatible route
for every unwrapped tool.

## Catalog and safety metadata

`src/tool-metadata.ts` sorts tools by name, performs case-insensitive
name/title/description filtering, applies offset/limit paging, and supports
compact or full details. Compact output retains the previous name,
title/description, required arguments, and annotations and adds `safety`.

Safety classes are:

- `read-only`
- `workspace-write`
- `execution`
- `debug-state`
- `database`
- `unknown`

An MCP `readOnlyHint` takes precedence. Conservative name patterns classify
unannotated mutation, execution, debugger, and database tools; otherwise the
class is unknown. Any class other than read-only adds a structured
`NON_READ_ONLY_TOOL` warning. Warnings preserve compatibility and do not grant
authorization.

`doctor` lists tools once and groups the same classification counts while
retaining its connection fields and total tool count.

## Curated aliases

The command layer maps stable argument names to the currently documented
IntelliJ tools:

| Alias                  | Live tool                   |
| ---------------------- | --------------------------- |
| `search symbol`        | `search_symbol`             |
| `analyze calls`        | `analyze_calls`             |
| `analyze problems`     | `get_file_problems`         |
| `analyze modules`      | `get_project_modules`       |
| `analyze dependencies` | `get_project_dependencies`  |
| `refactor rename`      | `rename_refactoring`        |
| `build`                | `build_project`             |
| `run list`             | `get_run_configurations`    |
| `run execute`          | `execute_run_configuration` |
| `database connections` | `list_database_connections` |
| `database query`       | `execute_sql_query`         |

Before invocation, required properties and required-list membership are checked
against the live schema. Drift returns a coded error and directs callers to
`tools`, `describe`, and generic `call`; it never silently guesses a new
contract.

## Persistent daemon

The daemon identity hashes protocol version, selected server/source, normalized
transport configuration, and canonical project path. Project-source labels do
not affect identity, so a parent derived context and the child process's
explicit `--project` identify the same target.

Lifecycle and isolation remain:

- per-user directory mode `0700` and state files mode `0600`
- random bearer token never emitted by commands
- loopback-only socket
- per-identity startup lock and atomic state publication
- idempotent start, status/list, exact or all stop, and idle shutdown
- cleanup on MCP transport close, signals, or server failure
- isolated malformed, reset, abandoned, and stalled local clients

Daemon frames carry the full operational error code, retryability, details,
message, and exit code. The short-lived client validates every field and
reconstructs the same `CliError`; error classification is not lost between
direct and daemon modes.

## Output and exit contract

Every normal success preserves its prior top-level fields and adds stable
`command` and `durationMs`. MCP-backed results also include:

```text
target:
  server
  projectPath
  projectSource
  configurationSource
```

Tool calls add `safety` and, when needed, `warning`. A tool-level MCP error
retains the raw `result` and adds a stable non-retryable error object.

| Condition                       | Stream                          |                     Exit status |
| ------------------------------- | ------------------------------- | ------------------------------: |
| Success                         | one JSON object on stdout       |                               0 |
| MCP result with `isError: true` | one JSON object on stdout       |                               2 |
| Operational failure             | one coded JSON object on stderr | `CliError.exitCode`, normally 1 |
| Unsupported Node.js             | existing JSON object on stderr  |                               1 |
| Commander help/version/usage    | Commander output                |                       unchanged |

`IJCTL_DEBUG=1` adds stack information to caught operational errors. New
metadata is additive; existing fields, stream routing, and tool-error exit 2
remain compatible.

## Skill lifecycle and distribution

`src/skills.ts` discovers `skills/*/SKILL.md` relative to the installed package
and validates unique directory/frontmatter names. The four release-matched
skills are:

- `intellij-mcp-tools` router/setup
- `intellij-code-intelligence`
- `intellij-run-debug`
- `intellij-database`

User scope is `~/.copilot/skills`; project scope is
`<canonical-project>/.github/skills`. All/subset selection and dry-run share the
same validation. Existing destinations require explicit `--force` during
install. Refresh requires a matching `.ijctl-skill.json` ownership marker.

Every existing path component and bundled source entry is checked for symlinks.
For a write, one sibling staging directory is populated with regular files and
the `0.3.0` marker, then renamed into place. Existing content is moved to a
temporary sibling backup and restored if replacement fails.

The npm package's `files` entry includes the whole `skills/` tree. `plugin.json`
and the marketplace entry point to the same tree and share version `0.3.0`.
Installing the plugin does not install the npm CLI; installing skills does not
register the plugin.

## Build and test architecture

- `npm run build` compiles production ESM and marks the package bin executable.
- `npm run typecheck` checks production and test TypeScript in strict mode.
- `npm test` rebuilds the production bin, compiles all tests, and executes both
  `project.test.js` and `interaction-model.test.js`.
- Process tests resolve and execute `package.json#bin`, never a separate CLI.
- A deterministic stdio fixture exposes annotations, aliases, argument echoing,
  tool-level errors, protocol failures, delays, and process-start counting.
- Temporary configs/projects/homes exercise target resolution, redaction,
  probing, daemon parity, warnings, and safe skill filesystem behavior without
  a running IntelliJ instance.
- `npm run check` is the authoritative repository aggregate.

## Trust boundaries

- Configuration, tool schemas/results, daemon frames, SQL, and filesystem
  contents are untrusted input.
- URLs cannot embed credentials; unrelated environment and header values are
  not included in instance output.
- MCP commands are executed as argv without shell interpolation.
- Tool availability and annotations can change across IDE versions.
- Warning-only compatibility never replaces user authorization.
- The CLI does not discover IDE processes through undocumented APIs, enable
  servers, change Brave Mode, install IDEs/plugins, execute migrations
  automatically, or retry possibly delivered mutations.
