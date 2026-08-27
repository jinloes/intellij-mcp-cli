import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
}

export interface ResolveServerOptions {
  configPath?: string;
  serverName?: string;
  url?: string;
  transport?: HttpTransport;
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

export function parseConfigText(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): Record<string, ServerConfig> {
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `Invalid MCP configuration JSON: ${errorMessage(error)}`,
    );
  }

  const parsed = configFileSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new CliError(
      `Invalid MCP configuration: ${z.prettifyError(parsed.error)}`,
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
    );
  }

  const entries = { ...legacyServers, ...standardServers };
  if (Object.keys(entries).length === 0) {
    throw new CliError(
      'The MCP configuration must contain at least one entry under "mcpServers" or "servers".',
    );
  }

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
    );
  }
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
    );
  }

  const selectedConfig = loadedConfig.servers[selectedName];
  if (selectedConfig === undefined) {
    throw new CliError(
      `MCP server "${selectedName}" was not found. Available servers: ${availableNames.join(", ")}.`,
    );
  }

  return {
    name: selectedName,
    source: loadedConfig.path,
    config: selectedConfig,
  };
}

export async function resolveServer(
  options: ResolveServerOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedServer> {
  if (options.url !== undefined) {
    if (options.configPath !== undefined || options.serverName !== undefined) {
      throw new CliError("--url cannot be combined with --config or --server.");
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
    };
  }

  const configPath = await findConfigPath(options.configPath, environment);
  const selected = selectServer(
    await loadConfig(configPath, environment),
    options.serverName,
  );

  if (options.transport !== undefined) {
    if (selected.config.kind !== "http") {
      throw new CliError(
        "--transport can only override an HTTP MCP server configuration.",
      );
    }

    selected.config.transport = options.transport;
  }

  return selected;
}
