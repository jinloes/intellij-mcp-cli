import type { Writable } from "node:stream";

export function writeJson(
  stream: Writable,
  value: unknown,
  pretty: boolean,
): void {
  stream.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}
