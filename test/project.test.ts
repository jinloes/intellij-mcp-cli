import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
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
import { VERSION } from "../src/version.js";

interface PackageManifest {
  bin?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  files?: unknown[];
  version?: unknown;
  volta?: Record<string, unknown>;
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  version?: unknown;
}

interface MarketplaceManifest {
  name?: unknown;
  plugins?: Array<{
    name?: unknown;
    source?: unknown;
    version?: unknown;
  }>;
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageManifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const pluginManifest = JSON.parse(
  await readFile(join(packageRoot, "plugin.json"), "utf8"),
) as PluginManifest;
const marketplaceManifest = JSON.parse(
  await readFile(
    join(packageRoot, ".github", "plugin", "marketplace.json"),
    "utf8",
  ),
) as MarketplaceManifest;
const skillInstructions = await readFile(
  join(packageRoot, "skills", "intellij-mcp-tools", "SKILL.md"),
  "utf8",
);

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
  assert.equal(packageManifest.version, "0.3.0");
  assert.equal(packageManifest.version, VERSION);
  assert.ok(packageManifest.files?.includes("skills"));
});

test("keeps the marketplace entry aligned with the plugin", () => {
  assert.equal(marketplaceManifest.name, "jinloes-plugins");
  assert.equal(marketplaceManifest.plugins?.length, 1);
  assert.deepEqual(marketplaceManifest.plugins?.[0], {
    name: pluginManifest.name,
    description:
      "Target IntelliJ projects and use version-matched code intelligence, run/debug, and database skills through ijctl.",
    version: pluginManifest.version,
    source: ".",
  });
});

test("bundles four uniquely named IntelliJ skills", async () => {
  const entries = await readdir(join(packageRoot, "skills"), {
    withFileTypes: true,
  });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(names, [
    "intellij-code-intelligence",
    "intellij-database",
    "intellij-mcp-tools",
    "intellij-run-debug",
  ]);
  for (const name of names) {
    const instructions = await readFile(
      join(packageRoot, "skills", name, "SKILL.md"),
      "utf8",
    );
    assert.match(instructions, new RegExp(`^---\\nname: ${name}\\n`, "u"));
    assert.match(instructions, /\ndescription: .+\n---\n/u);
  }
});

test("makes Copilot skill invocation visible with the accompanying command", () => {
  assert.match(
    skillInstructions,
    /Immediately before the first `ijctl` command in each assistant turn/,
  );
  assert.match(
    skillInstructions,
    /Using `intellij-mcp-tools` via `ijctl` for IntelliJ MCP\./,
  );
  assert.match(
    skillInstructions,
    /Do not show the notice unless an `ijctl` command will run\./,
  );
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
    assert.ok(toolsOutput.tools.some((tool) => tool.name === "echo"));
    assert.ok(toolsOutput.tools.some((tool) => tool.name === "fail"));
    assert.deepEqual(
      toolsOutput.tools.find((tool) => tool.name === "echo")?.required,
      ["text"],
    );

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

test("reuses one MCP connection across daemon-backed CLI commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-daemon-test-"));
  const daemonDirectory = join(directory, "daemon");
  const startCountFile = join(directory, "server-starts.txt");
  const configPath = join(directory, "config.json");
  const cliPath = packageBinPath();
  const serverPath = fileURLToPath(
    new URL("./fixtures/mock-mcp-server.js", import.meta.url),
  );

  const config = {
    mcpServers: {
      intellij: {
        command: process.execPath,
        args: [serverPath],
        env: {
          MOCK_MCP_START_COUNT_FILE: startCountFile,
        },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config));

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
      env: {
        ...process.env,
        IJCTL_DAEMON_DIR: daemonDirectory,
      },
      timeout: 10_000,
    });
  };

  try {
    const start = run(["daemon", "start", "--idle-timeout", String(30_000)]);
    assert.equal(start.status, 0, start.stderr);
    const startOutput = JSON.parse(start.stdout) as {
      running: boolean;
      reused: boolean;
      daemon: { pid: number };
    };
    assert.equal(startOutput.running, true);
    assert.equal(startOutput.reused, false);

    const repeatedStart = run(["daemon", "start"]);
    assert.equal(repeatedStart.status, 0, repeatedStart.stderr);
    const repeatedStartOutput = JSON.parse(repeatedStart.stdout) as {
      reused: boolean;
      daemon: { pid: number };
    };
    assert.equal(repeatedStartOutput.reused, true);
    assert.equal(repeatedStartOutput.daemon.pid, startOutput.daemon.pid);

    const tools = run(["tools"]);
    assert.equal(tools.status, 0, tools.stderr);
    const toolsOutput = JSON.parse(tools.stdout) as {
      connectionMode: string;
      tools: Array<{ name: string }>;
    };
    assert.equal(toolsOutput.connectionMode, "daemon");
    assert.ok(toolsOutput.tools.some((tool) => tool.name === "echo"));
    assert.ok(toolsOutput.tools.some((tool) => tool.name === "fail"));

    for (const text of ["first", "second"]) {
      const call = run([
        "call",
        "echo",
        "--args-json",
        JSON.stringify({ text }),
      ]);
      assert.equal(call.status, 0, call.stderr);
      const callOutput = JSON.parse(call.stdout) as {
        connectionMode: string;
        result: { content: Array<{ text: string }> };
      };
      assert.equal(callOutput.connectionMode, "daemon");
      assert.equal(callOutput.result.content[0]?.text, text);
    }

    const toolError = run(["call", "fail"]);
    assert.equal(toolError.status, 2, toolError.stderr);
    const toolErrorOutput = JSON.parse(toolError.stdout) as {
      connectionMode: string;
      ok: boolean;
    };
    assert.equal(toolErrorOutput.connectionMode, "daemon");
    assert.equal(toolErrorOutput.ok, false);

    const starts = (await readFile(startCountFile, "utf8"))
      .trim()
      .split(/\r?\n/u);
    assert.equal(starts.length, 1);

    const directTools = run(["--no-daemon", "tools"]);
    assert.equal(directTools.status, 0, directTools.stderr);
    assert.equal(
      (JSON.parse(directTools.stdout) as { connectionMode: string })
        .connectionMode,
      "direct",
    );
    assert.equal(
      (await readFile(startCountFile, "utf8")).trim().split(/\r?\n/u).length,
      2,
    );

    const status = run(["daemon", "status"]);
    assert.equal(status.status, 0, status.stderr);
    const statusOutput = JSON.parse(status.stdout) as {
      running: boolean;
      daemon: { pid: number };
    };
    assert.equal(statusOutput.running, true);
    assert.equal(statusOutput.daemon.pid, startOutput.daemon.pid);

    const stateFileName = (await readdir(daemonDirectory)).find((name) =>
      name.endsWith(".json"),
    );
    assert.notEqual(stateFileName, undefined);
    const daemonState = JSON.parse(
      await readFile(join(daemonDirectory, stateFileName ?? ""), "utf8"),
    ) as {
      host: string;
      port: number;
      token: string;
    };

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const socket = createConnection({
        host: daemonState.host,
        port: daemonState.port,
      });
      socket.once("error", rejectPromise);
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            protocolVersion: 2,
            id: "abandoned-request",
            token: daemonState.token,
            timeout: 1_000,
            method: "call",
            tool: "echo",
            arguments: {
              text: "abandoned",
              delayMs: 100,
            },
          })}\n`,
          () => {
            socket.resetAndDestroy();
            resolvePromise();
          },
        );
      });
    });
    await delay(150);

    const statusAfterReset = run(["daemon", "status"]);
    assert.equal(statusAfterReset.status, 0, statusAfterReset.stderr);
    assert.equal(
      (JSON.parse(statusAfterReset.stdout) as { running: boolean }).running,
      true,
    );

    const stalledResponseSocket = await new Promise<Socket>(
      (resolvePromise, rejectPromise) => {
        const socket = createConnection({
          host: daemonState.host,
          port: daemonState.port,
        });
        socket.once("error", rejectPromise);
        socket.once("connect", () => resolvePromise(socket));
      },
    );
    stalledResponseSocket.pause();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stalledResponseSocket.write(
        `${JSON.stringify({
          protocolVersion: 2,
          id: "stalled-response",
          token: daemonState.token,
          timeout: 2_000,
          method: "call",
          tool: "echo",
          arguments: {
            responseBytes: 8 * 1024 * 1024,
          },
        })}\n`,
        (error) => {
          if (error !== null && error !== undefined) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        },
      );
    });
    await delay(1_250);

    const statusAfterStalledResponse = run(["daemon", "status"]);
    stalledResponseSocket.destroy();
    assert.equal(
      statusAfterStalledResponse.status,
      0,
      statusAfterStalledResponse.stderr,
    );
    assert.equal(
      (
        JSON.parse(statusAfterStalledResponse.stdout) as {
          running: boolean;
        }
      ).running,
      true,
    );

    const lingeringSocket = await new Promise<Socket>(
      (resolvePromise, rejectPromise) => {
        const socket = createConnection({
          host: daemonState.host,
          port: daemonState.port,
        });
        socket.once("error", rejectPromise);
        socket.once("connect", () => resolvePromise(socket));
      },
    );

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          intellij: {
            ...config.mcpServers.intellij,
            env: {
              ...config.mcpServers.intellij.env,
              CONFIG_REVISION: "2",
            },
          },
        },
      }),
    );

    const exactStop = run(["daemon", "stop"]);
    assert.equal(exactStop.status, 0, exactStop.stderr);
    assert.equal(
      (JSON.parse(exactStop.stdout) as { stopped: boolean }).stopped,
      false,
    );

    const daemonList = run(["daemon", "list"]);
    assert.equal(daemonList.status, 0, daemonList.stderr);
    const daemonListOutput = JSON.parse(daemonList.stdout) as {
      daemons: Array<{ pid: number }>;
    };
    assert.deepEqual(
      daemonListOutput.daemons.map((daemon) => daemon.pid),
      [startOutput.daemon.pid],
    );

    const stop = run(["daemon", "stop", "--all"]);
    lingeringSocket.destroy();
    assert.equal(stop.status, 0, stop.stderr);
    const stopOutput = JSON.parse(stop.stdout) as {
      stopped: boolean;
      stoppedCount: number;
    };
    assert.equal(stopOutput.stopped, true);
    assert.equal(stopOutput.stoppedCount, 1);

    const stoppedStatus = run(["daemon", "status"]);
    assert.equal(stoppedStatus.status, 0, stoppedStatus.stderr);
    assert.equal(
      (JSON.parse(stoppedStatus.stdout) as { running: boolean }).running,
      false,
    );

    await writeFile(configPath, JSON.stringify(config));

    const oversizedIdleTimeout = run([
      "daemon",
      "start",
      "--idle-timeout",
      "2147483648",
    ]);
    assert.notEqual(oversizedIdleTimeout.status, 0);
    assert.match(oversizedIdleTimeout.stderr, /2147483647/u);

    const oversizedRequestTimeout = run([
      "--timeout",
      "2147483648",
      "daemon",
      "status",
    ]);
    assert.notEqual(oversizedRequestTimeout.status, 0);
    assert.match(oversizedRequestTimeout.stderr, /2147483647/u);

    const idleStart = run(["daemon", "start", "--idle-timeout", String(100)]);
    assert.equal(idleStart.status, 0, idleStart.stderr);
    await delay(250);

    const idleStatus = run(["daemon", "status"]);
    assert.equal(idleStatus.status, 0, idleStatus.stderr);
    assert.equal(
      (JSON.parse(idleStatus.stdout) as { running: boolean }).running,
      false,
    );
  } finally {
    run(["daemon", "stop", "--all"]);
    await rm(directory, { recursive: true, force: true });
  }
});
