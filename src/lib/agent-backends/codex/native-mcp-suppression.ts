import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { getErrorMessage } from "@/lib/shared/errors";

const execFileAsync = promisify(execFile);

export interface NativeCodexMcpListInput {
  cwd: string;
  env: Record<string, string>;
}

/**
 * A native Codex MCP server discovered via `codex mcp list --json`, paired with
 * the `[mcp_servers.<name>]` config fields reconstructed from its transport.
 *
 * The reconstructed `configEntry` is what lets us emit a COMPLETE suppression
 * entry: a bare `{ enabled: false }` override is rejected by Codex's config
 * loader ("invalid transport") for plugin-provided servers (e.g. the
 * `github@openai-curated` plugin), because they have no `[mcp_servers.<name>]`
 * table in config.toml for the partial override to merge onto.
 */
export interface NativeCodexMcpServer {
  name: string;
  configEntry: Record<string, unknown>;
}

export interface BuildCodexMcpServersConfigInput {
  managedMcpServers: Record<string, unknown>;
  nativeServers: readonly NativeCodexMcpServer[];
}

export interface ResolveCodexCliPathInput {
  cwd: string;
  serverRoot?: string;
  fileExists?: (filePath: string) => boolean;
}

// `codex mcp list --json` reports null for absent optional transport fields.
const nativeStdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).nullish(),
  env: z.record(z.string(), z.string()).nullish(),
  cwd: z.string().nullish(),
});

const nativeHttpTransportSchema = z.object({
  type: z.literal("streamable_http"),
  url: z.string(),
  bearer_token_env_var: z.string().nullish(),
  http_headers: z.record(z.string(), z.string()).nullish(),
});

const nativeCodexMcpListEntrySchema = z.object({
  name: z.string().min(1),
  transport: z.discriminatedUnion("type", [
    nativeStdioTransportSchema,
    nativeHttpTransportSchema,
  ]),
});

type NativeCodexMcpTransport = z.infer<
  typeof nativeCodexMcpListEntrySchema
>["transport"];

function configEntryFromTransport(
  transport: NativeCodexMcpTransport,
): Record<string, unknown> {
  if (transport.type === "stdio") {
    const entry: Record<string, unknown> = { command: transport.command };
    if (transport.args != null) entry.args = transport.args;
    if (transport.env != null) entry.env = transport.env;
    if (transport.cwd != null) entry.cwd = transport.cwd;
    return entry;
  }

  const entry: Record<string, unknown> = { url: transport.url };
  if (transport.bearer_token_env_var != null) {
    entry.bearer_token_env_var = transport.bearer_token_env_var;
  }
  if (transport.http_headers != null) {
    entry.http_headers = transport.http_headers;
  }
  return entry;
}

export function buildCodexMcpServersConfig(
  input: BuildCodexMcpServersConfigInput,
): Record<string, unknown> {
  const managedNames = new Set(Object.keys(input.managedMcpServers));
  const mcpServers: Record<string, unknown> = {
    ...input.managedMcpServers,
  };

  for (const server of input.nativeServers) {
    if (managedNames.has(server.name)) continue;
    mcpServers[server.name] = { ...server.configEntry, enabled: false };
  }

  return mcpServers;
}

/**
 * Native servers Codex reported, and whether that report is complete. An
 * incomplete discovery keeps every server it could reconstruct so a
 * best-effort caller can still suppress those.
 */
export type NativeCodexMcpDiscovery =
  | { kind: "complete"; servers: NativeCodexMcpServer[] }
  | {
      kind: "incomplete";
      reason: string;
      reconstructed: NativeCodexMcpServer[];
    };

/**
 * `required`: the launch may reach only servers CC composed, so incomplete
 * discovery refuses it. `best_effort`: an ordinary launch suppresses what it
 * could reconstruct and proceeds.
 */
export type NativeMcpSuppressionRequirement = "required" | "best_effort";

export type NativeMcpSuppression =
  | { kind: "suppress"; servers: NativeCodexMcpServer[] }
  | { kind: "refused"; reason: string };

export function resolveNativeMcpSuppression(
  discovery: NativeCodexMcpDiscovery,
  requirement: NativeMcpSuppressionRequirement,
): NativeMcpSuppression {
  if (discovery.kind === "complete") {
    return { kind: "suppress", servers: discovery.servers };
  }
  if (requirement === "required") {
    return { kind: "refused", reason: discovery.reason };
  }
  return { kind: "suppress", servers: discovery.reconstructed };
}

/** Thrown where a refused required suppression must fail the operation. */
export class NativeMcpSuppressionRefusedError extends Error {
  constructor(reason: string) {
    super(`Native Codex MCP servers could not be suppressed: ${reason}`);
    this.name = "NativeMcpSuppressionRefusedError";
  }
}

export function parseCodexMcpListJson(stdout: string): NativeCodexMcpDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      kind: "incomplete",
      reason: "codex mcp list returned invalid JSON",
      reconstructed: [],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      kind: "incomplete",
      reason: "codex mcp list did not return an array",
      reconstructed: [],
    };
  }

  const servers: NativeCodexMcpServer[] = [];
  const unreadable: string[] = [];
  for (const [index, entry] of parsed.entries()) {
    // A server whose transport cannot be reconstructed is never emitted: a
    // transport-less entry breaks Codex's config loader for every turn.
    const result = nativeCodexMcpListEntrySchema.safeParse(entry);
    if (!result.success) {
      unreadable.push(describeUnreadableEntry(entry, index));
      continue;
    }
    servers.push({
      name: result.data.name,
      configEntry: configEntryFromTransport(result.data.transport),
    });
  }
  if (unreadable.length > 0) {
    return {
      kind: "incomplete",
      reason: `unreadable native MCP server entries: ${unreadable.join(", ")}`,
      reconstructed: servers,
    };
  }
  return { kind: "complete", servers };
}

function describeUnreadableEntry(entry: unknown, index: number): string {
  if (
    entry !== null &&
    typeof entry === "object" &&
    "name" in entry &&
    typeof entry.name === "string"
  ) {
    return entry.name;
  }
  return `#${index}`;
}

export async function discoverNativeCodexMcpServers(
  input: NativeCodexMcpListInput,
): Promise<NativeCodexMcpDiscovery> {
  let stdout: string;
  try {
    const codexBin = resolveCodexCliPath({ cwd: input.cwd });
    ({ stdout } = await execFileAsync(
      process.execPath,
      [codexBin, "mcp", "list", "--json"],
      {
        cwd: input.cwd,
        env: input.env as NodeJS.ProcessEnv,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    return {
      kind: "incomplete",
      reason: `codex mcp list failed: ${getErrorMessage(error)}`,
      reconstructed: [],
    };
  }
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
