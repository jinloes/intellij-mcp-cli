import { readFile } from "node:fs/promises";

import { CliError, errorMessage } from "./errors.js";

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseArgumentsJson(
  text: string,
  source: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Invalid JSON from ${source}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${source} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

export async function readToolArguments(options: {
  argsJson?: string;
  argsFile?: string;
}): Promise<Record<string, unknown>> {
  if (options.argsJson !== undefined && options.argsFile !== undefined) {
    throw new CliError("--args-json and --args-file cannot be used together.");
  }

  if (options.argsJson !== undefined) {
    return parseArgumentsJson(options.argsJson, "--args-json");
  }

  if (options.argsFile !== undefined) {
    if (options.argsFile === "-") {
      return parseArgumentsJson(await readStandardInput(), "standard input");
    }

    try {
      return parseArgumentsJson(
        await readFile(options.argsFile, "utf8"),
        options.argsFile,
      );
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }

      throw new CliError(
        `Unable to read tool arguments from "${options.argsFile}": ${errorMessage(error)}`,
      );
    }
  }

  return {};
}
