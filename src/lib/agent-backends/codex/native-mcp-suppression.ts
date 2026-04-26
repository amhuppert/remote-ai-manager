import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NativeCodexMcpListInput {
  cwd: string;
  env: Record<string, string>;
}

export interface BuildCodexMcpServersConfigInput {
  managedMcpServers: Record<string, unknown>;
  nativeServerNames: readonly string[];
}

export interface ResolveCodexCliPathInput {
  cwd: string;
  serverRoot?: string;
  fileExists?: (filePath: string) => boolean;
}

export function buildCodexMcpServersConfig(
  input: BuildCodexMcpServersConfigInput,
): Record<string, unknown> {
  const managedNames = new Set(Object.keys(input.managedMcpServers));
  const mcpServers: Record<string, unknown> = {
    ...input.managedMcpServers,
  };

  for (const name of input.nativeServerNames) {
    if (managedNames.has(name)) continue;
    mcpServers[name] = { enabled: false };
  }

  return mcpServers;
}

export function parseCodexMcpListJson(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];

  const names: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

export async function listNativeCodexMcpServerNames(
  input: NativeCodexMcpListInput,
): Promise<string[]> {
  const codexBin = resolveCodexCliPath({ cwd: input.cwd });
  const { stdout } = await execFileAsync(
    process.execPath,
    [codexBin, "mcp", "list", "--json"],
    {
      cwd: input.cwd,
      env: input.env as NodeJS.ProcessEnv,
      maxBuffer: 1024 * 1024,
    },
  );

  return parseCodexMcpListJson(stdout);
}

export function resolveCodexCliPath(input: ResolveCodexCliPathInput): string {
  const fileExists = input.fileExists ?? existsSync;
  const candidates = uniqueCandidates([
    input.cwd,
    input.serverRoot ?? process.cwd(),
  ]);

  for (const basePath of candidates) {
    const packageJsonPath = codexPackageJsonPath(basePath);
    if (!fileExists(packageJsonPath)) continue;
    return path.join(path.dirname(packageJsonPath), "bin", "codex.js");
  }

  throw new Error("Unable to resolve @openai/codex CLI path");
}

function uniqueCandidates(candidates: readonly string[]): string[] {
  return Array.from(new Set(candidates));
}

function codexPackageJsonPath(basePath: string): string {
  return path.join(
    basePath,
    "node_modules",
    "@openai",
    "codex",
    "package.json",
  );
}
