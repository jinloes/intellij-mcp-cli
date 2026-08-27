import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import {
  resolveServer,
  type HttpTransport,
  type ResolveServerOptions,
} from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import { readToolArguments } from "./input.js";
import {
  callTool,
  connectToServer,
  listTools,
  type McpConnection,
} from "./mcp.js";
import { writeJson } from "./output.js";

const VERSION = "0.1.0";

interface GlobalOptions {
  config?: string;
  server?: string;
  url?: string;
  transport?: HttpTransport;
  timeout: number;
  pretty?: boolean;
}

interface ToolsOptions {
  full?: boolean;
}

interface CallOptions {
  argsJson?: string;
  argsFile?: string;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
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

async function withConnection<T>(
  program: Command,
  operation: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const options = globalOptions(program);
  const connection = await connectToServer(
    await resolveServer(resolveOptions(program)),
    options.timeout,
  );

  try {
    return await operation(connection);
  } finally {
    await connection.client.close();
  }
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
  .showHelpAfterError()
  .exitOverride();

program
  .command("doctor")
  .description("verify the MCP connection and summarize the server")
  .action(async () => {
    await withConnection(program, async (connection) => {
      const tools = await listTools(connection, globalOptions(program).timeout);
      writeJson(
        process.stdout,
        {
          ok: true,
          configuredServer: connection.server.name,
          configurationSource: connection.server.source,
          transport: connection.transport,
          protocolVersion:
            connection.client.getNegotiatedProtocolVersion() ?? null,
          protocolEra: connection.client.getProtocolEra() ?? null,
          serverInfo: connection.client.getServerVersion() ?? null,
          capabilities: connection.client.getServerCapabilities() ?? {},
          toolCount: tools.length,
        },
        globalOptions(program).pretty ?? false,
      );
    });
  });

program
  .command("tools")
  .description("list tools exposed by the selected MCP server")
  .option("--full", "include complete MCP tool schemas")
  .action(async (commandOptions: ToolsOptions) => {
    await withConnection(program, async (connection) => {
      const tools = await listTools(connection, globalOptions(program).timeout);
      writeJson(
        process.stdout,
        {
          ok: true,
          server: connection.server.name,
          tools: commandOptions.full ? tools : tools.map(compactTool),
        },
        globalOptions(program).pretty ?? false,
      );
    });
  });

program
  .command("describe")
  .description("show the complete schema for one MCP tool")
  .argument("<tool>", "tool name")
  .action(async (toolName: string) => {
    await withConnection(program, async (connection) => {
      const tools = await listTools(connection, globalOptions(program).timeout);
      const tool = tools.find((candidate) => candidate.name === toolName);

      if (tool === undefined) {
        throw new CliError(
          `Tool "${toolName}" was not found. Run "ijctl tools" to list available tools.`,
        );
      }

      writeJson(
        process.stdout,
        {
          ok: true,
          server: connection.server.name,
          tool,
        },
        globalOptions(program).pretty ?? false,
      );
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
    const argumentsValue = await readToolArguments(commandOptions);

    await withConnection(program, async (connection) => {
      const result = await callTool(
        connection,
        toolName,
        argumentsValue,
        globalOptions(program).timeout,
      );
      const ok = result.isError !== true;

      writeJson(
        process.stdout,
        {
          ok,
          server: connection.server.name,
          tool: toolName,
          result,
        },
        globalOptions(program).pretty ?? false,
      );

      if (!ok) {
        process.exitCode = 2;
      }
    });
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
