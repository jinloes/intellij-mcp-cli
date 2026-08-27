import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseConfigText,
  selectServer,
  type LoadedConfig,
} from "../src/config.js";
import { CliError } from "../src/errors.js";
import {
  MINIMUM_NODE_MAJOR,
  isSupportedNodeVersion,
} from "../src/node-version.js";

interface PackageManifest {
  bin?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  version?: unknown;
  volta?: Record<string, unknown>;
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  version?: unknown;
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageManifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const pluginManifest = JSON.parse(
  await readFile(join(packageRoot, "plugin.json"), "utf8"),
) as PluginManifest;

function packageBinPath(): string {
  const binTarget = packageManifest.bin?.ijctl;
  if (typeof binTarget !== "string") {
    assert.fail("package.json bin.ijctl must be a string");
  }

  return resolve(packageRoot, binTarget);
}

test("classifies Node versions against the supported runtime floor", () => {
  for (const version of ["20.0.0", "20.20.2", "24.1.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }

  for (const version of ["19.99.0", "16.19.0", "", "unknown"]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});

test("pins Volta to the supported Node runtime", () => {
  assert.equal(MINIMUM_NODE_MAJOR, 20);
  assert.equal(packageManifest.engines?.node, ">=20");
  assert.equal(packageManifest.volta?.node, "20.20.2");
});

test("keeps the Copilot plugin manifest aligned with the package", () => {
  assert.equal(pluginManifest.name, "intellij-mcp-tools");
  assert.equal(pluginManifest.skills, "skills/");
  assert.equal(pluginManifest.version, packageManifest.version);
});

test("code map lists every source module", async () => {
  const codeMapping = await readFile(
    join(packageRoot, "CODE_MAPPING.md"),
    "utf8",
  );
  const sourceFiles = (
    await readdir(join(packageRoot, "src"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `src/${entry.name}`)
    .sort();

  for (const sourceFile of sourceFiles) {
    assert.ok(
      codeMapping.includes(`\`${sourceFile}\``),
      `${sourceFile} is missing from CODE_MAPPING.md`,
    );
  }
});

test("package bin rejects a simulated Node 16 before loading third-party modules", () => {
  const simulatedNodeVersion = "16.19.0";
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `Object.defineProperty(process.versions, "node", {
        configurable: true,
        enumerable: true,
        value: ${JSON.stringify(simulatedNodeVersion)},
      });
      await import(process.argv[1]);`,
      pathToFileURL(packageBinPath()).href,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /TransformStream/u);

  const errorLines = result.stderr.trim().split(/\r?\n/u);
  assert.equal(errorLines.length, 1, result.stderr);
  assert.deepEqual(JSON.parse(errorLines[0] ?? ""), {
    ok: false,
    error: {
      code: "UNSUPPORTED_NODE_VERSION",
      message: `ijctl requires Node.js 20 or newer; active version is ${simulatedNodeVersion}.`,
      activeNodeVersion: simulatedNodeVersion,
      requiredNodeVersion: "20+",
    },
  });
});

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
    const cliPath = packageBinPath();
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

    const run = (argumentsValue: string[]) => {
      const command = process.platform === "win32" ? process.execPath : cliPath;
      const commandArguments = [
        ...(process.platform === "win32" ? [cliPath] : []),
        "--config",
        configPath,
        ...argumentsValue,
      ];

      return spawnSync(command, commandArguments, {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 10_000,
      });
    };

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
