import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ResolvedServer } from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import { VERSION } from "./version.js";

const CLIENT_NAME = "intellij-mcp-cli";

export interface McpConnection {
  client: Client;
  server: ResolvedServer;
  transport: string;
}

export function connectionDetails(connection: McpConnection) {
  return {
    transport: connection.transport,
    protocolVersion: connection.client.getNegotiatedProtocolVersion() ?? null,
    protocolEra: connection.client.getProtocolEra() ?? null,
    serverInfo: connection.client.getServerVersion() ?? null,
    capabilities: connection.client.getServerCapabilities() ?? {},
  };
}

export type McpConnectionDetails = ReturnType<typeof connectionDetails>;

function createHttpRequestInit(
  headers: Record<string, string>,
): RequestInit | undefined {
  return Object.keys(headers).length === 0 ? undefined : { headers };
}

function createTransport(server: ResolvedServer) {
  if (server.config.kind === "stdio") {
    return {
      description: `stdio:${server.config.command}`,
      transport: new StdioClientTransport({
        command: server.config.command,
        args: server.config.args,
        env: server.config.env,
        stderr: "inherit",
        ...(server.config.cwd === undefined ? {} : { cwd: server.config.cwd }),
      }),
    };
  }

  const requestInit = createHttpRequestInit(server.config.headers);
  if (server.config.transport === "sse") {
    if (requestInit !== undefined) {
      throw new CliError(
        "Custom headers are not supported with the legacy SSE transport. Use Streamable HTTP or stdio.",
        { code: "CONFIG_INVALID" },
      );
    }

    return {
      description: `sse:${server.config.url}`,
      transport: new SSEClientTransport(new URL(server.config.url)),
    };
  }

  return {
    description: `streamable-http:${server.config.url}`,
    transport: new StreamableHTTPClientTransport(
      new URL(server.config.url),
      requestInit === undefined ? undefined : { requestInit },
    ),
  };
}

export async function connectToServer(
  server: ResolvedServer,
  timeout: number,
): Promise<McpConnection> {
  const client = new Client({
    name: CLIENT_NAME,
    version: VERSION,
  });
  const { description, transport } = createTransport(server);

  try {
    await client.connect(transport, { timeout });
  } catch (connectionError) {
    try {
      await client.close();
    } catch (cleanupError) {
      throw new CliError(
        `Unable to connect to MCP server "${server.name}": ${errorMessage(connectionError)}. Cleanup also failed: ${errorMessage(cleanupError)}`,
        {
          code: "MCP_CONNECTION_FAILED",
          retryable: true,
          details: { server: server.name },
        },
      );
    }

    throw new CliError(
      `Unable to connect to MCP server "${server.name}": ${errorMessage(connectionError)}`,
      {
        code: "MCP_CONNECTION_FAILED",
        retryable: true,
        details: { server: server.name },
      },
    );
  }

  return { client, server, transport: description };
}

export async function listTools(
  connection: McpConnection,
  timeout: number,
): Promise<Tool[]> {
  try {
    const result = await connection.client.listTools(undefined, { timeout });
    return result.tools;
  } catch (error) {
    throw new CliError(
      `Unable to list tools from MCP server "${connection.server.name}": ${errorMessage(error)}`,
      {
        code: "MCP_REQUEST_FAILED",
        retryable: true,
        details: {
          server: connection.server.name,
          operation: "tools/list",
        },
      },
    );
  }
}

export async function callTool(
  connection: McpConnection,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  timeout: number,
): Promise<CallToolResult> {
  try {
    return await connection.client.callTool(
      {
        name: toolName,
        arguments: argumentsValue,
      },
      { timeout, maxTotalTimeout: timeout },
    );
  } catch (error) {
    throw new CliError(
      `Unable to call MCP tool "${toolName}" on server "${connection.server.name}": ${errorMessage(error)}`,
      {
        code: "MCP_REQUEST_FAILED",
        retryable: false,
        details: {
          server: connection.server.name,
          tool: toolName,
          delivery: "possibly-delivered",
        },
      },
    );
  }
}
