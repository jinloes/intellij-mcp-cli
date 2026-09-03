import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, errorMessage } from "./errors.js";
import { VERSION } from "./version.js";

export const SKILL_MARKER_FILE = ".ijctl-skill.json";
const SKILL_OWNER = "intellij-mcp-cli";

export type SkillScope = "user" | "project";

export interface BundledSkill {
  name: string;
  description: string;
  source: string;
  version: string;
}

export interface SkillOperationOptions {
  names?: string[];
  scope: SkillScope;
  projectPath: string;
  dryRun: boolean;
  force?: boolean;
  homeDirectory?: string;
}

export interface SkillOperationResult {
  name: string;
  scope: SkillScope;
  destination: string;
  action: "installed" | "refreshed" | "would-install" | "would-refresh";
  version: string;
}

interface SkillMarker {
  owner: typeof SKILL_OWNER;
  name: string;
  version: string;
}

function bundledSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function assertNoSymlink(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsedRoot = parse(absolute).root;
  const parts = relative(parsedRoot, absolute).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new CliError(
          `Skill path "${current}" traverses a symbolic link.`,
          {
            code: "SKILL_PATH_UNSAFE",
            details: { path: current },
          },
        );
      }
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw new CliError(
        `Unable to inspect skill path "${current}": ${errorMessage(error)}`,
        {
          code: "SKILL_PATH_UNSAFE",
          details: { path: current },
        },
      );
    }
  }
}

async function safeDirectoryEntries(path: string) {
  await assertNoSymlink(path);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new CliError(
      `Unable to read bundled skills from "${path}": ${errorMessage(error)}`,
      { code: "SKILL_PATH_UNSAFE", details: { path } },
    );
  }
  return entries;
}

function parseSkillFrontmatter(
  text: string,
  path: string,
): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (match?.[1] === undefined) {
    throw new CliError(`Bundled skill "${path}" has invalid frontmatter.`, {
      code: "CONFIG_INVALID",
      details: { path },
    });
  }
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      values.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const name = values.get("name");
  const description = values.get("description");
  if (name === undefined || description === undefined) {
    throw new CliError(
      `Bundled skill "${path}" must declare name and description frontmatter.`,
      { code: "CONFIG_INVALID", details: { path } },
    );
  }
  return { name, description };
}

export async function listBundledSkills(): Promise<BundledSkill[]> {
  const root = bundledSkillsRoot();
  const skills: BundledSkill[] = [];
  for (const entry of await safeDirectoryEntries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.isSymbolicLink()) {
        throw new CliError(
          `Bundled skill entry "${join(root, entry.name)}" is a symbolic link.`,
          {
            code: "SKILL_PATH_UNSAFE",
            details: { path: join(root, entry.name) },
          },
        );
      }
      continue;
    }
    const source = join(root, entry.name);
    await assertNoSymlink(source);
    const instructionsPath = join(source, "SKILL.md");
    let instructions: string;
    try {
      const metadata = await lstat(instructionsPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("SKILL.md is not a regular file");
      }
      instructions = await readFile(instructionsPath, "utf8");
    } catch (error) {
      throw new CliError(
        `Unable to read bundled skill "${entry.name}": ${errorMessage(error)}`,
        {
          code: "SKILL_PATH_UNSAFE",
          details: { path: instructionsPath },
        },
      );
    }
    const frontmatter = parseSkillFrontmatter(instructions, instructionsPath);
    if (frontmatter.name !== entry.name) {
      throw new CliError(
        `Bundled skill directory "${entry.name}" does not match frontmatter name "${frontmatter.name}".`,
        { code: "CONFIG_INVALID", details: { path: instructionsPath } },
      );
    }
    skills.push({
      ...frontmatter,
      source,
      version: VERSION,
    });
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new CliError(`Bundled skill name "${skill.name}" is duplicated.`, {
        code: "CONFIG_INVALID",
      });
    }
    names.add(skill.name);
  }
  return skills;
}

async function destinationRoot(
  options: SkillOperationOptions,
): Promise<string> {
  const base =
    options.scope === "user"
      ? resolve(options.homeDirectory ?? homedir())
      : resolve(options.projectPath);
  let canonicalBase: string;
  try {
    canonicalBase = await realpath(base);
  } catch (error) {
    throw new CliError(
      `Unable to resolve skill ${options.scope} root "${base}": ${errorMessage(error)}`,
      { code: "SKILL_PATH_UNSAFE", details: { path: base } },
    );
  }
  return options.scope === "user"
    ? resolve(canonicalBase, ".copilot", "skills")
    : resolve(canonicalBase, ".github", "skills");
}

function selectSkills(
  bundled: BundledSkill[],
  requestedNames?: string[],
): BundledSkill[] {
  if (requestedNames === undefined || requestedNames.length === 0) {
    return bundled;
  }
  const uniqueNames = [...new Set(requestedNames)];
  const byName = new Map(bundled.map((skill) => [skill.name, skill]));
  const missing = uniqueNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new CliError(
      `Bundled skill${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}.`,
      {
        code: "SKILL_NOT_FOUND",
        details: {
          requested: uniqueNames,
          available: bundled.map((skill) => skill.name),
        },
      },
    );
  }
  return uniqueNames.map((name) => byName.get(name) as BundledSkill);
}

async function pathType(
  path: string,
): Promise<"missing" | "directory" | "other"> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new CliError(`Skill destination "${path}" is a symbolic link.`, {
        code: "SKILL_PATH_UNSAFE",
        details: { path },
      });
    }
    return metadata.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (isErrno(error, "ENOENT")) {
      return "missing";
    }
    throw new CliError(
      `Unable to inspect skill destination "${path}": ${errorMessage(error)}`,
      { code: "SKILL_PATH_UNSAFE", details: { path } },
    );
  }
}

async function readMarker(
  destination: string,
): Promise<SkillMarker | undefined> {
  const markerPath = join(destination, SKILL_MARKER_FILE);
  try {
    const metadata = await lstat(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return undefined;
    }
    const value: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "owner" in value &&
      value.owner === SKILL_OWNER &&
      "name" in value &&
      typeof value.name === "string" &&
      "version" in value &&
      typeof value.version === "string"
    ) {
      return value as SkillMarker;
    }
    return undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    return undefined;
  }
}

async function copySkillTree(
  source: string,
  destination: string,
): Promise<void> {
  await assertNoSymlink(source);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CliError(`Bundled skill path "${sourcePath}" is a symlink.`, {
        code: "SKILL_PATH_UNSAFE",
        details: { path: sourcePath },
      });
    }
    if (entry.isDirectory()) {
      await copySkillTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await writeFile(destinationPath, await readFile(sourcePath), {
        mode: 0o600,
        flag: "wx",
      });
    } else {
      throw new CliError(
        `Bundled skill path "${sourcePath}" is not a regular file or directory.`,
        { code: "SKILL_PATH_UNSAFE", details: { path: sourcePath } },
      );
    }
  }
}

async function replaceSkillDirectory(
  skill: BundledSkill,
  destination: string,
): Promise<void> {
  const parent = dirname(destination);
  const staging = join(
    parent,
    `.${basename(destination)}.ijctl-${randomUUID()}`,
  );
  const backup = join(
    parent,
    `.${basename(destination)}.backup-${randomUUID()}`,
  );
  let movedExisting = false;
  try {
    await copySkillTree(skill.source, staging);
    const marker: SkillMarker = {
      owner: SKILL_OWNER,
      name: skill.name,
      version: VERSION,
    };
    await writeFile(
      join(staging, SKILL_MARKER_FILE),
      `${JSON.stringify(marker, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    if ((await pathType(destination)) !== "missing") {
      await rename(destination, backup);
      movedExisting = true;
    }
    await rename(staging, destination);
    if (movedExisting) {
      await rm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (movedExisting && (await pathType(destination)) === "missing") {
      await rename(backup, destination);
    }
    throw error;
  }
}

async function performSkillOperation(
  mode: "install" | "refresh",
  options: SkillOperationOptions,
): Promise<SkillOperationResult[]> {
  const bundled = await listBundledSkills();
  const selected = selectSkills(bundled, options.names);
  const root = await destinationRoot(options);
  await assertNoSymlink(root);
  const implicitRefresh =
    mode === "refresh" &&
    (options.names === undefined || options.names.length === 0);
  const prepared: Array<{ skill: BundledSkill; destination: string }> = [];
  for (const skill of selected) {
    const destination = join(root, skill.name);
    await assertNoSymlink(destination);
    const existingType = await pathType(destination);
    if (existingType === "other") {
      throw new CliError(
        `Skill destination "${destination}" is not a directory.`,
        { code: "SKILL_PATH_UNSAFE", details: { path: destination } },
      );
    }
    const marker =
      existingType === "directory" ? await readMarker(destination) : undefined;

    if (mode === "install" && existingType !== "missing" && !options.force) {
      throw new CliError(
        `Skill destination "${destination}" already exists; pass --force to replace it.`,
        {
          code: "SKILL_DESTINATION_EXISTS",
          details: { name: skill.name, destination },
        },
      );
    }
    if (
      mode === "refresh" &&
      (marker === undefined || marker.name !== skill.name)
    ) {
      if (implicitRefresh) {
        continue;
      }
      throw new CliError(
        `Skill "${skill.name}" at "${destination}" is not managed by ijctl and cannot be refreshed.`,
        {
          code: "SKILL_NOT_MANAGED",
          details: { name: skill.name, destination },
        },
      );
    }
    prepared.push({ skill, destination });
  }

  if (!options.dryRun && prepared.length > 0) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertNoSymlink(await realpath(root));
  }

  const results: SkillOperationResult[] = [];
  for (const { skill, destination } of prepared) {
    if (!options.dryRun) {
      await replaceSkillDirectory(skill, destination);
    }
    results.push({
      name: skill.name,
      scope: options.scope,
      destination,
      action:
        mode === "install"
          ? options.dryRun
            ? "would-install"
            : "installed"
          : options.dryRun
            ? "would-refresh"
            : "refreshed",
      version: VERSION,
    });
  }
  return results;
}

export async function installSkills(
  options: SkillOperationOptions,
): Promise<SkillOperationResult[]> {
  return performSkillOperation("install", options);
}

export async function refreshSkills(
  options: SkillOperationOptions,
): Promise<SkillOperationResult[]> {
  return performSkillOperation("refresh", options);
}
