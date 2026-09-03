import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

import {
  loadConfiguredInstances,
  resolveProjectContext,
  resolveServer,
  type HttpTransport,
  type ResolveServerOptions,
  type ResolvedServer,
} from "./config.js";
import {
  daemonCall,
  daemonDoctor,
  daemonStatus,
  daemonTools,
  DEFAULT_DAEMON_IDLE_TIMEOUT,
  listDaemons,
  MAX_TIMER_DELAY,
  notifyDaemonReady,
  notifyDaemonStartupError,
  runDaemon,
  startDaemon,
  stopAllDaemons,
  stopDaemon,
} from "./daemon.js";
import { CliError, errorMetadata } from "./errors.js";
import { readTextInput, readToolArguments } from "./input.js";
import {
  callTool,
  connectToServer,
  connectionDetails,
  listTools,
  type McpConnection,
} from "./mcp.js";
import {
  commandError,
  commandResult,
  elapsedMilliseconds,
  startTimer,
  writeJson,
} from "./output.js";
import {
  installSkills,
  listBundledSkills,
  refreshSkills,
  type SkillScope,
} from "./skills.js";
import {
  ALIAS_DEFINITIONS,
  buildToolCatalog,
  classifyTool,
  countToolsBySafety,
  requireAliasTool,
  safetyWarning,
  type AliasName,
  type ToolSafety,
} from "./tool-metadata.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  config?: string;
  server?: string;
  url?: string;
  transport?: HttpTransport;
  project?: string;
  timeout: number;
  pretty?: boolean;
  daemon?: boolean;
}

interface ToolsOptions {
  full?: boolean;
  query?: string;
  detail: "compact" | "full";
  offset: number;
  limit: number;
}

interface CallOptions {
  argsJson?: string;
  argsFile?: string;
}

interface DaemonStartOptions {
  idleTimeout: number;
}

interface DaemonStopOptions {
  all?: boolean;
}

interface InstancesOptions {
  probe?: boolean;
}

interface SkillCommandOptions {
  scope: SkillScope;
  dryRun?: boolean;
  force?: boolean;
}

let currentCommand = "ijctl";
let currentCommandStartedAt = startTimer();

function beginCommand(command: string): number {
  currentCommand = command;
  currentCommandStartedAt = startTimer();
  return currentCommandStartedAt;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_TIMER_DELAY
  ) {
    throw new InvalidArgumentError(
      `Expected an integer from 1 through ${MAX_TIMER_DELAY}.`,
    );
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
}

function globalOptions(program: Command): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function resolveOptions(program: Command): ResolveServerOptions {
  const options = globalOptions(program);
  return {
    ...(options.config === undefined ? {} : { configPath: options.config }),
    ...(options.server === undefined ? {} : { serverName: options.server }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    ...(options.project === undefined ? {} : { projectPath: options.project }),
  };
}

async function selectedServer(program: Command): Promise<ResolvedServer> {
  return resolveServer(resolveOptions(program));
}

function targetDetails(server: ResolvedServer) {
  return {
    server: server.name,
    projectPath: server.project.path,
    projectSource: server.project.source,
    configurationSource: server.source,
  };
}

function writeSuccess(
  program: Command,
  command: string,
  startedAt: number,
  value: Record<string, unknown>,
): void {
  writeJson(
    process.stdout,
    commandResult(command, startedAt, value),
    globalOptions(program).pretty ?? false,
  );
}

async function withDirectConnection<T>(
  program: Command,
  server: ResolvedServer,
  operation: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const options = globalOptions(program);
  const connection = await connectToServer(server, options.timeout);
  try {
    return await operation(connection);
  } finally {
    await connection.client.close();
  }
}

async function withBackend<T>(
  program: Command,
  daemonOperation: (
    server: ResolvedServer,
    timeout: number,
  ) => Promise<T | undefined>,
  directOperation: (connection: McpConnection) => Promise<T>,
): Promise<{
  connectionMode: "daemon" | "direct";
  server: ResolvedServer;
  value: T;
}> {
  const options = globalOptions(program);
  const server = await selectedServer(program);
  if (options.daemon !== false) {
    const daemonValue = await daemonOperation(server, options.timeout);
    if (daemonValue !== undefined) {
      return {
        connectionMode: "daemon",
        server,
        value: daemonValue,
      };
    }
  }
  return {
    connectionMode: "direct",
    server,
    value: await withDirectConnection(program, server, directOperation),
  };
}

function findGenericTool(tools: Tool[], toolName: string): Tool {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new CliError(
      `Tool "${toolName}" was not found. Run "ijctl tools" to list available tools.`,
      {
        code: "TOOL_NOT_FOUND",
        details: { tool: toolName },
      },
    );
  }
  return tool;
}

async function invokeTool(
  program: Command,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  alias?: AliasName,
): Promise<{
  connectionMode: "daemon" | "direct";
  server: ResolvedServer;
  value: {
    result: CallToolResult;
    safety: ToolSafety;
  };
}> {
  const resolveMetadata = (tools: Tool[]) => {
    const tool =
      alias === undefined
        ? findGenericTool(tools, toolName)
        : requireAliasTool(tools, alias).tool;
    return { tool, safety: classifyTool(tool) };
  };

  return withBackend(
    program,
    async (server, timeout) => {
      const tools = await daemonTools(server, timeout);
      if (tools === undefined) {
        return undefined;
      }
      const metadata = resolveMetadata(tools);
      const result = await daemonCall(
        server,
        toolName,
        argumentsValue,
        timeout,
      );
      return result === undefined
        ? undefined
        : { result, safety: metadata.safety };
    },
    async (connection) => {
      const metadata = resolveMetadata(
        await listTools(connection, globalOptions(program).timeout),
      );
      return {
        result: await callTool(
          connection,
          toolName,
          argumentsValue,
          globalOptions(program).timeout,
        ),
        safety: metadata.safety,
      };
    },
  );
}

function toolErrorMessage(result: CallToolResult): string {
  for (const content of result.content) {
    if (
      typeof content === "object" &&
      content !== null &&
      "type" in content &&
      content.type === "text" &&
      "text" in content &&
      typeof content.text === "string"
    ) {
      return content.text;
    }
  }
  return "The MCP tool reported an error.";
}

function writeToolCallResult(
  program: Command,
  command: string,
  startedAt: number,
  backend: Awaited<ReturnType<typeof invokeTool>>,
  toolName: string,
): void {
  const ok = backend.value.result.isError !== true;
  const warning = safetyWarning(backend.value.safety);
  writeSuccess(program, command, startedAt, {
    ok,
    server: backend.server.name,
    connectionMode: backend.connectionMode,
    tool: toolName,
    result: backend.value.result,
    target: targetDetails(backend.server),
    safety: backend.value.safety,
    ...(warning === undefined ? {} : { warning }),
    ...(ok
      ? {}
      : {
          error: {
            code: "MCP_TOOL_ERROR",
            message: toolErrorMessage(backend.value.result),
            retryable: false,
          },
        }),
  });
  if (!ok) {
    process.exitCode = 2;
  }
}

async function runAlias(
  program: Command,
  command: AliasName,
  argumentsValue: Record<string, unknown>,
  startedAt = beginCommand(command),
): Promise<void> {
  const definition = ALIAS_DEFINITIONS[command];
  const backend = await invokeTool(
    program,
    definition.tool,
    argumentsValue,
    command,
  );
  writeToolCallResult(program, command, startedAt, backend, definition.tool);
}

function parseEnvironment(
  values: string[] | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new CliError(
        `Invalid --env value "${value}"; expected NAME=VALUE.`,
        { code: "INPUT_INVALID" },
      );
    }
    environment[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return environment;
}

const program = new Command()
  .name("ijctl")
  .description(
    "Call tools exposed by IntelliJ IDEA's MCP server through a shell-friendly JSON interface.",
  )
  .version(VERSION)
  .option(
    "-c, --config <path>",
    "MCP config file; defaults to IJCTL_CONFIG, ./ijctl.config.json, or ~/.config/ijctl/config.json",
  )
  .option(
    "-s, --server <name>",
    'configured server name; defaults to "intellij"',
  )
  .option(
    "--project <path>",
    "target project or worktree; defaults to IJCTL_PROJECT_PATH, the current Git root, or cwd",
  )
  .option("--url <url>", "connect directly to an HTTP MCP endpoint")
  .addOption(
    new Option("--transport <transport>", "HTTP transport override").choices([
      "streamable-http",
      "sse",
    ]),
  )
  .option(
    "--timeout <milliseconds>",
    "connection and request timeout",
    parsePositiveInteger,
    60_000,
  )
  .option("--pretty", "pretty-print JSON output")
  .option("--no-daemon", "bypass a running ijctl connection daemon")
  .showHelpAfterError()
  .exitOverride();

program
  .command("instances")
  .description("list sanitized configured IntelliJ MCP targets")
  .option(
    "--probe",
    "connect to safely resolvable targets and report reachability without invoking tools",
  )
  .action(async (commandOptions: InstancesOptions) => {
    const startedAt = beginCommand("instances");
    const options = globalOptions(program);
    if (options.url !== undefined) {
      throw new CliError("--url cannot be used with instances.", {
        code: "CONFIG_INVALID",
      });
    }
    const configured = await loadConfiguredInstances({
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.project === undefined
        ? {}
        : { projectPath: options.project }),
    });
    const instances = await Promise.all(
      configured.instances.map(async (instance) => {
        if (commandOptions.probe !== true || !instance.resolvable) {
          return instance;
        }
        const probeStartedAt = startTimer();
        try {
          const server = await resolveServer({
            configPath: configured.configurationSource,
            serverName: instance.name,
            projectPath: instance.projectPath ?? configured.project.path,
          });
          const connection = await connectToServer(server, options.timeout);
          await connection.client.close();
          return {
            ...instance,
            probe: {
              reachable: true,
              latencyMs: elapsedMilliseconds(probeStartedAt),
            },
          };
        } catch (error) {
          return {
            ...instance,
            probe: {
              reachable: false,
              latencyMs: elapsedMilliseconds(probeStartedAt),
              error: errorMetadata(error),
            },
          };
        }
      }),
    );
    writeSuccess(program, "instances", startedAt, {
      ok: true,
      configurationSource: configured.configurationSource,
      project: configured.project,
      instances,
      probed: commandOptions.probe === true,
    });
  });

program
  .command("doctor")
  .description("verify the MCP connection and summarize the server")
  .action(async () => {
    const startedAt = beginCommand("doctor");
    const backendStartedAt = startTimer();
    const result = await withBackend(
      program,
      daemonDoctor,
      async (connection) => {
        const tools = await listTools(
          connection,
          globalOptions(program).timeout,
        );
        return {
          info: {
            connection: connectionDetails(connection),
          },
          toolCount: tools.length,
          tools,
        };
      },
    );
    const connection = result.value.info.connection;
    writeSuccess(program, "doctor", startedAt, {
      ok: true,
      configuredServer: result.server.name,
      configurationSource: result.server.source,
      connectionMode: result.connectionMode,
      ...connection,
      toolCount: result.value.toolCount,
      target: targetDetails(result.server),
      resolvedProject: result.server.project,
      latencyMs: elapsedMilliseconds(backendStartedAt),
      safetyCounts: countToolsBySafety(result.value.tools),
    });
  });

program
  .command("tools")
  .description("list tools exposed by the selected MCP server")
  .option("--full", "include complete MCP tool schemas (compatibility alias)")
  .option("--query <text>", "case-insensitive name/title/description filter")
  .addOption(
    new Option("--detail <level>", "tool detail level")
      .choices(["compact", "full"])
      .default("compact"),
  )
  .option(
    "--offset <number>",
    "zero-based result offset",
    parseNonNegativeInteger,
    0,
  )
  .option(
    "--limit <number>",
    "maximum number of results",
    parsePositiveInteger,
    100,
  )
  .action(async (commandOptions: ToolsOptions) => {
    const startedAt = beginCommand("tools");
    const result = await withBackend(program, daemonTools, (connection) =>
      listTools(connection, globalOptions(program).timeout),
    );
    const catalog = buildToolCatalog(result.value, {
      ...(commandOptions.query === undefined
        ? {}
        : { query: commandOptions.query }),
      detail: commandOptions.full === true ? "full" : commandOptions.detail,
      offset: commandOptions.offset,
      limit: commandOptions.limit,
    });
    writeSuccess(program, "tools", startedAt, {
      ok: true,
      server: result.server.name,
      connectionMode: result.connectionMode,
      tools: catalog.tools,
      paging: catalog.paging,
      target: targetDetails(result.server),
    });
  });

program
  .command("describe")
  .description("show the complete schema for one MCP tool")
  .argument("<tool>", "tool name")
  .action(async (toolName: string) => {
    const startedAt = beginCommand("describe");
    const result = await withBackend(program, daemonTools, (connection) =>
      listTools(connection, globalOptions(program).timeout),
    );
    const tool = findGenericTool(result.value, toolName);
    writeSuccess(program, "describe", startedAt, {
      ok: true,
      server: result.server.name,
      connectionMode: result.connectionMode,
      tool: { ...tool, safety: classifyTool(tool) },
      target: targetDetails(result.server),
    });
  });

program
  .command("call")
  .description("call one MCP tool")
  .argument("<tool>", "tool name")
  .option("--args-json <json>", "tool arguments as a JSON object")
  .option(
    "--args-file <path>",
    'read tool arguments from a JSON file; use "-" for standard input',
  )
  .action(async (toolName: string, commandOptions: CallOptions) => {
    const startedAt = beginCommand("call");
    const argumentsValue = await readToolArguments(commandOptions);
    const backend = await invokeTool(program, toolName, argumentsValue);
    writeToolCallResult(program, "call", startedAt, backend, toolName);
  });

const searchCommand = program
  .command("search")
  .description("semantic search aliases");
searchCommand
  .command("symbol")
  .description("search project symbols")
  .argument("<query>", "symbol query")
  .option("--path <glob...>", "project-relative path filters")
  .option("--include-external", "include SDK and library symbols")
  .option("--limit <number>", "maximum results", parsePositiveInteger)
  .action(
    async (
      query: string,
      options: {
        path?: string[];
        includeExternal?: boolean;
        limit?: number;
      },
    ) =>
      runAlias(program, "search symbol", {
        q: query,
        ...(options.path === undefined ? {} : { paths: options.path }),
        ...(options.includeExternal === undefined
          ? {}
          : { include_external: options.includeExternal }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      }),
  );

const analyzeCommand = program
  .command("analyze")
  .description("code analysis aliases");
analyzeCommand
  .command("calls")
  .description("analyze incoming or outgoing calls")
  .argument("<symbol>", "fully qualified callable symbol")
  .addOption(
    new Option("--kind <direction>", "call direction")
      .choices(["incoming", "outgoing"])
      .default("incoming"),
  )
  .option("--depth <number>", "maximum tree depth", parseNonNegativeInteger)
  .option(
    "--max-children <number>",
    "maximum children per node",
    parsePositiveInteger,
  )
  .option("--max-nodes <number>", "maximum total nodes", parsePositiveInteger)
  .option(
    "--tree-path <signature...>",
    "exact subtree path from an earlier result",
  )
  .option(
    "--child-offset <number>",
    "child paging offset",
    parseNonNegativeInteger,
  )
  .option(
    "--analysis-timeout <milliseconds>",
    "IDE analysis timeout",
    parsePositiveInteger,
  )
  .action(
    async (
      symbol: string,
      options: {
        kind: "incoming" | "outgoing";
        depth?: number;
        maxChildren?: number;
        maxNodes?: number;
        treePath?: string[];
        childOffset?: number;
        analysisTimeout?: number;
      },
    ) =>
      runAlias(program, "analyze calls", {
        symbolFqn: symbol,
        analysisKind:
          options.kind === "incoming" ? "INCOMING_CALLS" : "OUTGOING_CALLS",
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        ...(options.maxChildren === undefined
          ? {}
          : { maxChildren: options.maxChildren }),
        ...(options.maxNodes === undefined
          ? {}
          : { maxNodes: options.maxNodes }),
        ...(options.treePath === undefined
          ? {}
          : { treePath: options.treePath }),
        ...(options.childOffset === undefined
          ? {}
          : { childOffset: options.childOffset }),
        ...(options.analysisTimeout === undefined
          ? {}
          : { timeout: options.analysisTimeout }),
      }),
  );
analyzeCommand
  .command("problems")
  .description("inspect file problems")
  .argument("<file>", "project-relative file path")
  .option("--errors-only", "return only errors")
  .option(
    "--analysis-timeout <milliseconds>",
    "IDE inspection timeout",
    parsePositiveInteger,
  )
  .action(
    async (
      file: string,
      options: { errorsOnly?: boolean; analysisTimeout?: number },
    ) =>
      runAlias(program, "analyze problems", {
        filePath: file,
        ...(options.errorsOnly === undefined
          ? {}
          : { errorsOnly: options.errorsOnly }),
        ...(options.analysisTimeout === undefined
          ? {}
          : { timeout: options.analysisTimeout }),
      }),
  );
analyzeCommand
  .command("modules")
  .description("list project modules")
  .action(async () => runAlias(program, "analyze modules", {}));
analyzeCommand
  .command("dependencies")
  .description("list project dependencies")
  .action(async () => runAlias(program, "analyze dependencies", {}));

const refactorCommand = program
  .command("refactor")
  .description("refactoring aliases");
refactorCommand
  .command("rename")
  .description("rename a project symbol")
  .argument("<path>", "project-relative file path")
  .argument("<symbol>", "current symbol name")
  .argument("<new-name>", "replacement symbol name")
  .action(async (path: string, symbol: string, newName: string) =>
    runAlias(program, "refactor rename", {
      pathInProject: path,
      symbolName: symbol,
      newName,
    }),
  );

program
  .command("build")
  .description("build the IntelliJ project")
  .option("--rebuild", "perform a full rebuild")
  .option("--file <path...>", "compile only specified project-relative files")
  .option(
    "--build-timeout <milliseconds>",
    "IDE build timeout",
    parsePositiveInteger,
  )
  .action(
    async (options: {
      rebuild?: boolean;
      file?: string[];
      buildTimeout?: number;
    }) =>
      runAlias(program, "build", {
        ...(options.rebuild === undefined ? {} : { rebuild: options.rebuild }),
        ...(options.file === undefined ? {} : { filesToRebuild: options.file }),
        ...(options.buildTimeout === undefined
          ? {}
          : { timeout: options.buildTimeout }),
      }),
  );

const runCommand = program
  .command("run")
  .description("run configuration aliases");
runCommand
  .command("list")
  .description("list run configurations or file run points")
  .option("--file <path>", "project-relative file path")
  .action(async (options: { file?: string }) =>
    runAlias(program, "run list", {
      ...(options.file === undefined ? {} : { filePath: options.file }),
    }),
  );
runCommand
  .command("execute")
  .description("execute a run configuration or file run point")
  .option("--configuration <name>", "existing run configuration name")
  .option("--file <path>", "project-relative executable file")
  .option("--line <number>", "1-based executable line", parsePositiveInteger)
  .option(
    "--run-timeout <milliseconds>",
    "IDE execution timeout",
    parsePositiveInteger,
  )
  .option("--wait-for-exit", "wait for process termination")
  .option("--program-arguments <arguments>", "launch-only program arguments")
  .option("--working-directory <path>", "launch-only working directory")
  .option("--env <name=value...>", "launch-only environment overrides")
  .action(
    async (options: {
      configuration?: string;
      file?: string;
      line?: number;
      runTimeout?: number;
      waitForExit?: boolean;
      programArguments?: string;
      workingDirectory?: string;
      env?: string[];
    }) => {
      const startedAt = beginCommand("run execute");
      const usesConfiguration = options.configuration !== undefined;
      const usesLocation =
        options.file !== undefined || options.line !== undefined;
      if (
        usesConfiguration === usesLocation ||
        (usesLocation &&
          (options.file === undefined || options.line === undefined))
      ) {
        throw new CliError(
          "run execute requires either --configuration or both --file and --line.",
          { code: "INPUT_INVALID" },
        );
      }
      const environment = parseEnvironment(options.env);
      await runAlias(
        program,
        "run execute",
        {
          ...(options.configuration === undefined
            ? {}
            : { configurationName: options.configuration }),
          ...(options.file === undefined ? {} : { filePath: options.file }),
          ...(options.line === undefined ? {} : { line: options.line }),
          ...(options.runTimeout === undefined
            ? {}
            : { timeout: options.runTimeout }),
          ...(options.waitForExit === undefined
            ? {}
            : { waitForExit: options.waitForExit }),
          ...(options.programArguments === undefined
            ? {}
            : { programArguments: options.programArguments }),
          ...(options.workingDirectory === undefined
            ? {}
            : { workingDirectory: options.workingDirectory }),
          ...(Object.keys(environment).length === 0
            ? {}
            : { envs: environment }),
        },
        startedAt,
      );
    },
  );

const databaseCommand = program
  .command("database")
  .description("database aliases");
databaseCommand
  .command("connections")
  .description("list configured database connections")
  .action(async () => runAlias(program, "database connections", {}));
databaseCommand
  .command("query")
  .description("execute SQL through an IntelliJ database connection")
  .requiredOption("--connection <id>", "database connection ID")
  .requiredOption("--database <name>", "database name (may be an empty string)")
  .requiredOption("--schema <name>", "schema name")
  .option("--query <sql>", "SQL query text")
  .option("--query-file <path>", 'read SQL from a file; use "-" for stdin')
  .action(
    async (options: {
      connection: string;
      database: string;
      schema: string;
      query?: string;
      queryFile?: string;
    }) => {
      const startedAt = beginCommand("database query");
      const queryText = await readTextInput({
        ...(options.query === undefined ? {} : { text: options.query }),
        ...(options.queryFile === undefined ? {} : { file: options.queryFile }),
        textOption: "--query",
        fileOption: "--query-file",
      });
      await runAlias(
        program,
        "database query",
        {
          connectionId: options.connection,
          databaseName: options.database,
          schemaName: options.schema,
          queryText,
        },
        startedAt,
      );
    },
  );

const skillCommand = program
  .command("skill")
  .description("manage skills bundled with this ijctl release");
skillCommand
  .command("list")
  .description("list bundled skills")
  .action(async () => {
    const startedAt = beginCommand("skill list");
    writeSuccess(program, "skill list", startedAt, {
      ok: true,
      version: VERSION,
      skills: await listBundledSkills(),
    });
  });

function addSkillScopeOptions(
  command: Command,
  includeForce: boolean,
): Command {
  command
    .addOption(
      new Option("--scope <scope>", "installation scope")
        .choices(["user", "project"])
        .default("user"),
    )
    .option("--dry-run", "validate and report actions without writing files");
  if (includeForce) {
    command.option("--force", "replace an existing installation");
  }
  return command;
}

addSkillScopeOptions(
  skillCommand
    .command("install")
    .description("install all bundled skills or an explicit subset")
    .argument("[skills...]", "bundled skill names"),
  true,
).action(async (names: string[], options: SkillCommandOptions) => {
  const startedAt = beginCommand("skill install");
  const project = await resolveProjectContext(globalOptions(program).project);
  const results = await installSkills({
    names,
    scope: options.scope,
    projectPath: project.path,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
  });
  writeSuccess(program, "skill install", startedAt, {
    ok: true,
    version: VERSION,
    scope: options.scope,
    project,
    results,
  });
});

addSkillScopeOptions(
  skillCommand
    .command("refresh")
    .description("refresh only ijctl-managed skill installations")
    .argument("[skills...]", "bundled skill names"),
  false,
).action(async (names: string[], options: SkillCommandOptions) => {
  const startedAt = beginCommand("skill refresh");
  const project = await resolveProjectContext(globalOptions(program).project);
  const results = await refreshSkills({
    names,
    scope: options.scope,
    projectPath: project.path,
    dryRun: options.dryRun ?? false,
  });
  writeSuccess(program, "skill refresh", startedAt, {
    ok: true,
    version: VERSION,
    scope: options.scope,
    project,
    results,
  });
});

const daemonCommand = program
  .command("daemon")
  .description("manage a persistent IntelliJ MCP connection");

daemonCommand
  .command("start")
  .description("start or reuse the connection daemon")
  .option(
    "--idle-timeout <milliseconds>",
    "stop after this period without a request",
    parsePositiveInteger,
    DEFAULT_DAEMON_IDLE_TIMEOUT,
  )
  .action(async (commandOptions: DaemonStartOptions) => {
    const startedAt = beginCommand("daemon start");
    const server = await selectedServer(program);
    const entryPath = process.argv[1];
    if (entryPath === undefined) {
      throw new CliError("Unable to determine the ijctl executable path.", {
        code: "INTERNAL_ERROR",
      });
    }
    let childArguments: string[];
    if (server.source === "command line") {
      if (server.config.kind !== "http") {
        throw new CliError(
          "A command-line MCP server must use an HTTP transport.",
          { code: "CONFIG_INVALID" },
        );
      }
      childArguments = [
        "--project",
        server.project.path,
        "--url",
        server.config.url,
        "--transport",
        server.config.transport,
      ];
    } else {
      childArguments = [
        "--project",
        server.project.path,
        "--config",
        server.source,
        "--server",
        server.name,
        ...(server.config.kind === "http"
          ? ["--transport", server.config.transport]
          : []),
      ];
    }
    childArguments.push(
      "--timeout",
      String(globalOptions(program).timeout),
      "_daemon",
      "--idle-timeout",
      String(commandOptions.idleTimeout),
    );
    const result = await startDaemon(
      server,
      entryPath,
      childArguments,
      globalOptions(program).timeout,
    );
    writeSuccess(program, "daemon start", startedAt, {
      ok: true,
      server: server.name,
      running: true,
      reused: result.reused,
      daemon: result.info,
      target: targetDetails(server),
    });
  });

daemonCommand
  .command("list")
  .description("list all connection daemons")
  .action(async () => {
    const startedAt = beginCommand("daemon list");
    writeSuccess(program, "daemon list", startedAt, {
      ok: true,
      daemons: await listDaemons(globalOptions(program).timeout),
    });
  });

daemonCommand
  .command("status")
  .description("show connection daemon status")
  .action(async () => {
    const startedAt = beginCommand("daemon status");
    const server = await selectedServer(program);
    const status = await daemonStatus(server, globalOptions(program).timeout);
    writeSuccess(
      program,
      "daemon status",
      startedAt,
      status === undefined
        ? {
            ok: true,
            server: server.name,
            running: false,
            target: targetDetails(server),
          }
        : {
            ok: true,
            server: server.name,
            running: true,
            daemon: status,
            target: targetDetails(server),
          },
    );
  });

daemonCommand
  .command("stop")
  .description("stop the connection daemon")
  .option("--all", "stop all connection daemons")
  .action(async (commandOptions: DaemonStopOptions) => {
    const startedAt = beginCommand("daemon stop");
    if (commandOptions.all === true) {
      const stoppedCount = await stopAllDaemons(globalOptions(program).timeout);
      writeSuccess(program, "daemon stop", startedAt, {
        ok: true,
        stopped: stoppedCount > 0,
        stoppedCount,
      });
      return;
    }
    const server = await selectedServer(program);
    const stopped = await stopDaemon(server, globalOptions(program).timeout);
    writeSuccess(program, "daemon stop", startedAt, {
      ok: true,
      server: server.name,
      stopped,
      target: targetDetails(server),
    });
  });

program
  .command("_daemon", { hidden: true })
  .option(
    "--idle-timeout <milliseconds>",
    "stop after this period without a request",
    parsePositiveInteger,
    DEFAULT_DAEMON_IDLE_TIMEOUT,
  )
  .action(async (commandOptions: DaemonStartOptions) => {
    try {
      await runDaemon(
        await selectedServer(program),
        globalOptions(program).timeout,
        commandOptions.idleTimeout,
        notifyDaemonReady,
      );
    } catch (error) {
      notifyDaemonStartupError(error);
      throw error;
    }
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        process.exitCode = error.exitCode;
      }
      return;
    }
    writeJson(
      process.stderr,
      commandError(
        currentCommand,
        currentCommandStartedAt,
        error,
        process.env.IJCTL_DEBUG === "1",
      ),
      globalOptions(program).pretty ?? false,
    );
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

await main();
