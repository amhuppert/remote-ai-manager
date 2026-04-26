import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const moduleRequire = createRequire(import.meta.url);

export interface NativeCodexMcpListInput {
  cwd: string;
  env: Record<string, string>;
}

export interface BuildCodexMcpServersConfigInput {
  managedMcpServers: Record<string, unknown>;
  nativeServerNames: readonly string[];
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
  const codexBin = resolveCodexBin();
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

function resolveCodexBin(): string {
  const sdkPackageJsonPath = moduleRequire.resolve(
    "@openai/codex-sdk/package.json",
  );
  const sdkRequire = createRequire(sdkPackageJsonPath);
  const packageJsonPath = sdkRequire.resolve("@openai/codex/package.json");
  return path.join(path.dirname(packageJsonPath), "bin", "codex.js");
}
