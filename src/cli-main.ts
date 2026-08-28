import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import {
  resolveServer,
  type ResolvedServer,
  type HttpTransport,
  type ResolveServerOptions,
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
import { CliError, errorMessage } from "./errors.js";
import { readToolArguments } from "./input.js";
import {
  callTool,
  connectToServer,
  connectionDetails,
  listTools,
  type McpConnection,
} from "./mcp.js";
import { writeJson } from "./output.js";

const VERSION = "0.2.0";

interface GlobalOptions {
  config?: string;
  server?: string;
  url?: string;
  transport?: HttpTransport;
  timeout: number;
  pretty?: boolean;
  daemon?: boolean;
}

interface ToolsOptions {
  full?: boolean;
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
  };
}

async function selectedServer(program: Command): Promise<ResolvedServer> {
  return resolveServer(resolveOptions(program));
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

function compactTool(tool: Awaited<ReturnType<typeof listTools>>[number]) {
  const required =
    typeof tool.inputSchema === "object" &&
    tool.inputSchema !== null &&
    "required" in tool.inputSchema &&
    Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required
      : [];

  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    required,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
  };
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
  .option("-s, --server <name>", 'server name; defaults to "intellij"')
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
  .command("doctor")
  .description("verify the MCP connection and summarize the server")
  .action(async () => {
    const result = await withBackend(
      program,
      async (server, timeout) => {
        const daemonResult = await daemonDoctor(server, timeout);
        return daemonResult === undefined
          ? undefined
          : {
              connection: daemonResult.info.connection,
              toolCount: daemonResult.toolCount,
            };
      },
      async (connection) => ({
        connection: connectionDetails(connection),
        toolCount: (await listTools(connection, globalOptions(program).timeout))
          .length,
      }),
    );

    writeJson(
      process.stdout,
      {
        ok: true,
        configuredServer: result.server.name,
        configurationSource: result.server.source,
        connectionMode: result.connectionMode,
        ...result.value.connection,
        toolCount: result.value.toolCount,
      },
      globalOptions(program).pretty ?? false,
    );
  });

program
  .command("tools")
  .description("list tools exposed by the selected MCP server")
  .option("--full", "include complete MCP tool schemas")
  .action(async (commandOptions: ToolsOptions) => {
    const result = await withBackend(program, daemonTools, (connection) =>
      listTools(connection, globalOptions(program).timeout),
    );

    writeJson(
      process.stdout,
      {
        ok: true,
        server: result.server.name,
        connectionMode: result.connectionMode,
        tools: commandOptions.full
          ? result.value
          : result.value.map(compactTool),
      },
      globalOptions(program).pretty ?? false,
    );
  });

program
  .command("describe")
  .description("show the complete schema for one MCP tool")
  .argument("<tool>", "tool name")
  .action(async (toolName: string) => {
    const result = await withBackend(program, daemonTools, (connection) =>
      listTools(connection, globalOptions(program).timeout),
    );
    const tool = result.value.find((candidate) => candidate.name === toolName);

    if (tool === undefined) {
      throw new CliError(
        `Tool "${toolName}" was not found. Run "ijctl tools" to list available tools.`,
      );
    }

    writeJson(
      process.stdout,
      {
        ok: true,
        server: result.server.name,
        connectionMode: result.connectionMode,
        tool,
      },
      globalOptions(program).pretty ?? false,
    );
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
    const argumentsValue = await readToolArguments(commandOptions);

    const backend = await withBackend(
      program,
      (server, timeout) =>
        daemonCall(server, toolName, argumentsValue, timeout),
      (connection) =>
        callTool(
          connection,
          toolName,
          argumentsValue,
          globalOptions(program).timeout,
        ),
    );
    const ok = backend.value.isError !== true;

    writeJson(
      process.stdout,
      {
        ok,
        server: backend.server.name,
        connectionMode: backend.connectionMode,
        tool: toolName,
        result: backend.value,
      },
      globalOptions(program).pretty ?? false,
    );

    if (!ok) {
      process.exitCode = 2;
    }
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
    const server = await selectedServer(program);
    const entryPath = process.argv[1];
    if (entryPath === undefined) {
      throw new CliError("Unable to determine the ijctl executable path.");
    }

    let childArguments: string[];
    if (server.source === "command line") {
      if (server.config.kind !== "http") {
        throw new CliError(
          "A command-line MCP server must use an HTTP transport.",
        );
      }
      childArguments = [
        "--url",
        server.config.url,
        "--transport",
        server.config.transport,
      ];
    } else {
      childArguments = [
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
    writeJson(
      process.stdout,
      {
        ok: true,
        server: server.name,
        running: true,
        reused: result.reused,
        daemon: result.info,
      },
      globalOptions(program).pretty ?? false,
    );
  });

daemonCommand
  .command("list")
  .description("list all connection daemons")
  .action(async () => {
    const daemons = await listDaemons(globalOptions(program).timeout);
    writeJson(
      process.stdout,
      {
        ok: true,
        daemons,
      },
      globalOptions(program).pretty ?? false,
    );
  });

daemonCommand
  .command("status")
  .description("show connection daemon status")
  .action(async () => {
    const server = await selectedServer(program);
    const status = await daemonStatus(server, globalOptions(program).timeout);
    writeJson(
      process.stdout,
      status === undefined
        ? {
            ok: true,
            server: server.name,
            running: false,
          }
        : {
            ok: true,
            server: server.name,
            running: true,
            daemon: status,
          },
      globalOptions(program).pretty ?? false,
    );
  });

daemonCommand
  .command("stop")
  .description("stop the connection daemon")
  .option("--all", "stop all connection daemons")
  .action(async (commandOptions: DaemonStopOptions) => {
    if (commandOptions.all === true) {
      const stoppedCount = await stopAllDaemons(globalOptions(program).timeout);
      writeJson(
        process.stdout,
        {
          ok: true,
          stopped: stoppedCount > 0,
          stoppedCount,
        },
        globalOptions(program).pretty ?? false,
      );
      return;
    }

    const server = await selectedServer(program);
    const stopped = await stopDaemon(server, globalOptions(program).timeout);
    writeJson(
      process.stdout,
      {
        ok: true,
        server: server.name,
        stopped,
      },
      globalOptions(program).pretty ?? false,
    );
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

    const pretty = globalOptions(program).pretty ?? false;
    writeJson(
      process.stderr,
      {
        ok: false,
        error: {
          message: errorMessage(error),
          ...(process.env.IJCTL_DEBUG === "1" && error instanceof Error
            ? { stack: error.stack }
            : {}),
        },
      },
      pretty,
    );
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

await main();
