import type { Writable } from "node:stream";

import { errorMetadata } from "./errors.js";

export function writeJson(
  stream: Writable,
  value: unknown,
  pretty: boolean,
): void {
  stream.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

export function startTimer(): number {
  return performance.now();
}

export function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Number((performance.now() - startedAt).toFixed(3)));
}

export function commandResult<T extends Record<string, unknown>>(
  command: string,
  startedAt: number,
  value: T,
): T & { command: string; durationMs: number } {
  return {
    ...value,
    command,
    durationMs: elapsedMilliseconds(startedAt),
  };
}

export function commandError(
  command: string,
  startedAt: number,
  error: unknown,
  includeStack = false,
): {
  ok: false;
  command: string;
  durationMs: number;
  error: ReturnType<typeof errorMetadata> & { stack?: string };
} {
  return {
    ok: false,
    command,
    durationMs: elapsedMilliseconds(startedAt),
    error: {
      ...errorMetadata(error),
      ...(includeStack && error instanceof Error ? { stack: error.stack } : {}),
    },
  };
}
