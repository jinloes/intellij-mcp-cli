import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const startCountFile = process.env.MOCK_MCP_START_COUNT_FILE;
if (startCountFile !== undefined) {
  appendFileSync(startCountFile, `${process.pid}\n`, "utf8");
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = createInterface({
  input: process.stdin,
  terminal: false,
});

for await (const line of input) {
  const request = JSON.parse(line) as JsonRpcRequest;
  if (request.id === undefined) {
    continue;
  }

  if (request.method === "initialize") {
    const protocolVersion =
      typeof request.params?.protocolVersion === "string"
        ? request.params.protocolVersion
        : "2025-06-18";

    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "mock-intellij",
          version: "1.0.0",
        },
      },
    });
    continue;
  }

  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text back to the caller.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                },
              },
              required: ["text"],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "fail",
            description: "Return a tool-level error.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
            },
          },
          {
            name: "protocol_failure",
            description: "Return a JSON-RPC request failure.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "search_symbol",
            description: "Search symbols.",
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string" },
                paths: { type: "array", items: { type: "string" } },
                include_external: { type: "boolean" },
                limit: { type: "integer" },
              },
              required: ["q"],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "analyze_calls",
            description: "Analyze calls.",
            inputSchema: {
              type: "object",
              properties: {
                symbolFqn: { type: "string" },
                analysisKind: { type: "string" },
                depth: { type: "integer" },
                maxChildren: { type: "integer" },
                maxNodes: { type: "integer" },
                treePath: { type: "array", items: { type: "string" } },
                childOffset: { type: "integer" },
                timeout: { type: "integer" },
              },
              required: ["symbolFqn", "analysisKind"],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "get_file_problems",
            description: "Inspect a file.",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                errorsOnly: { type: "boolean" },
                timeout: { type: "integer" },
              },
              required: ["filePath"],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "get_project_modules",
            description: "List modules.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "get_project_dependencies",
            description: "List dependencies.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "rename_refactoring",
            description: "Rename a symbol.",
            inputSchema: {
              type: "object",
              properties: {
                pathInProject: { type: "string" },
                symbolName: { type: "string" },
                newName: { type: "string" },
              },
              required: ["pathInProject", "symbolName", "newName"],
            },
          },
          {
            name: "build_project",
            description: "Build the project.",
            inputSchema: {
              type: "object",
              properties: {
                rebuild: { type: "boolean" },
                filesToRebuild: {
                  type: "array",
                  items: { type: "string" },
                },
                timeout: { type: "integer" },
              },
              required: [],
            },
          },
          {
            name: "get_run_configurations",
            description: "List run configurations.",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
              },
              required: [],
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: "execute_run_configuration",
            description: "Execute a run configuration.",
            inputSchema: {
              type: "object",
              properties: {
                configurationName: { type: "string" },
                filePath: { type: "string" },
                line: { type: "integer" },
                timeout: { type: "integer" },
                waitForExit: { type: "boolean" },
                programArguments: { type: "string" },
                workingDirectory: { type: "string" },
                envs: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
              required: [],
            },
          },
          {
            name: "list_database_connections",
            description: "List database connections.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "execute_sql_query",
            description: "Execute SQL.",
            inputSchema: {
              type: "object",
              properties: {
                connectionId: { type: "string" },
                databaseName: { type: "string" },
                schemaName: { type: "string" },
                queryText: { type: "string" },
              },
              required: [
                "connectionId",
                "databaseName",
                "schemaName",
                "queryText",
              ],
            },
          },
        ]
          .map((tool) =>
            process.env.MOCK_MCP_SCHEMA_CHANGED === "1" &&
            tool.name === "search_symbol"
              ? {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    required: [],
                  },
                }
              : tool,
          )
          .filter(
            (tool) =>
              process.env.MOCK_MCP_MINIMAL !== "1" ||
              tool.name === "echo" ||
              tool.name === "fail" ||
              tool.name === "protocol_failure",
          ),
      },
    });
    continue;
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const argumentsValue = request.params?.arguments;

    if (name === "echo") {
      let text =
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        "text" in argumentsValue &&
        typeof argumentsValue.text === "string"
          ? argumentsValue.text
          : "";
      const delayMs =
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        "delayMs" in argumentsValue &&
        typeof argumentsValue.delayMs === "number"
          ? argumentsValue.delayMs
          : 0;
      const responseBytes =
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        "responseBytes" in argumentsValue &&
        typeof argumentsValue.responseBytes === "number"
          ? argumentsValue.responseBytes
          : 0;
      if (responseBytes > 0) {
        text = "x".repeat(responseBytes);
      }
      await delay(delayMs);

      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text }],
        },
      });
      continue;
    }

    if (name === "fail") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: "mock failure" }],
          isError: true,
        },
      });
      continue;
    }

    if (name === "protocol_failure") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_003,
          message: "mock request failure",
        },
      });
      continue;
    }

    if (
      typeof name === "string" &&
      [
        "search_symbol",
        "analyze_calls",
        "get_file_problems",
        "get_project_modules",
        "get_project_dependencies",
        "rename_refactoring",
        "build_project",
        "get_run_configurations",
        "execute_run_configuration",
        "list_database_connections",
        "execute_sql_query",
      ].includes(name)
    ) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: name,
                arguments: argumentsValue,
              }),
            },
          ],
        },
      });
      continue;
    }
  }

  send({
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported method: ${request.method}`,
    },
  });
}
