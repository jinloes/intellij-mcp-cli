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
        ],
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
