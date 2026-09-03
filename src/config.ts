import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { CliError, errorMessage } from "./errors.js";

const stringMapSchema = z.record(z.string(), z.string());

const serverEntrySchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringMapSchema.optional(),
    cwd: z.string().optional(),
    url: z.string().min(1).optional(),
    headers: stringMapSchema.optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
  })
  .passthrough()
  .superRefine((entry, context) => {
    const targetCount =
      Number(entry.command !== undefined) + Number(entry.url !== undefined);

    if (targetCount !== 1) {
      context.addIssue({
        code: "custom",
        message:
          'Each MCP server must define exactly one of "command" or "url".',
      });
    }
  });

const configFileSchema = z
  .object({
    mcpServers: z.record(z.string(), serverEntrySchema).optional(),
    servers: z.record(z.string(), serverEntrySchema).optional(),
  })
  .passthrough();

type RawServerEntry = z.infer<typeof serverEntrySchema>;

const execFileAsync = promisify(execFile);

export type HttpTransport = "streamable-http" | "sse";

export interface StdioServerConfig {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  kind: "http";
  url: string;
  headers: Record<string, string>;
  transport: HttpTransport;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface LoadedConfig {
  path: string;
  servers: Record<string, ServerConfig>;
}

export interface ResolvedServer {
  name: string;
  source: string;
  config: ServerConfig;
  project: ProjectContext;
}

export interface ResolveServerOptions {
  configPath?: string;
  serverName?: string;
  url?: string;
  transport?: HttpTransport;
  projectPath?: string;
}

export type ProjectContextSource =
  | "explicit"
  | "environment"
  | "git-root"
  | "working-directory"
  | "configuration";

export interface ProjectContext {
  path: string;
  source: ProjectContextSource;
  authoritative: boolean;
}

export interface ConfiguredInstance {
  name: string;
  kind: "stdio" | "http";
  transport: "stdio" | HttpTransport;
  projectPath: string | null;
  projectDynamic: boolean;
  port?: string;
  resolvable: boolean;
  resolutionError?: {
    code: string;
    message: string;
  };
}

export interface ConfiguredInstances {
  configurationSource: string;
  project: ProjectContext;
  instances: ConfiguredInstance[];
}

function interpolateEnvironment(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, variableName: string) => {
      const replacement = environment[variableName];
      if (replacement === undefined) {
        throw new CliError(
          `Environment variable "${variableName}" is required by the MCP configuration.`,
        );
      }

      return replacement;
    },
  );
}

function interpolateRecord(
  values: Record<string, string> | undefined,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      interpolateEnvironment(value, environment),
    ]),
  );
}

function inferHttpTransport(url: string): HttpTransport {
  return new URL(url).pathname.toLowerCase().endsWith("/sse")
    ? "sse"
    : "streamable-http";
}

function normalizeHttpTransport(
  entry: RawServerEntry,
  url: string,
): HttpTransport {
  const declaredTransport = entry.transport ?? entry.type;
  if (declaredTransport === undefined) {
    return inferHttpTransport(url);
  }

  const configuredTransport = declaredTransport.toLowerCase();

  if (
    configuredTransport === "http" ||
    configuredTransport === "streamable-http" ||
    configuredTransport === "streamable_http"
  ) {
    return "streamable-http";
  }

  if (configuredTransport === "sse") {
    return "sse";
  }

  throw new CliError(
    `Unsupported HTTP MCP transport "${configuredTransport}". Use "streamable-http" or "sse".`,
  );
}

function validateHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError(`Invalid MCP URL "${value}": ${errorMessage(error)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(
      `Unsupported MCP URL protocol "${url.protocol}". Use http or https.`,
    );
  }

  if (url.username || url.password) {
    throw new CliError(
      "Credentials must not be embedded in the MCP URL. Configure headers instead.",
    );
  }

  return url.toString();
}

function normalizeServerEntry(
  entry: RawServerEntry,
  environment: NodeJS.ProcessEnv,
  baseDirectory: string,
): ServerConfig {
  if (entry.command !== undefined) {
    const configuredType = entry.type?.toLowerCase();
    if (configuredType !== undefined && configuredType !== "stdio") {
      throw new CliError(
        `Stdio MCP server has incompatible type "${entry.type}".`,
      );
    }

    const cwd =
      entry.cwd === undefined
        ? undefined
        : resolve(
            baseDirectory,
            interpolateEnvironment(entry.cwd, environment),
          );

    return {
      kind: "stdio",
      command: interpolateEnvironment(entry.command, environment),
      args: (entry.args ?? []).map((argument) =>
        interpolateEnvironment(argument, environment),
      ),
      env: interpolateRecord(entry.env, environment),
      ...(cwd === undefined ? {} : { cwd }),
    };
  }

  if (entry.url === undefined) {
    throw new CliError("MCP server is missing a command or URL.");
  }

  const url = validateHttpUrl(interpolateEnvironment(entry.url, environment));

  return {
    kind: "http",
    url,
    headers: interpolateRecord(entry.headers, environment),
    transport: normalizeHttpTransport(entry, url),
  };
}

function parseRawConfigText(text: string): Record<string, RawServerEntry> {
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `Invalid MCP configuration JSON: ${errorMessage(error)}`,
      { code: "CONFIG_INVALID" },
    );
  }

  const parsed = configFileSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new CliError(
      `Invalid MCP configuration: ${z.prettifyError(parsed.error)}`,
      { code: "CONFIG_INVALID" },
    );
  }

  const legacyServers = parsed.data.servers ?? {};
  const standardServers = parsed.data.mcpServers ?? {};
  const duplicateNames = Object.keys(legacyServers).filter(
    (name) => standardServers[name] !== undefined,
  );

  if (duplicateNames.length > 0) {
    throw new CliError(
      `MCP server names are duplicated across "servers" and "mcpServers": ${duplicateNames.join(", ")}.`,
      {
        code: "CONFIG_INVALID",
        details: { duplicateNames },
      },
    );
  }

  const entries = { ...legacyServers, ...standardServers };
  if (Object.keys(entries).length === 0) {
    throw new CliError(
      'The MCP configuration must contain at least one entry under "mcpServers" or "servers".',
      { code: "CONFIG_INVALID" },
    );
  }

  return entries;
}

export function parseConfigText(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): Record<string, ServerConfig> {
  const entries = parseRawConfigText(text);

  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [
      name,
      normalizeServerEntry(entry, environment, baseDirectory),
    ]),
  );
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw new CliError(
      `Unable to access MCP configuration candidate "${path}": ${errorMessage(error)}`,
      { code: "CONFIG_READ_FAILED", details: { path } },
    );
  }
}

async function canonicalDirectory(
  value: string,
  workingDirectory: string,
  source: "explicit" | "environment" | "derived",
): Promise<string> {
  if (value.trim().length === 0) {
    throw new CliError("Project path must not be empty.", {
      code: "PROJECT_PATH_INVALID",
      details: { source },
    });
  }
  const absolutePath = resolve(workingDirectory, expandHome(value));
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    throw new CliError(
      `Project path "${value}" does not exist or cannot be resolved: ${errorMessage(error)}`,
      {
        code: "PROJECT_PATH_NOT_FOUND",
        details: { path: absolutePath, source },
      },
    );
  }

  let metadata;
  try {
    metadata = await stat(canonicalPath);
  } catch (error) {
    throw new CliError(
      `Unable to inspect project path "${canonicalPath}": ${errorMessage(error)}`,
      {
        code: "PROJECT_PATH_INVALID",
        details: { path: canonicalPath, source },
      },
    );
  }
  if (!metadata.isDirectory()) {
    throw new CliError(`Project path "${value}" is not a directory.`, {
      code: "PROJECT_PATH_INVALID",
      details: { path: canonicalPath, source },
    });
  }

  return canonicalPath;
}

export async function resolveProjectContext(
  explicitProjectPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<ProjectContext> {
  if (explicitProjectPath !== undefined) {
    return {
      path: await canonicalDirectory(
        explicitProjectPath,
        workingDirectory,
        "explicit",
      ),
      source: "explicit",
      authoritative: true,
    };
  }

  if (environment.IJCTL_PROJECT_PATH !== undefined) {
    return {
      path: await canonicalDirectory(
        environment.IJCTL_PROJECT_PATH,
        workingDirectory,
        "environment",
      ),
      source: "environment",
      authoritative: true,
    };
  }

  const canonicalWorkingDirectory = await canonicalDirectory(
    workingDirectory,
    workingDirectory,
    "derived",
  );
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", canonicalWorkingDirectory, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const gitRoot = stdout.trim();
    if (gitRoot.length > 0) {
      return {
        path: await canonicalDirectory(
          gitRoot,
          canonicalWorkingDirectory,
          "derived",
        ),
        source: "git-root",
        authoritative: false,
      };
    }
  } catch {
    // A non-Git working directory is a supported derived project context.
  }

  return {
    path: canonicalWorkingDirectory,
    source: "working-directory",
    authoritative: false,
  };
}

export async function findConfigPath(
  explicitPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<string> {
  const configuredPath = explicitPath ?? environment.IJCTL_CONFIG;
  if (configuredPath !== undefined) {
    return resolve(workingDirectory, expandHome(configuredPath));
  }

  const candidates = [
    resolve(workingDirectory, "ijctl.config.json"),
    join(homedir(), ".config", "ijctl", "config.json"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new CliError(
    "No MCP configuration found. Pass --config, set IJCTL_CONFIG, or create ijctl.config.json.",
    { code: "CONFIG_NOT_FOUND" },
  );
}

export async function loadConfig(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CliError(
      `Unable to read MCP configuration "${path}": ${errorMessage(error)}`,
      { code: "CONFIG_READ_FAILED", details: { path } },
    );
  }

  return {
    path,
    servers: parseConfigText(text, environment, dirname(path)),
  };
}

export function selectServer(
  loadedConfig: LoadedConfig,
  requestedName?: string,
): ResolvedServer {
  const availableNames = Object.keys(loadedConfig.servers);
  const selectedName =
    requestedName ??
    (loadedConfig.servers.intellij === undefined
      ? availableNames.length === 1
        ? availableNames[0]
        : undefined
      : "intellij");

  if (selectedName === undefined) {
    throw new CliError(
      `Multiple MCP servers are configured. Select one with --server: ${availableNames.join(", ")}.`,
      {
        code: "PROJECT_TARGET_AMBIGUOUS",
        details: { availableServers: availableNames },
      },
    );
  }

  const selectedConfig = loadedConfig.servers[selectedName];
  if (selectedConfig === undefined) {
    throw new CliError(
      `MCP server "${selectedName}" was not found. Available servers: ${availableNames.join(", ")}.`,
      {
        code: "SERVER_NOT_FOUND",
        details: {
          requestedServer: selectedName,
          availableServers: availableNames,
        },
      },
    );
  }

  return {
    name: selectedName,
    source: loadedConfig.path,
    config: selectedConfig,
    project: {
      path:
        selectedConfig.kind === "stdio" &&
        selectedConfig.env.IJ_MCP_SERVER_PROJECT_PATH !== undefined
          ? resolve(selectedConfig.env.IJ_MCP_SERVER_PROJECT_PATH)
          : process.cwd(),
      source: "configuration",
      authoritative: false,
    },
  };
}

async function readRawConfig(
  path: string,
): Promise<Record<string, RawServerEntry>> {
  try {
    return parseRawConfigText(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      `Unable to read MCP configuration "${path}": ${errorMessage(error)}`,
      { code: "CONFIG_READ_FAILED", details: { path } },
    );
  }
}

function rawProjectTemplate(entry: RawServerEntry): string | undefined {
  return entry.env?.IJ_MCP_SERVER_PROJECT_PATH;
}

function isDynamicProjectTemplate(value: string | undefined): boolean {
  return value?.includes("${IJCTL_PROJECT_PATH}") ?? false;
}

async function resolvedCandidateProject(
  entry: RawServerEntry,
  environment: NodeJS.ProcessEnv,
  baseDirectory: string,
): Promise<string | undefined> {
  const template = rawProjectTemplate(entry);
  if (template === undefined) {
    return undefined;
  }
  const interpolated = interpolateEnvironment(template, environment);
  return canonicalDirectory(interpolated, baseDirectory, "derived");
}

function legacySelectedName(
  entries: Record<string, RawServerEntry>,
  requestedName?: string,
): string {
  const availableNames = Object.keys(entries);
  const selectedName =
    requestedName ??
    (entries.intellij === undefined
      ? availableNames.length === 1
        ? availableNames[0]
        : undefined
      : "intellij");
  if (selectedName === undefined) {
    throw new CliError(
      `Multiple MCP servers are configured. Select one with --server: ${availableNames.join(", ")}.`,
      {
        code: "PROJECT_TARGET_AMBIGUOUS",
        details: { availableServers: availableNames },
      },
    );
  }
  if (entries[selectedName] === undefined) {
    throw new CliError(
      `MCP server "${selectedName}" was not found. Available servers: ${availableNames.join(", ")}.`,
      {
        code: "SERVER_NOT_FOUND",
        details: {
          requestedServer: selectedName,
          availableServers: availableNames,
        },
      },
    );
  }
  return selectedName;
}

async function selectRawServerName(
  entries: Record<string, RawServerEntry>,
  requestedName: string | undefined,
  context: ProjectContext,
  environment: NodeJS.ProcessEnv,
  baseDirectory: string,
): Promise<string> {
  const availableNames = Object.keys(entries);
  if (requestedName !== undefined) {
    const entry = entries[requestedName];
    if (entry === undefined) {
      throw new CliError(
        `MCP server "${requestedName}" was not found. Available servers: ${availableNames.join(", ")}.`,
        {
          code: "SERVER_NOT_FOUND",
          details: {
            requestedServer: requestedName,
            availableServers: availableNames,
          },
        },
      );
    }

    if (context.authoritative && rawProjectTemplate(entry) !== undefined) {
      const configuredProject = await resolvedCandidateProject(
        entry,
        environment,
        baseDirectory,
      );
      if (configuredProject !== context.path) {
        throw new CliError(
          `MCP server "${requestedName}" targets "${configuredProject}", not requested project "${context.path}".`,
          {
            code: "PROJECT_TARGET_MISMATCH",
            details: {
              server: requestedName,
              configuredProject,
              requestedProject: context.path,
            },
          },
        );
      }
    }
    return requestedName;
  }

  const matches: string[] = [];
  const projectBoundNames: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (rawProjectTemplate(entry) === undefined) {
      continue;
    }
    projectBoundNames.push(name);
    try {
      if (
        (await resolvedCandidateProject(entry, environment, baseDirectory)) ===
        context.path
      ) {
        matches.push(name);
      }
    } catch {
      // Unresolvable candidates are reported by `instances`; they cannot match.
    }
  }

  if (matches.length === 1) {
    return matches[0] as string;
  }
  if (matches.length > 1) {
    throw new CliError(
      `Multiple MCP servers target project "${context.path}": ${matches.join(", ")}. Select one with --server.`,
      {
        code: "PROJECT_TARGET_AMBIGUOUS",
        details: { project: context.path, matchingServers: matches },
      },
    );
  }
  if (context.authoritative && projectBoundNames.length > 0) {
    throw new CliError(
      `No configured MCP server targets project "${context.path}".`,
      {
        code: "PROJECT_TARGET_MISMATCH",
        details: {
          project: context.path,
          candidateServers: projectBoundNames,
        },
      },
    );
  }

  return legacySelectedName(entries);
}

export async function loadConfiguredInstances(
  options: Pick<ResolveServerOptions, "configPath" | "projectPath">,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<ConfiguredInstances> {
  const project = await resolveProjectContext(
    options.projectPath,
    environment,
    workingDirectory,
  );
  const configPath = await findConfigPath(
    options.configPath,
    environment,
    workingDirectory,
  );
  const entries = await readRawConfig(configPath);
  const effectiveEnvironment = {
    ...environment,
    IJCTL_PROJECT_PATH: project.path,
  };
  const baseDirectory = dirname(configPath);
  const instances: ConfiguredInstance[] = [];

  for (const [name, entry] of Object.entries(entries).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const template = rawProjectTemplate(entry);
    let projectPath: string | null = template ?? null;
    let resolvable = true;
    let resolutionError: ConfiguredInstance["resolutionError"];
    try {
      const resolvedProject = await resolvedCandidateProject(
        entry,
        effectiveEnvironment,
        baseDirectory,
      );
      projectPath = resolvedProject ?? null;
      normalizeServerEntry(entry, effectiveEnvironment, baseDirectory);
    } catch (error) {
      resolvable = false;
      projectPath = template ?? null;
      resolutionError = {
        code: error instanceof CliError ? error.code : "CONFIG_INVALID",
        message: errorMessage(error),
      };
    }

    const kind = entry.command === undefined ? "http" : "stdio";
    let transport: "stdio" | HttpTransport = "stdio";
    if (kind === "http" && entry.url !== undefined) {
      try {
        const interpolatedUrl = interpolateEnvironment(
          entry.url,
          effectiveEnvironment,
        );
        transport = normalizeHttpTransport(entry, interpolatedUrl);
      } catch {
        transport = "streamable-http";
      }
    }
    instances.push({
      name,
      kind,
      transport,
      projectPath,
      projectDynamic: isDynamicProjectTemplate(template),
      ...(entry.env?.IJ_MCP_SERVER_PORT === undefined
        ? {}
        : { port: entry.env.IJ_MCP_SERVER_PORT }),
      resolvable,
      ...(resolutionError === undefined ? {} : { resolutionError }),
    });
  }

  return {
    configurationSource: configPath,
    project,
    instances,
  };
}

export async function resolveServer(
  options: ResolveServerOptions,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<ResolvedServer> {
  const project = await resolveProjectContext(
    options.projectPath,
    environment,
    workingDirectory,
  );
  if (options.url !== undefined) {
    if (options.configPath !== undefined || options.serverName !== undefined) {
      throw new CliError(
        "--url cannot be combined with --config or --server.",
        {
          code: "CONFIG_INVALID",
        },
      );
    }

    return {
      name: "intellij",
      source: "command line",
      config: {
        kind: "http",
        url: validateHttpUrl(options.url),
        headers: {},
        transport: options.transport ?? inferHttpTransport(options.url),
      },
      project,
    };
  }

  const configPath = await findConfigPath(
    options.configPath,
    environment,
    workingDirectory,
  );
  const entries = await readRawConfig(configPath);
  const effectiveEnvironment = {
    ...environment,
    IJCTL_PROJECT_PATH: project.path,
  };
  const selectedName = await selectRawServerName(
    entries,
    options.serverName,
    project,
    effectiveEnvironment,
    dirname(configPath),
  );
  const selectedConfig = normalizeServerEntry(
    entries[selectedName] as RawServerEntry,
    effectiveEnvironment,
    dirname(configPath),
  );
  const selectedProject =
    selectedConfig.kind === "stdio" &&
    selectedConfig.env.IJ_MCP_SERVER_PROJECT_PATH !== undefined
      ? {
          path: await canonicalDirectory(
            selectedConfig.env.IJ_MCP_SERVER_PROJECT_PATH,
            dirname(configPath),
            "derived",
          ),
          source: isDynamicProjectTemplate(
            rawProjectTemplate(entries[selectedName] as RawServerEntry),
          )
            ? project.source
            : ("configuration" as const),
          authoritative: project.authoritative,
        }
      : project;
  const selected: ResolvedServer = {
    name: selectedName,
    source: configPath,
    config: selectedConfig,
    project: selectedProject,
  };

  if (options.transport !== undefined) {
    if (selected.config.kind !== "http") {
      throw new CliError(
        "--transport can only override an HTTP MCP server configuration.",
        { code: "CONFIG_INVALID" },
      );
    }

    selected.config.transport = options.transport;
  }

  return selected;
}
