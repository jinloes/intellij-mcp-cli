import type { Tool } from "@modelcontextprotocol/client";

import { CliError } from "./errors.js";

export type ToolSafety =
  | "read-only"
  | "workspace-write"
  | "execution"
  | "debug-state"
  | "database"
  | "unknown";

export interface SafetyWarning {
  code: "NON_READ_ONLY_TOOL";
  safety: Exclude<ToolSafety, "read-only">;
  message: string;
}

const DATABASE_PATTERN =
  /(?:^|_)(?:database|datasource|schema|sql|query)(?:_|$)/iu;
const DEBUG_PATTERN =
  /(?:^|_)(?:debug|debugger|breakpoint|suspend|resume|step)(?:_|$)/iu;
const EXECUTION_PATTERN =
  /(?:^|_)(?:build|compile|execute|run|terminal|process|test)(?:_|$)/iu;
const WRITE_PATTERN =
  /(?:^|_)(?:create|delete|edit|format|move|rename|replace|refactor|update|write)(?:_|$)/iu;

export function classifyTool(tool: Tool): ToolSafety {
  if (tool.annotations?.readOnlyHint === true) {
    return "read-only";
  }

  const name = tool.name.toLowerCase();
  if (DATABASE_PATTERN.test(name)) {
    return "database";
  }
  if (DEBUG_PATTERN.test(name)) {
    return "debug-state";
  }
  if (EXECUTION_PATTERN.test(name)) {
    return "execution";
  }
  if (
    tool.annotations?.destructiveHint === true ||
    tool.annotations?.idempotentHint === true ||
    WRITE_PATTERN.test(name)
  ) {
    return "workspace-write";
  }
  return "unknown";
}

export function safetyWarning(safety: ToolSafety): SafetyWarning | undefined {
  if (safety === "read-only") {
    return undefined;
  }
  return {
    code: "NON_READ_ONLY_TOOL",
    safety,
    message: `Tool safety is "${safety}"; the call may have side effects and was not blocked.`,
  };
}

function requiredArguments(tool: Tool): string[] {
  const required = tool.inputSchema.required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
}

export function compactTool(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    required: requiredArguments(tool),
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
    safety: classifyTool(tool),
  };
}

export interface CatalogOptions {
  query?: string;
  detail: "compact" | "full";
  offset: number;
  limit: number;
}

export interface ToolCatalog {
  tools: Array<Record<string, unknown>>;
  paging: {
    total: number;
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
  };
}

export function buildToolCatalog(
  tools: Tool[],
  options: CatalogOptions,
): ToolCatalog {
  const query = options.query?.toLocaleLowerCase();
  const matching = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .filter((tool) => {
      if (query === undefined || query.length === 0) {
        return true;
      }
      return [tool.name, tool.title, tool.description].some(
        (value) =>
          typeof value === "string" &&
          value.toLocaleLowerCase().includes(query),
      );
    });
  const selected = matching.slice(
    options.offset,
    options.offset + options.limit,
  );

  return {
    tools: selected.map((tool) =>
      options.detail === "full"
        ? { ...tool, safety: classifyTool(tool) }
        : compactTool(tool),
    ),
    paging: {
      total: matching.length,
      offset: options.offset,
      limit: options.limit,
      returned: selected.length,
      hasMore: options.offset + selected.length < matching.length,
    },
  };
}

export function countToolsBySafety(tools: Tool[]): Record<ToolSafety, number> {
  const counts: Record<ToolSafety, number> = {
    "read-only": 0,
    "workspace-write": 0,
    execution: 0,
    "debug-state": 0,
    database: 0,
    unknown: 0,
  };
  for (const tool of tools) {
    counts[classifyTool(tool)] += 1;
  }
  return counts;
}

export type AliasName =
  | "search symbol"
  | "analyze calls"
  | "analyze problems"
  | "analyze modules"
  | "analyze dependencies"
  | "refactor rename"
  | "build"
  | "run list"
  | "run execute"
  | "database connections"
  | "database query";

export interface AliasDefinition {
  alias: AliasName;
  tool: string;
  expectedArguments: string[];
  requiredArguments: string[];
}

export const ALIAS_DEFINITIONS: Record<AliasName, AliasDefinition> = {
  "search symbol": {
    alias: "search symbol",
    tool: "search_symbol",
    expectedArguments: ["q", "paths", "include_external", "limit"],
    requiredArguments: ["q"],
  },
  "analyze calls": {
    alias: "analyze calls",
    tool: "analyze_calls",
    expectedArguments: [
      "symbolFqn",
      "analysisKind",
      "depth",
      "maxChildren",
      "maxNodes",
      "treePath",
      "childOffset",
      "timeout",
    ],
    requiredArguments: ["symbolFqn", "analysisKind"],
  },
  "analyze problems": {
    alias: "analyze problems",
    tool: "get_file_problems",
    expectedArguments: ["filePath", "errorsOnly", "timeout"],
    requiredArguments: ["filePath"],
  },
  "analyze modules": {
    alias: "analyze modules",
    tool: "get_project_modules",
    expectedArguments: [],
    requiredArguments: [],
  },
  "analyze dependencies": {
    alias: "analyze dependencies",
    tool: "get_project_dependencies",
    expectedArguments: [],
    requiredArguments: [],
  },
  "refactor rename": {
    alias: "refactor rename",
    tool: "rename_refactoring",
    expectedArguments: ["pathInProject", "symbolName", "newName"],
    requiredArguments: ["pathInProject", "symbolName", "newName"],
  },
  build: {
    alias: "build",
    tool: "build_project",
    expectedArguments: ["rebuild", "filesToRebuild", "timeout"],
    requiredArguments: [],
  },
  "run list": {
    alias: "run list",
    tool: "get_run_configurations",
    expectedArguments: ["filePath"],
    requiredArguments: [],
  },
  "run execute": {
    alias: "run execute",
    tool: "execute_run_configuration",
    expectedArguments: [
      "configurationName",
      "filePath",
      "line",
      "timeout",
      "waitForExit",
      "programArguments",
      "workingDirectory",
      "envs",
    ],
    requiredArguments: [],
  },
  "database connections": {
    alias: "database connections",
    tool: "list_database_connections",
    expectedArguments: [],
    requiredArguments: [],
  },
  "database query": {
    alias: "database query",
    tool: "execute_sql_query",
    expectedArguments: [
      "connectionId",
      "databaseName",
      "schemaName",
      "queryText",
    ],
    requiredArguments: [
      "connectionId",
      "databaseName",
      "schemaName",
      "queryText",
    ],
  },
};

function schemaProperties(tool: Tool): Record<string, unknown> {
  const properties = tool.inputSchema.properties;
  return typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties)
    ? properties
    : {};
}

export function requireAliasTool(
  tools: Tool[],
  alias: AliasName,
): { definition: AliasDefinition; tool: Tool; safety: ToolSafety } {
  const definition = ALIAS_DEFINITIONS[alias];
  const tool = tools.find((candidate) => candidate.name === definition.tool);
  if (tool === undefined) {
    throw new CliError(
      `Required IntelliJ tool "${definition.tool}" for "ijctl ${alias}" is unavailable. Run "ijctl tools" and "ijctl describe ${definition.tool}", or use "ijctl call" with the available tool.`,
      {
        code: "TOOL_NOT_FOUND",
        details: { alias, tool: definition.tool },
      },
    );
  }

  const properties = schemaProperties(tool);
  const required = new Set(requiredArguments(tool));
  const missingProperties = definition.expectedArguments.filter(
    (argument) => properties[argument] === undefined,
  );
  const missingRequired = definition.requiredArguments.filter(
    (argument) => !required.has(argument),
  );
  const unexpectedRequired = [...required].filter(
    (argument) => !definition.requiredArguments.includes(argument),
  );
  if (
    missingProperties.length > 0 ||
    missingRequired.length > 0 ||
    unexpectedRequired.length > 0
  ) {
    throw new CliError(
      `IntelliJ tool "${definition.tool}" no longer matches the documented alias contract. Run "ijctl describe ${definition.tool}" and use "ijctl call" with its live schema.`,
      {
        code: "TOOL_SCHEMA_CHANGED",
        details: {
          alias,
          tool: definition.tool,
          missingProperties,
          missingRequired,
          unexpectedRequired,
        },
      },
    );
  }

  return { definition, tool, safety: classifyTool(tool) };
}
