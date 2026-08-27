import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseConfigText,
  selectServer,
  type LoadedConfig,
} from "../src/config.js";
import { CliError } from "../src/errors.js";

test("parses standard stdio configuration with environment interpolation", () => {
  const servers = parseConfigText(
    JSON.stringify({
      mcpServers: {
        intellij: {
          type: "stdio",
          command: "${NODE_PATH}",
          args: ["server.js"],
          env: {
            IDE_PORT: "${IDE_PORT}",
          },
        },
      },
    }),
    {
      NODE_PATH: "/usr/bin/node",
      IDE_PORT: "63342",
    },
    "/workspace",
  );

  assert.deepEqual(servers.intellij, {
    kind: "stdio",
    command: "/usr/bin/node",
    args: ["server.js"],
    env: {
      IDE_PORT: "63342",
    },
  });
});

test("fails when configuration references an unset environment variable", () => {
  assert.throws(
    () =>
      parseConfigText(
        JSON.stringify({
          mcpServers: {
            intellij: {
              command: "${MISSING_COMMAND}",
            },
          },
        }),
        {},
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.message.includes('Environment variable "MISSING_COMMAND"'),
  );
});

test("infers legacy SSE transport from an IntelliJ SSE URL", () => {
  const servers = parseConfigText(
    JSON.stringify({
      mcpServers: {
        intellij: {
          url: "http://127.0.0.1:63342/mcp/sse",
        },
      },
    }),
  );

  assert.deepEqual(servers.intellij, {
    kind: "http",
    url: "http://127.0.0.1:63342/mcp/sse",
    headers: {},
    transport: "sse",
  });
});

test("selects the intellij server by default", () => {
  const loadedConfig: LoadedConfig = {
    path: "/tmp/config.json",
    servers: {
      other: {
        kind: "http",
        url: "https://example.test/mcp",
        headers: {},
        transport: "streamable-http",
      },
      intellij: {
        kind: "stdio",
        command: "idea-mcp",
        args: [],
        env: {},
      },
    },
  };

  assert.equal(selectServer(loadedConfig).name, "intellij");
});

test("runs list, describe, call, and tool-error commands over stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-test-"));

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const serverPath = fileURLToPath(
      new URL("./fixtures/mock-mcp-server.js", import.meta.url),
    );
    const configPath = join(directory, "config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          intellij: {
            command: process.execPath,
            args: [serverPath],
          },
        },
      }),
    );

    const run = (argumentsValue: string[]) =>
      spawnSync(
        process.execPath,
        [cliPath, "--config", configPath, ...argumentsValue],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );

    const tools = run(["tools"]);
    assert.equal(tools.status, 0, tools.stderr);
    const toolsOutput = JSON.parse(tools.stdout) as {
      ok: boolean;
      tools: Array<{ name: string; required: string[] }>;
    };
    assert.equal(toolsOutput.ok, true);
    assert.deepEqual(
      toolsOutput.tools.map((tool) => tool.name),
      ["echo", "fail"],
    );
    assert.deepEqual(toolsOutput.tools[0]?.required, ["text"]);

    const describe = run(["describe", "echo"]);
    assert.equal(describe.status, 0, describe.stderr);
    const describeOutput = JSON.parse(describe.stdout) as {
      tool: { name: string };
    };
    assert.equal(describeOutput.tool.name, "echo");

    const call = run([
      "call",
      "echo",
      "--args-json",
      JSON.stringify({ text: "hello" }),
    ]);
    assert.equal(call.status, 0, call.stderr);
    const callOutput = JSON.parse(call.stdout) as {
      ok: boolean;
      result: { content: Array<{ type: string; text: string }> };
    };
    assert.equal(callOutput.ok, true);
    assert.equal(callOutput.result.content[0]?.text, "hello");

    const toolError = run(["call", "fail"]);
    assert.equal(toolError.status, 2, toolError.stderr);
    const toolErrorOutput = JSON.parse(toolError.stdout) as {
      ok: boolean;
      result: { isError: boolean };
    };
    assert.equal(toolErrorOutput.ok, false);
    assert.equal(toolErrorOutput.result.isError, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
