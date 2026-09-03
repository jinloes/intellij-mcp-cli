import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageManifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
) as { bin: { ijctl: string } };
const cliPath = resolve(packageRoot, packageManifest.bin.ijctl);
const serverPath = fileURLToPath(
  new URL("./fixtures/mock-mcp-server.js", import.meta.url),
);

interface RunOptions {
  configPath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  useDaemon?: boolean;
}

function runCli(argumentsValue: string[], options: RunOptions = {}) {
  const command = process.platform === "win32" ? process.execPath : cliPath;
  const environment = {
    ...process.env,
    ...options.environment,
  };
  if (options.environment?.IJCTL_CONFIG === undefined) {
    delete environment.IJCTL_CONFIG;
  }
  if (options.environment?.IJCTL_PROJECT_PATH === undefined) {
    delete environment.IJCTL_PROJECT_PATH;
  }
  const commandArguments = [
    ...(process.platform === "win32" ? [cliPath] : []),
    ...(options.configPath === undefined
      ? []
      : ["--config", options.configPath]),
    ...(options.useDaemon === true ? [] : ["--no-daemon"]),
    ...argumentsValue,
  ];
  return spawnSync(command, commandArguments, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: environment,
    timeout: 15_000,
  });
}

async function writeMockConfig(
  path: string,
  servers: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([name, value]) => [
          name,
          {
            command: process.execPath,
            args: [serverPath],
            ...value,
          },
        ]),
      ),
    }),
  );
}

function parseStdout(result: ReturnType<typeof runCli>) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as Record<string, any>;
}

function parseEchoedCall(output: Record<string, any>) {
  return JSON.parse(output.result.content[0].text) as {
    tool: string;
    arguments: Record<string, unknown>;
  };
}

test("targets projects, lists redacted instances, and probes without tool calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-targeting-"));
  const project = join(directory, "project");
  const otherProject = join(directory, "other");
  const configPath = join(directory, "config.json");
  await mkdir(project);
  await mkdir(otherProject);
  await writeMockConfig(configPath, {
    dynamic: {
      env: {
        IJ_MCP_SERVER_PROJECT_PATH: "${IJCTL_PROJECT_PATH}",
        IJ_MCP_SERVER_PORT: "63342",
        UNRELATED_SECRET: "must-not-appear",
      },
    },
    static: {
      env: {
        IJ_MCP_SERVER_PROJECT_PATH: otherProject,
        IJ_MCP_SERVER_PORT: "63343",
      },
    },
  });

  try {
    const selected = parseStdout(
      runCli(["--project", project, "tools"], { configPath }),
    );
    assert.equal(selected.server, "dynamic");
    assert.equal(selected.target.projectPath, await realpath(project));
    assert.equal(selected.command, "tools");
    assert.equal(typeof selected.durationMs, "number");

    const instancesResult = runCli(["--project", project, "instances"], {
      configPath,
    });
    const instances = parseStdout(instancesResult);
    assert.equal(instances.instances.length, 2);
    assert.equal(instances.instances[0].name, "dynamic");
    assert.equal(instances.instances[0].projectDynamic, true);
    assert.equal(instances.instances[0].port, "63342");
    assert.doesNotMatch(
      instancesResult.stdout,
      /UNRELATED_SECRET|must-not-appear/u,
    );

    const probed = parseStdout(
      runCli(["--project", project, "instances", "--probe"], { configPath }),
    );
    assert.equal(probed.probed, true);
    assert.ok(
      probed.instances.every(
        (instance: Record<string, any>) =>
          instance.probe.reachable === true &&
          typeof instance.probe.latencyMs === "number",
      ),
    );

    const mismatch = runCli(
      ["--project", project, "--server", "static", "tools"],
      { configPath },
    );
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.stdout, "");
    assert.equal(
      (JSON.parse(mismatch.stderr) as Record<string, any>).error.code,
      "PROJECT_TARGET_MISMATCH",
    );

    const missing = runCli(["--project", join(directory, "missing"), "tools"], {
      configPath,
    });
    assert.equal(missing.status, 1);
    assert.equal(
      (JSON.parse(missing.stderr) as Record<string, any>).error.code,
      "PROJECT_PATH_NOT_FOUND",
    );

    const ambiguityConfig = join(directory, "ambiguous.json");
    await writeMockConfig(ambiguityConfig, {
      first: {
        env: { IJ_MCP_SERVER_PROJECT_PATH: "${IJCTL_PROJECT_PATH}" },
      },
      second: {
        env: { IJ_MCP_SERVER_PROJECT_PATH: "${IJCTL_PROJECT_PATH}" },
      },
    });
    const ambiguous = runCli(["--project", project, "tools"], {
      configPath: ambiguityConfig,
    });
    assert.equal(ambiguous.status, 1);
    assert.equal(
      (JSON.parse(ambiguous.stderr) as Record<string, any>).error.code,
      "PROJECT_TARGET_AMBIGUOUS",
    );

    const environmentSelected = parseStdout(
      runCli(["--server", "static", "tools"], {
        configPath,
        cwd: directory,
        environment: { IJCTL_PROJECT_PATH: otherProject },
      }),
    );
    assert.equal(environmentSelected.server, "static");

    const derived = parseStdout(
      runCli(["tools"], { configPath, cwd: project }),
    );
    assert.equal(derived.server, "dynamic");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog and doctor add deterministic paging, target, timing, and safety metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-catalog-"));
  const project = join(directory, "project");
  const configPath = join(directory, "config.json");
  await mkdir(project);
  await writeMockConfig(configPath, { intellij: {} });

  try {
    const tools = parseStdout(
      runCli(
        [
          "--project",
          project,
          "tools",
          "--query",
          "project",
          "--offset",
          "1",
          "--limit",
          "2",
        ],
        { configPath },
      ),
    );
    assert.deepEqual(
      tools.tools.map((tool: Record<string, unknown>) => tool.name),
      ["get_project_dependencies", "get_project_modules"],
    );
    assert.deepEqual(tools.paging, {
      total: 3,
      offset: 1,
      limit: 2,
      returned: 2,
      hasMore: false,
    });
    assert.ok(
      tools.tools.every(
        (tool: Record<string, unknown>) => tool.safety === "read-only",
      ),
    );
    assert.equal(tools.target.projectPath, await realpath(project));

    const full = parseStdout(
      runCli(["--project", project, "tools", "--full", "--limit", "1"], {
        configPath,
      }),
    );
    assert.equal(full.tools.length, 1);
    assert.equal(typeof full.tools[0].inputSchema, "object");
    assert.equal(typeof full.tools[0].safety, "string");

    const doctor = parseStdout(
      runCli(["--project", project, "doctor"], { configPath }),
    );
    assert.equal(doctor.toolCount, 14);
    assert.ok(doctor.safetyCounts["read-only"] > 0);
    assert.ok(doctor.safetyCounts["workspace-write"] > 0);
    assert.ok(doctor.safetyCounts.execution > 0);
    assert.ok(doctor.safetyCounts.database > 0);
    assert.equal(typeof doctor.latencyMs, "number");
    assert.equal(doctor.resolvedProject.path, await realpath(project));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("curated aliases map documented arguments and emit side-effect warnings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-aliases-"));
  const project = join(directory, "project");
  const configPath = join(directory, "config.json");
  const queryPath = join(directory, "query.sql");
  await mkdir(project);
  await writeMockConfig(configPath, { intellij: {} });
  await writeFile(queryPath, "SELECT 1\n");

  const cases: Array<{
    command: string[];
    tool: string;
    arguments: Record<string, unknown>;
    safety: string;
  }> = [
    {
      command: [
        "search",
        "symbol",
        "Widget",
        "--include-external",
        "--limit",
        "5",
        "--path",
        "src/**",
        "test/**",
      ],
      tool: "search_symbol",
      arguments: {
        q: "Widget",
        include_external: true,
        limit: 5,
        paths: ["src/**", "test/**"],
      },
      safety: "read-only",
    },
    {
      command: [
        "analyze",
        "calls",
        "example.Widget.run",
        "--kind",
        "outgoing",
        "--depth",
        "2",
        "--max-children",
        "10",
        "--max-nodes",
        "50",
        "--tree-path",
        "example.Widget.run",
        "example.Widget.helper",
        "--child-offset",
        "3",
        "--analysis-timeout",
        "900",
      ],
      tool: "analyze_calls",
      arguments: {
        symbolFqn: "example.Widget.run",
        analysisKind: "OUTGOING_CALLS",
        depth: 2,
        maxChildren: 10,
        maxNodes: 50,
        treePath: ["example.Widget.run", "example.Widget.helper"],
        childOffset: 3,
        timeout: 900,
      },
      safety: "read-only",
    },
    {
      command: [
        "analyze",
        "problems",
        "src/widget.ts",
        "--errors-only",
        "--analysis-timeout",
        "800",
      ],
      tool: "get_file_problems",
      arguments: { filePath: "src/widget.ts", errorsOnly: true, timeout: 800 },
      safety: "read-only",
    },
    {
      command: ["analyze", "modules"],
      tool: "get_project_modules",
      arguments: {},
      safety: "read-only",
    },
    {
      command: ["analyze", "dependencies"],
      tool: "get_project_dependencies",
      arguments: {},
      safety: "read-only",
    },
    {
      command: ["refactor", "rename", "src/a.ts", "before", "after"],
      tool: "rename_refactoring",
      arguments: {
        pathInProject: "src/a.ts",
        symbolName: "before",
        newName: "after",
      },
      safety: "workspace-write",
    },
    {
      command: [
        "build",
        "--rebuild",
        "--file",
        "src/a.ts",
        "src/b.ts",
        "--build-timeout",
        "1000",
      ],
      tool: "build_project",
      arguments: {
        rebuild: true,
        filesToRebuild: ["src/a.ts", "src/b.ts"],
        timeout: 1000,
      },
      safety: "execution",
    },
    {
      command: ["run", "list", "--file", "src/a.ts"],
      tool: "get_run_configurations",
      arguments: { filePath: "src/a.ts" },
      safety: "read-only",
    },
    {
      command: [
        "run",
        "execute",
        "--configuration",
        "Tests",
        "--wait-for-exit",
        "--run-timeout",
        "2000",
        "--program-arguments=--focused",
        "--working-directory",
        project,
        "--env",
        "MODE=test",
      ],
      tool: "execute_run_configuration",
      arguments: {
        configurationName: "Tests",
        waitForExit: true,
        timeout: 2000,
        programArguments: "--focused",
        workingDirectory: project,
        envs: { MODE: "test" },
      },
      safety: "execution",
    },
    {
      command: ["database", "connections"],
      tool: "list_database_connections",
      arguments: {},
      safety: "database",
    },
    {
      command: [
        "database",
        "query",
        "--connection",
        "db-1",
        "--database",
        "catalog",
        "--schema",
        "public",
        "--query-file",
        queryPath,
      ],
      tool: "execute_sql_query",
      arguments: {
        connectionId: "db-1",
        databaseName: "catalog",
        schemaName: "public",
        queryText: "SELECT 1\n",
      },
      safety: "database",
    },
  ];

  try {
    for (const testCase of cases) {
      const output = parseStdout(
        runCli(["--project", project, ...testCase.command], { configPath }),
      );
      assert.deepEqual(parseEchoedCall(output), {
        tool: testCase.tool,
        arguments: testCase.arguments,
      });
      assert.equal(output.safety, testCase.safety);
      assert.equal(
        output.warning !== undefined,
        testCase.safety !== "read-only",
      );
      assert.equal(typeof output.durationMs, "number");
      assert.equal(output.target.projectPath, await realpath(project));
    }

    const minimalConfig = join(directory, "minimal.json");
    await writeMockConfig(minimalConfig, {
      intellij: { env: { MOCK_MCP_MINIMAL: "1" } },
    });
    const unavailable = runCli(
      ["--project", project, "search", "symbol", "Widget"],
      { configPath: minimalConfig },
    );
    assert.equal(unavailable.status, 1);
    assert.equal(unavailable.stdout, "");
    assert.equal(
      (JSON.parse(unavailable.stderr) as Record<string, any>).error.code,
      "TOOL_NOT_FOUND",
    );

    const changedConfig = join(directory, "changed.json");
    await writeMockConfig(changedConfig, {
      intellij: { env: { MOCK_MCP_SCHEMA_CHANGED: "1" } },
    });
    const changed = runCli(
      ["--project", project, "search", "symbol", "Widget"],
      { configPath: changedConfig },
    );
    assert.equal(changed.status, 1);
    assert.equal(
      (JSON.parse(changed.stderr) as Record<string, any>).error.code,
      "TOOL_SCHEMA_CHANGED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("success, tool errors, and request errors preserve stream and retry contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-errors-"));
  const project = join(directory, "project");
  const configPath = join(directory, "config.json");
  const daemonDirectory = join(directory, "daemon");
  await mkdir(project);
  await writeMockConfig(configPath, { intellij: {} });

  try {
    const success = parseStdout(
      runCli(
        ["--project", project, "call", "echo", "--args-json", '{"text":"ok"}'],
        { configPath },
      ),
    );
    assert.equal(success.ok, true);
    assert.equal(success.command, "call");
    assert.equal(success.safety, "read-only");

    const toolError = runCli(["--project", project, "call", "fail"], {
      configPath,
    });
    assert.equal(toolError.status, 2);
    assert.equal(toolError.stderr, "");
    const toolErrorOutput = JSON.parse(toolError.stdout) as Record<string, any>;
    assert.equal(toolErrorOutput.result.isError, true);
    assert.deepEqual(toolErrorOutput.error, {
      code: "MCP_TOOL_ERROR",
      message: "mock failure",
      retryable: false,
    });

    const directFailure = runCli(
      ["--project", project, "call", "protocol_failure"],
      { configPath },
    );
    assert.equal(directFailure.status, 1);
    assert.equal(directFailure.stdout, "");
    const directError = JSON.parse(directFailure.stderr) as Record<string, any>;
    assert.equal(directError.error.code, "MCP_REQUEST_FAILED");
    assert.equal(directError.error.retryable, false);
    assert.equal(directError.error.details.delivery, "possibly-delivered");

    const daemonOptions = {
      configPath,
      environment: { IJCTL_DAEMON_DIR: daemonDirectory },
      useDaemon: true,
    };
    const start = runCli(
      ["--project", project, "daemon", "start", "--idle-timeout", "30000"],
      daemonOptions,
    );
    assert.equal(start.status, 0, start.stderr);
    const daemonFailure = runCli(
      ["--project", project, "call", "protocol_failure"],
      daemonOptions,
    );
    assert.equal(daemonFailure.status, 1);
    assert.equal(daemonFailure.stdout, "");
    const daemonError = JSON.parse(daemonFailure.stderr) as Record<string, any>;
    assert.equal(daemonError.error.code, "MCP_REQUEST_FAILED");
    assert.equal(daemonError.error.retryable, false);
    assert.equal(daemonError.error.details.delivery, "possibly-delivered");
    assert.equal(daemonError.command, "call");

    const stop = runCli(["daemon", "stop", "--all"], daemonOptions);
    assert.equal(stop.status, 0, stop.stderr);
  } finally {
    runCli(["daemon", "stop", "--all"], {
      environment: { IJCTL_DAEMON_DIR: daemonDirectory },
      useDaemon: true,
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("skill list, install, dry-run, refresh, markers, and symlink guards are safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ijctl-skills-"));
  const project = join(directory, "project");
  const home = join(directory, "home");
  await mkdir(project);
  await mkdir(home);

  try {
    const listed = parseStdout(runCli(["--project", project, "skill", "list"]));
    assert.equal(listed.version, "0.3.0");
    assert.deepEqual(
      listed.skills.map((skill: Record<string, unknown>) => skill.name),
      [
        "intellij-code-intelligence",
        "intellij-database",
        "intellij-mcp-tools",
        "intellij-run-debug",
      ],
    );

    const dryRun = parseStdout(
      runCli([
        "--project",
        project,
        "skill",
        "install",
        "--scope",
        "project",
        "--dry-run",
      ]),
    );
    assert.equal(dryRun.results.length, 4);
    assert.ok(
      dryRun.results.every(
        (result: Record<string, unknown>) => result.action === "would-install",
      ),
    );
    await assert.rejects(access(join(project, ".github", "skills")), /ENOENT/u);

    const installed = parseStdout(
      runCli([
        "--project",
        project,
        "skill",
        "install",
        "intellij-database",
        "--scope",
        "project",
      ]),
    );
    assert.equal(installed.results[0].action, "installed");
    const destination = join(project, ".github", "skills", "intellij-database");
    const marker = JSON.parse(
      await readFile(join(destination, ".ijctl-skill.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(marker, {
      owner: "intellij-mcp-cli",
      name: "intellij-database",
      version: "0.3.0",
    });

    const overwrite = runCli([
      "--project",
      project,
      "skill",
      "install",
      "intellij-database",
      "--scope",
      "project",
    ]);
    assert.equal(overwrite.status, 1);
    assert.equal(
      (JSON.parse(overwrite.stderr) as Record<string, any>).error.code,
      "SKILL_DESTINATION_EXISTS",
    );

    const refreshed = parseStdout(
      runCli([
        "--project",
        project,
        "skill",
        "refresh",
        "intellij-database",
        "--scope",
        "project",
      ]),
    );
    assert.equal(refreshed.results[0].action, "refreshed");

    const allWithConflict = runCli([
      "--project",
      project,
      "skill",
      "install",
      "--scope",
      "project",
    ]);
    assert.equal(allWithConflict.status, 1);
    await assert.rejects(
      access(join(project, ".github", "skills", "intellij-code-intelligence")),
      /ENOENT/u,
    );

    const unmanaged = join(
      project,
      ".github",
      "skills",
      "intellij-code-intelligence",
    );
    await mkdir(unmanaged);
    await writeFile(join(unmanaged, "SKILL.md"), "manual installation\n");
    const implicitRefresh = parseStdout(
      runCli(["--project", project, "skill", "refresh", "--scope", "project"]),
    );
    assert.deepEqual(
      implicitRefresh.results.map(
        (result: Record<string, unknown>) => result.name,
      ),
      ["intellij-database"],
    );

    const unmanagedRefresh = runCli([
      "--project",
      project,
      "skill",
      "refresh",
      "intellij-code-intelligence",
      "--scope",
      "project",
    ]);
    assert.equal(unmanagedRefresh.status, 1);
    assert.equal(
      (JSON.parse(unmanagedRefresh.stderr) as Record<string, any>).error.code,
      "SKILL_NOT_MANAGED",
    );

    const userInstall = parseStdout(
      runCli(
        [
          "--project",
          project,
          "skill",
          "install",
          "intellij-mcp-tools",
          "--scope",
          "user",
        ],
        { environment: { HOME: home } },
      ),
    );
    assert.equal(userInstall.results[0].action, "installed");
    await access(
      join(home, ".copilot", "skills", "intellij-mcp-tools", "SKILL.md"),
    );

    const external = join(directory, "external");
    await mkdir(external);
    await symlink(
      external,
      join(project, ".github", "skills", "intellij-run-debug"),
      "dir",
    );
    const unsafe = runCli([
      "--project",
      project,
      "skill",
      "install",
      "intellij-run-debug",
      "--scope",
      "project",
    ]);
    assert.equal(unsafe.status, 1);
    assert.equal(
      (JSON.parse(unsafe.stderr) as Record<string, any>).error.code,
      "SKILL_PATH_UNSAFE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
