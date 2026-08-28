import { fork } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  isCallToolResult,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";

import type { ResolvedServer } from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import {
  callTool,
  connectToServer,
  connectionDetails,
  listTools,
  type McpConnectionDetails,
} from "./mcp.js";

const DAEMON_PROTOCOL_VERSION = 1;
const DAEMON_HOST = "127.0.0.1";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const DAEMON_REQUEST_READ_TIMEOUT = 5_000;
const DAEMON_RESPONSE_WRITE_TIMEOUT = 1_000;
const DAEMON_RESPONSE_GRACE = 250;
const START_LOCK_STALE_MS = 120_000;

export const DEFAULT_DAEMON_IDLE_TIMEOUT = 15 * 60_000;
export const MAX_TIMER_DELAY = 2_147_483_647;

interface DaemonPaths {
  identity: string;
  directory: string;
  state: string;
  lock: string;
}

interface DaemonState {
  protocolVersion: number;
  identity: string;
  host: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  idleTimeout: number;
}

export interface DaemonInfo {
  pid: number;
  server: string;
  configurationSource: string;
  startedAt: string;
  lastUsedAt: string;
  idleTimeout: number;
  connection: McpConnectionDetails;
}

export interface DaemonDoctorResult {
  info: DaemonInfo;
  toolCount: number;
}

interface DaemonRequestBase {
  protocolVersion: number;
  id: string;
  token: string;
  timeout: number;
}

interface DaemonStatusRequest extends DaemonRequestBase {
  method: "status";
}

interface DaemonDoctorRequest extends DaemonRequestBase {
  method: "doctor";
}

interface DaemonToolsRequest extends DaemonRequestBase {
  method: "tools";
}

interface DaemonCallRequest extends DaemonRequestBase {
  method: "call";
  tool: string;
  arguments: Record<string, unknown>;
}

interface DaemonShutdownRequest extends DaemonRequestBase {
  method: "shutdown";
}

type DaemonRequest =
  | DaemonStatusRequest
  | DaemonDoctorRequest
  | DaemonToolsRequest
  | DaemonCallRequest
  | DaemonShutdownRequest;

type DaemonRequestValue =
  | { method: "status" }
  | { method: "doctor" }
  | { method: "tools" }
  | {
      method: "call";
      tool: string;
      arguments: Record<string, unknown>;
    }
  | { method: "shutdown" };

interface DaemonSuccessResponse {
  protocolVersion: number;
  id: string;
  ok: true;
  result: unknown;
}

interface DaemonErrorResponse {
  protocolVersion: number;
  id: string;
  ok: false;
  error: {
    message: string;
    exitCode: number;
  };
}

type DaemonResponse = DaemonSuccessResponse | DaemonErrorResponse;

interface DaemonReadyMessage {
  type: "ready";
  identity: string;
  info: DaemonInfo;
}

interface DaemonStartupErrorMessage {
  type: "error";
  message: string;
}

type DaemonStartupMessage = DaemonReadyMessage | DaemonStartupErrorMessage;

class DaemonUnavailableError extends Error {
  constructor() {
    super("The ijctl daemon is not running.");
    this.name = "DaemonUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(
  error: unknown,
  ...codes: string[]
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

function daemonIdentity(server: ResolvedServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
          server,
        }),
      ),
    )
    .digest("hex")
    .slice(0, 24);
}

function daemonDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.IJCTL_DAEMON_DIR !== undefined) {
    return resolve(environment.IJCTL_DAEMON_DIR);
  }

  const userIdentity =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : createHash("sha256")
          .update(environment.USERPROFILE ?? environment.HOME ?? "unknown")
          .digest("hex")
          .slice(0, 12);

  return join(tmpdir(), `ijctl-${userIdentity}`);
}

function daemonPaths(
  server: ResolvedServer,
  environment: NodeJS.ProcessEnv = process.env,
): DaemonPaths {
  return daemonPathsForIdentity(daemonIdentity(server), environment);
}

function daemonPathsForIdentity(
  identity: string,
  environment: NodeJS.ProcessEnv,
): DaemonPaths {
  const directory = daemonDirectory(environment);
  return {
    identity,
    directory,
    state: join(directory, `${identity}.json`),
    lock: join(directory, `${identity}.lock`),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const createdPath = await mkdir(path, { recursive: true, mode: 0o700 });
  let details = await lstat(path);

  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new CliError(`Daemon runtime path "${path}" is not a directory.`);
  }

  if (
    typeof process.getuid === "function" &&
    details.uid !== process.getuid()
  ) {
    throw new CliError(
      `Daemon runtime directory "${path}" is not owned by the current user.`,
    );
  }

  if (process.platform !== "win32") {
    if (createdPath !== undefined) {
      await chmod(path, 0o700);
      details = await lstat(path);
    }
    if ((details.mode & 0o077) !== 0) {
      throw new CliError(
        `Daemon runtime directory "${path}" has unsafe permissions; expected 0700.`,
      );
    }
  }
}

function isDaemonState(value: unknown, identity: string): value is DaemonState {
  return (
    isRecord(value) &&
    value.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    value.identity === identity &&
    value.host === DAEMON_HOST &&
    typeof value.port === "number" &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{64}$/u.test(value.token) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    typeof value.idleTimeout === "number" &&
    Number.isSafeInteger(value.idleTimeout) &&
    value.idleTimeout > 0
  );
}

async function readDaemonState(
  paths: DaemonPaths,
): Promise<DaemonState | undefined> {
  let details;
  try {
    details = await lstat(paths.state);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return undefined;
    }
    throw new CliError(
      `Unable to inspect daemon state "${paths.state}": ${errorMessage(error)}`,
    );
  }

  if (!details.isFile() || details.isSymbolicLink()) {
    throw new CliError(`Daemon state "${paths.state}" is not a regular file.`);
  }

  if (
    typeof process.getuid === "function" &&
    details.uid !== process.getuid()
  ) {
    throw new CliError(
      `Daemon state "${paths.state}" is not owned by the current user.`,
    );
  }

  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new CliError(
      `Daemon state "${paths.state}" has unsafe permissions; expected 0600.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.state, "utf8"));
  } catch (error) {
    throw new CliError(
      `Unable to read daemon state "${paths.state}": ${errorMessage(error)}`,
    );
  }

  if (!isDaemonState(parsed, paths.identity)) {
    throw new CliError(`Daemon state "${paths.state}" is invalid.`);
  }

  if (!processIsRunning(parsed.pid)) {
    try {
      await unlink(paths.state);
    } catch (error) {
      if (!isErrnoException(error, "ENOENT")) {
        throw new CliError(
          `Unable to remove stale daemon state "${paths.state}": ${errorMessage(error)}`,
        );
      }
    }
    return undefined;
  }

  return parsed;
}

async function writeDaemonState(
  paths: DaemonPaths,
  state: DaemonState,
): Promise<void> {
  const temporaryPath = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  try {
    if (process.platform !== "win32") {
      await chmod(temporaryPath, 0o600);
    }
    await rename(temporaryPath, paths.state);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrnoException(cleanupError, "ENOENT")) {
        throw new CliError(
          `Unable to publish daemon state "${paths.state}": ${errorMessage(error)}. Temporary state cleanup also failed: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw new CliError(
      `Unable to publish daemon state "${paths.state}": ${errorMessage(error)}`,
    );
  }
}

async function removeDaemonState(
  paths: DaemonPaths,
  expected: Pick<DaemonState, "pid" | "token">,
): Promise<void> {
  const current = await readDaemonState(paths);

  if (
    current === undefined ||
    current.pid !== expected.pid ||
    current.token !== expected.token
  ) {
    return;
  }

  try {
    await unlink(paths.state);
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      throw new CliError(
        `Unable to remove daemon state "${paths.state}": ${errorMessage(error)}`,
      );
    }
  }
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.server === "string" &&
    typeof value.configurationSource === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.lastUsedAt === "string" &&
    typeof value.idleTimeout === "number" &&
    Number.isSafeInteger(value.idleTimeout) &&
    value.idleTimeout > 0 &&
    isRecord(value.connection) &&
    typeof value.connection.transport === "string"
  );
}

function isDaemonDoctorResult(value: unknown): value is DaemonDoctorResult {
  return (
    isRecord(value) &&
    isDaemonInfo(value.info) &&
    typeof value.toolCount === "number" &&
    Number.isSafeInteger(value.toolCount) &&
    value.toolCount >= 0
  );
}

function isTool(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isRecord(value.inputSchema)
  );
}

function isToolList(value: unknown): value is Tool[] {
  return Array.isArray(value) && value.every(isTool);
}

function isShutdownResult(value: unknown): value is { stopping: true } {
  return isRecord(value) && value.stopping === true;
}

function parseDaemonResponse(
  value: unknown,
  requestId: string,
): DaemonResponse {
  if (
    !isRecord(value) ||
    value.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
    value.id !== requestId ||
    typeof value.ok !== "boolean"
  ) {
    throw new CliError("The ijctl daemon returned an invalid response.");
  }

  if (value.ok) {
    if (!("result" in value)) {
      throw new CliError("The ijctl daemon response is missing a result.");
    }
    return {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      id: requestId,
      ok: true,
      result: value.result,
    };
  }

  if (
    !isRecord(value.error) ||
    typeof value.error.message !== "string" ||
    typeof value.error.exitCode !== "number"
  ) {
    throw new CliError("The ijctl daemon returned an invalid error response.");
  }

  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    id: requestId,
    ok: false,
    error: {
      message: value.error.message,
      exitCode: value.error.exitCode,
    },
  };
}

function exchangeWithDaemon(
  state: DaemonState,
  request: DaemonRequest,
  timeout: number,
): Promise<DaemonResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({
      host: state.host,
      port: state.port,
    });
    socket.setEncoding("utf8");
    socket.setNoDelay(true);

    let connected = false;
    let settled = false;
    let receivedBytes = 0;
    let buffer = "";

    const timer = setTimeout(() => {
      fail(
        new CliError(
          `Timed out waiting for the ijctl daemon after ${timeout}ms.`,
        ),
      );
    }, timeout);

    function finish(response: DaemonResponse): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolvePromise(response);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    }

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          fail(
            new CliError(
              `Unable to send a request to the ijctl daemon: ${errorMessage(error)}`,
            ),
          );
        }
      });
    });

    socket.on("data", (chunk: string) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_MESSAGE_BYTES) {
        fail(new CliError("The ijctl daemon response exceeded 64 MiB."));
        return;
      }

      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      try {
        finish(
          parseDaemonResponse(JSON.parse(buffer.slice(0, newline)), request.id),
        );
      } catch (error) {
        fail(error);
      }
    });

    socket.once("error", (error) => {
      if (
        !connected &&
        isErrnoException(error, "ECONNREFUSED", "ENOENT", "EHOSTUNREACH")
      ) {
        fail(new DaemonUnavailableError());
        return;
      }

      fail(
        new CliError(
          `Unable to communicate with the ijctl daemon: ${errorMessage(error)}`,
        ),
      );
    });

    socket.once("close", () => {
      if (!settled) {
        fail(
          new CliError(
            "The ijctl daemon closed the connection without a response.",
          ),
        );
      }
    });
  });
}

async function sendDaemonRequest<T>(
  server: ResolvedServer,
  timeout: number,
  requestValue: DaemonRequestValue,
  validateResult: (value: unknown) => value is T,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T | undefined> {
  const paths = daemonPaths(server, environment);
  const state = await readDaemonState(paths);
  if (state === undefined) {
    return undefined;
  }

  return requestKnownDaemon(
    paths,
    state,
    timeout,
    requestValue,
    validateResult,
  );
}

export async function daemonStatus(
  server: ResolvedServer,
  timeout: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonInfo | undefined> {
  return sendDaemonRequest(
    server,
    timeout,
    { method: "status" },
    isDaemonInfo,
    environment,
  );
}

export async function daemonDoctor(
  server: ResolvedServer,
  timeout: number,
): Promise<DaemonDoctorResult | undefined> {
  return sendDaemonRequest(
    server,
    timeout,
    { method: "doctor" },
    isDaemonDoctorResult,
  );
}

export async function daemonTools(
  server: ResolvedServer,
  timeout: number,
): Promise<Tool[] | undefined> {
  return sendDaemonRequest(server, timeout, { method: "tools" }, isToolList);
}

export async function daemonCall(
  server: ResolvedServer,
  tool: string,
  argumentsValue: Record<string, unknown>,
  timeout: number,
): Promise<CallToolResult | undefined> {
  return sendDaemonRequest(
    server,
    timeout,
    {
      method: "call",
      tool,
      arguments: argumentsValue,
    },
    isCallToolResult,
  );
}

export async function stopDaemon(
  server: ResolvedServer,
  timeout: number,
): Promise<boolean> {
  const result = await sendDaemonRequest(
    server,
    timeout,
    { method: "shutdown" },
    isShutdownResult,
  );
  return result !== undefined;
}

export async function listDaemons(
  timeout: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonInfo[]> {
  const daemons: DaemonInfo[] = [];
  for (const { paths, state } of await listDaemonStates(environment)) {
    const info = await requestKnownDaemon(
      paths,
      state,
      timeout,
      { method: "status" },
      isDaemonInfo,
    );
    if (info !== undefined) {
      daemons.push(info);
    }
  }
  return daemons;
}

export async function stopAllDaemons(
  timeout: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let stopped = 0;
  for (const { paths, state } of await listDaemonStates(environment)) {
    const result = await requestKnownDaemon(
      paths,
      state,
      timeout,
      { method: "shutdown" },
      isShutdownResult,
    );
    if (result !== undefined) {
      stopped += 1;
    }
  }
  return stopped;
}

function parseDaemonRequest(value: unknown): DaemonRequest {
  if (
    !isRecord(value) ||
    value.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
    typeof value.id !== "string" ||
    typeof value.token !== "string" ||
    typeof value.timeout !== "number" ||
    !Number.isSafeInteger(value.timeout) ||
    value.timeout <= 0 ||
    typeof value.method !== "string"
  ) {
    throw new CliError("Invalid daemon request.");
  }

  const base = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    id: value.id,
    token: value.token,
    timeout: value.timeout,
  };

  switch (value.method) {
    case "status":
    case "doctor":
    case "tools":
    case "shutdown":
      return { ...base, method: value.method };
    case "call":
      if (
        typeof value.tool !== "string" ||
        value.tool.length === 0 ||
        !isRecord(value.arguments)
      ) {
        throw new CliError("Invalid daemon tool call.");
      }
      return {
        ...base,
        method: "call",
        tool: value.tool,
        arguments: value.arguments,
      };
    default:
      throw new CliError(`Unsupported daemon method "${value.method}".`);
  }
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function writeSocketResponse(
  socket: Socket,
  response: DaemonResponse,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handleError = (error: Error) => {
      rejectPromise(error);
    };
    socket.once("error", handleError);
    socket.setTimeout(DAEMON_RESPONSE_WRITE_TIMEOUT, () => {
      socket.destroy();
    });
    socket.end(`${JSON.stringify(response)}\n`, () => {
      socket.off("error", handleError);
      resolvePromise();
    });
  });
}

async function listDaemonStates(
  environment: NodeJS.ProcessEnv,
): Promise<Array<{ paths: DaemonPaths; state: DaemonState }>> {
  const directory = daemonDirectory(environment);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return [];
    }
    throw new CliError(
      `Unable to list daemon runtime directory "${directory}": ${errorMessage(error)}`,
    );
  }

  const states: Array<{ paths: DaemonPaths; state: DaemonState }> = [];
  for (const entry of entries) {
    const match = /^([a-f0-9]{24})\.json$/u.exec(entry.name);
    if (!entry.isFile() || match?.[1] === undefined) {
      continue;
    }

    const paths = daemonPathsForIdentity(match[1], environment);
    const state = await readDaemonState(paths);
    if (state !== undefined) {
      states.push({ paths, state });
    }
  }

  return states;
}

async function requestKnownDaemon<T>(
  paths: DaemonPaths,
  state: DaemonState,
  timeout: number,
  requestValue: DaemonRequestValue,
  validateResult: (value: unknown) => value is T,
): Promise<T | undefined> {
  const base = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    id: randomUUID(),
    token: state.token,
    timeout,
  };
  const request: DaemonRequest =
    requestValue.method === "call"
      ? {
          ...base,
          method: "call",
          tool: requestValue.tool,
          arguments: requestValue.arguments,
        }
      : {
          ...base,
          method: requestValue.method,
        };

  let response: DaemonResponse;
  try {
    response = await exchangeWithDaemon(
      state,
      request,
      Math.min(MAX_TIMER_DELAY, timeout + DAEMON_RESPONSE_GRACE),
    );
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      await removeDaemonState(paths, state);
      return undefined;
    }
    throw error;
  }

  if (!response.ok) {
    throw new CliError(response.error.message, response.error.exitCode);
  }

  if (!validateResult(response.result)) {
    throw new CliError("The ijctl daemon returned an invalid result.");
  }

  return response.result;
}

async function listenOnLoopback(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, DAEMON_HOST, () => {
      server.off("error", rejectPromise);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new CliError("Unable to determine daemon TCP address."));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function daemonInfo(
  server: ResolvedServer,
  connection: McpConnectionDetails,
  startedAt: string,
  lastUsedAt: string,
  idleTimeout: number,
): DaemonInfo {
  return {
    pid: process.pid,
    server: server.name,
    configurationSource: server.source,
    startedAt,
    lastUsedAt,
    idleTimeout,
    connection,
  };
}

export async function runDaemon(
  resolvedServer: ResolvedServer,
  connectionTimeout: number,
  idleTimeout: number,
  notifyReady: (message: DaemonReadyMessage) => void,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = daemonPaths(resolvedServer, environment);
  await ensurePrivateDirectory(paths.directory);

  const connection = await connectToServer(resolvedServer, connectionTimeout);
  const details = connectionDetails(connection);
  const token = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  let lastUsedAt = startedAt;
  let activeRequests = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let resolveLifetime: (() => void) | undefined;
  let lifetimeFailure: { error: unknown } | undefined;
  const sockets = new Set<Socket>();

  const lifetime = new Promise<void>((resolvePromise) => {
    resolveLifetime = resolvePromise;
  });

  const tcpServer = createServer();
  let port: number;
  try {
    port = await listenOnLoopback(tcpServer);
  } catch (error) {
    await connection.client.close();
    throw error;
  }
  const state: DaemonState = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    identity: paths.identity,
    host: DAEMON_HOST,
    port,
    token,
    pid: process.pid,
    startedAt,
    idleTimeout,
  };

  async function shutdown(error?: unknown): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (error !== undefined) {
      lifetimeFailure = { error };
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }

    const serverClosed = new Promise<void>((resolvePromise) => {
      tcpServer.close(() => resolvePromise());
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await serverClosed;

    try {
      await connection.client.close();
    } catch (closeError) {
      if (lifetimeFailure === undefined) {
        lifetimeFailure = { error: closeError };
      }
    }

    try {
      await removeDaemonState(paths, state);
    } catch (stateError) {
      if (lifetimeFailure === undefined) {
        lifetimeFailure = { error: stateError };
      }
    }

    resolveLifetime?.();
  }

  function scheduleIdleShutdown(): void {
    if (shuttingDown || activeRequests > 0) {
      return;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      void shutdown();
    }, idleTimeout);
  }

  tcpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.setTimeout(DAEMON_REQUEST_READ_TIMEOUT, () => {
      socket.destroy();
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });

    let handled = false;
    let receivedBytes = 0;
    let buffer = "";

    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_MESSAGE_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }

      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      handled = true;

      void (async () => {
        let requestId = "";
        let request: DaemonRequest;
        try {
          const rawRequest: unknown = JSON.parse(buffer.slice(0, newline));
          if (isRecord(rawRequest) && typeof rawRequest.id === "string") {
            requestId = rawRequest.id;
          }
          request = parseDaemonRequest(rawRequest);
          if (!tokensMatch(request.token, token)) {
            throw new CliError("Daemon authentication failed.");
          }
          socket.setTimeout(
            Math.min(MAX_TIMER_DELAY, request.timeout + DAEMON_RESPONSE_GRACE),
            () => {
              socket.destroy();
            },
          );
        } catch (error) {
          await writeSocketResponse(socket, {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            id: requestId,
            ok: false,
            error: {
              message: errorMessage(error),
              exitCode: error instanceof CliError ? error.exitCode : 1,
            },
          });
          return;
        }

        activeRequests += 1;
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        lastUsedAt = new Date().toISOString();

        try {
          let result: unknown;
          switch (request.method) {
            case "status":
              result = daemonInfo(
                resolvedServer,
                details,
                startedAt,
                lastUsedAt,
                idleTimeout,
              );
              break;
            case "doctor":
              result = {
                info: daemonInfo(
                  resolvedServer,
                  details,
                  startedAt,
                  lastUsedAt,
                  idleTimeout,
                ),
                toolCount: (await listTools(connection, request.timeout))
                  .length,
              } satisfies DaemonDoctorResult;
              break;
            case "tools":
              result = await listTools(connection, request.timeout);
              break;
            case "call":
              result = await callTool(
                connection,
                request.tool,
                request.arguments,
                request.timeout,
              );
              break;
            case "shutdown":
              result = { stopping: true };
              break;
          }

          await writeSocketResponse(socket, {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result,
          });

          if (request.method === "shutdown") {
            void shutdown();
          }
        } catch (error) {
          await writeSocketResponse(socket, {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            id: request.id,
            ok: false,
            error: {
              message: errorMessage(error),
              exitCode: error instanceof CliError ? error.exitCode : 1,
            },
          });
        } finally {
          activeRequests -= 1;
          lastUsedAt = new Date().toISOString();
          scheduleIdleShutdown();
        }
      })().catch(() => {
        socket.destroy();
      });
    });
  });

  tcpServer.on("error", (error) => {
    void shutdown(error);
  });
  connection.client.onclose = () => {
    if (!shuttingDown) {
      void shutdown();
    }
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  try {
    await writeDaemonState(paths, state);
    notifyReady({
      type: "ready",
      identity: paths.identity,
      info: daemonInfo(
        resolvedServer,
        details,
        startedAt,
        lastUsedAt,
        idleTimeout,
      ),
    });
    scheduleIdleShutdown();
    await lifetime;
    if (lifetimeFailure !== undefined) {
      throw lifetimeFailure.error;
    }
  } catch (error) {
    await shutdown(error);
    throw error;
  }
}

function isDaemonStartupMessage(value: unknown): value is DaemonStartupMessage {
  return (
    isRecord(value) &&
    ((value.type === "ready" &&
      typeof value.identity === "string" &&
      isDaemonInfo(value.info)) ||
      (value.type === "error" && typeof value.message === "string"))
  );
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error, "ESRCH")) {
      return false;
    }
    if (isErrnoException(error, "EPERM")) {
      return true;
    }
    throw new CliError(
      `Unable to inspect daemon startup process ${pid}: ${errorMessage(error)}`,
    );
  }
}

async function acquireStartLock(
  paths: DaemonPaths,
  timeout: number,
): Promise<FileHandle> {
  const deadline = Date.now() + timeout;

  while (true) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch (error) {
      if (!isErrnoException(error, "EEXIST")) {
        throw new CliError(
          `Unable to acquire daemon start lock "${paths.lock}": ${errorMessage(error)}`,
        );
      }
    }

    let stale = false;
    try {
      const details = await lstat(paths.lock);
      const lockPid = Number((await readFile(paths.lock, "utf8")).trim());
      stale =
        Number.isSafeInteger(lockPid) && lockPid > 0
          ? !processIsRunning(lockPid)
          : Date.now() - details.mtimeMs > START_LOCK_STALE_MS;
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        continue;
      }
      throw new CliError(
        `Unable to inspect daemon start lock "${paths.lock}": ${errorMessage(error)}`,
      );
    }

    if (stale) {
      try {
        await unlink(paths.lock);
        continue;
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) {
          continue;
        }
        throw new CliError(
          `Unable to remove stale daemon start lock "${paths.lock}": ${errorMessage(error)}`,
        );
      }
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        `Timed out waiting for another ijctl daemon startup after ${timeout}ms.`,
      );
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function releaseStartLock(
  paths: DaemonPaths,
  handle: FileHandle,
): Promise<void> {
  await handle.close();
  try {
    await unlink(paths.lock);
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      throw new CliError(
        `Unable to release daemon start lock "${paths.lock}": ${errorMessage(error)}`,
      );
    }
  }
}

export async function startDaemon(
  server: ResolvedServer,
  entryPath: string,
  childArguments: string[],
  timeout: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ info: DaemonInfo; reused: boolean }> {
  const existing = await daemonStatus(server, timeout, environment);
  if (existing !== undefined) {
    return { info: existing, reused: true };
  }

  const paths = daemonPaths(server, environment);
  await ensurePrivateDirectory(paths.directory);
  const lock = await acquireStartLock(paths, timeout);

  try {
    const racedExisting = await daemonStatus(server, timeout, environment);
    if (racedExisting !== undefined) {
      return { info: racedExisting, reused: true };
    }

    const child = fork(entryPath, childArguments, {
      detached: true,
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    const message = await new Promise<DaemonStartupMessage>(
      (resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          rejectPromise(
            new CliError(
              `Timed out starting the ijctl daemon after ${timeout}ms.`,
            ),
          );
        }, timeout);

        child.once("message", (value: unknown) => {
          clearTimeout(timer);
          if (!isDaemonStartupMessage(value)) {
            child.kill("SIGTERM");
            rejectPromise(
              new CliError("The ijctl daemon sent an invalid startup message."),
            );
            return;
          }
          resolvePromise(value);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          rejectPromise(
            new CliError(`Unable to start the ijctl daemon: ${error.message}`),
          );
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          rejectPromise(
            new CliError(
              `The ijctl daemon exited during startup (code ${String(code)}, signal ${String(signal)}).`,
            ),
          );
        });
      },
    );

    if (child.connected) {
      child.disconnect();
    }
    child.unref();

    if (message.type === "error") {
      const racedDaemon = await daemonStatus(server, timeout, environment);
      if (racedDaemon !== undefined) {
        return { info: racedDaemon, reused: true };
      }
      throw new CliError(
        `Unable to start the ijctl daemon: ${message.message}`,
      );
    }

    if (message.identity !== paths.identity) {
      child.kill("SIGTERM");
      throw new CliError(
        "The MCP configuration changed while the ijctl daemon was starting.",
      );
    }

    return { info: message.info, reused: false };
  } finally {
    await releaseStartLock(paths, lock);
  }
}

export function notifyDaemonStartupError(error: unknown): void {
  if (process.send === undefined || !process.connected) {
    return;
  }
  process.send({
    type: "error",
    message: errorMessage(error),
  } satisfies DaemonStartupErrorMessage);
}

export function notifyDaemonReady(message: DaemonReadyMessage): void {
  if (process.send === undefined || !process.connected) {
    return;
  }
  process.send(message, () => {
    process.disconnect?.();
  });
}
