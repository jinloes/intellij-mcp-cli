import { createInterface } from "node:readline";

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
        ],
      },
    });
    continue;
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const argumentsValue = request.params?.arguments;

    if (name === "echo") {
      const text =
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        "text" in argumentsValue &&
        typeof argumentsValue.text === "string"
          ? argumentsValue.text
          : "";

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
