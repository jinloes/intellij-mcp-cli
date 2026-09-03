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
    throw new CliError(`Invalid JSON from ${source}: ${errorMessage(error)}`, {
      code: "INPUT_INVALID",
      details: { source },
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${source} must contain a JSON object.`, {
      code: "INPUT_INVALID",
      details: { source },
    });
  }

  return parsed as Record<string, unknown>;
}

export async function readToolArguments(options: {
  argsJson?: string;
  argsFile?: string;
}): Promise<Record<string, unknown>> {
  if (options.argsJson !== undefined && options.argsFile !== undefined) {
    throw new CliError("--args-json and --args-file cannot be used together.", {
      code: "INPUT_INVALID",
    });
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
        {
          code: "INPUT_READ_FAILED",
          details: { path: options.argsFile },
        },
      );
    }
  }

  return {};
}

export async function readTextInput(options: {
  text?: string;
  file?: string;
  textOption: string;
  fileOption: string;
}): Promise<string> {
  if (options.text !== undefined && options.file !== undefined) {
    throw new CliError(
      `${options.textOption} and ${options.fileOption} cannot be used together.`,
      { code: "INPUT_INVALID" },
    );
  }

  let value: string;
  let source: string;
  if (options.text !== undefined) {
    value = options.text;
    source = options.textOption;
  } else if (options.file !== undefined) {
    source = options.file === "-" ? "standard input" : options.file;
    if (options.file === "-") {
      value = await readStandardInput();
    } else {
      try {
        value = await readFile(options.file, "utf8");
      } catch (error) {
        throw new CliError(
          `Unable to read text input from "${options.file}": ${errorMessage(error)}`,
          {
            code: "INPUT_READ_FAILED",
            details: { path: options.file },
          },
        );
      }
    }
  } else {
    throw new CliError(
      `One of ${options.textOption} or ${options.fileOption} is required.`,
      { code: "INPUT_REQUIRED" },
    );
  }

  if (value.trim().length === 0) {
    throw new CliError(`${source} must not be empty.`, {
      code: "INPUT_INVALID",
      details: { source },
    });
  }

  return value;
}
