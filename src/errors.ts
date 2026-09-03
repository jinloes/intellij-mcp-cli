export type CliErrorCode =
  | "CLI_ERROR"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "CONFIG_READ_FAILED"
  | "PROJECT_PATH_NOT_FOUND"
  | "PROJECT_PATH_INVALID"
  | "PROJECT_TARGET_AMBIGUOUS"
  | "PROJECT_TARGET_MISMATCH"
  | "SERVER_NOT_FOUND"
  | "INPUT_INVALID"
  | "INPUT_READ_FAILED"
  | "INPUT_REQUIRED"
  | "MCP_CONNECTION_FAILED"
  | "MCP_REQUEST_FAILED"
  | "MCP_TOOL_ERROR"
  | "TOOL_NOT_FOUND"
  | "TOOL_SCHEMA_CHANGED"
  | "DAEMON_UNAVAILABLE"
  | "DAEMON_PROTOCOL_ERROR"
  | "SKILL_NOT_FOUND"
  | "SKILL_DESTINATION_EXISTS"
  | "SKILL_NOT_MANAGED"
  | "SKILL_PATH_UNSAFE"
  | "INTERNAL_ERROR";

export interface CliErrorOptions {
  exitCode?: number;
  code?: CliErrorCode;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

const CLI_ERROR_CODES = new Set<CliErrorCode>([
  "CLI_ERROR",
  "CONFIG_NOT_FOUND",
  "CONFIG_INVALID",
  "CONFIG_READ_FAILED",
  "PROJECT_PATH_NOT_FOUND",
  "PROJECT_PATH_INVALID",
  "PROJECT_TARGET_AMBIGUOUS",
  "PROJECT_TARGET_MISMATCH",
  "SERVER_NOT_FOUND",
  "INPUT_INVALID",
  "INPUT_READ_FAILED",
  "INPUT_REQUIRED",
  "MCP_CONNECTION_FAILED",
  "MCP_REQUEST_FAILED",
  "MCP_TOOL_ERROR",
  "TOOL_NOT_FOUND",
  "TOOL_SCHEMA_CHANGED",
  "DAEMON_UNAVAILABLE",
  "DAEMON_PROTOCOL_ERROR",
  "SKILL_NOT_FOUND",
  "SKILL_DESTINATION_EXISTS",
  "SKILL_NOT_MANAGED",
  "SKILL_PATH_UNSAFE",
  "INTERNAL_ERROR",
]);

export function isCliErrorCode(value: unknown): value is CliErrorCode {
  return (
    typeof value === "string" && CLI_ERROR_CODES.has(value as CliErrorCode)
  );
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: CliErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    exitCodeOrOptions: number | CliErrorOptions = {},
  ) {
    super(message);
    this.name = "CliError";
    const options =
      typeof exitCodeOrOptions === "number"
        ? { exitCode: exitCodeOrOptions }
        : exitCodeOrOptions;
    this.exitCode = options.exitCode ?? 1;
    this.code = options.code ?? "CLI_ERROR";
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function errorMetadata(error: unknown): {
  code: CliErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: errorMessage(error),
    retryable: false,
  };
}
