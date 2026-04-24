import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import type { McpDefinitionScope, McpDiagnostic } from "@/lib/schemas";

import { signatureFor } from "./signature";
import type {
  McpCanonicalServerConfig,
  McpServerDefinition,
  McpSourceDiscoveryResult,
  McpSourceFileStatus,
} from "./types";

const logger = createLogger("mcp.source-discovery");

const PROJECT_MCP_FILENAME = ".mcp.json";

export interface CommandCenterDiscoveryInput {
  /** Absolute path to the Command Center global `.mcp.json`. */
  globalConfigPath: string;
  /** Absolute path to the active worktree. When provided, `.mcp.json` at the
   * worktree root is read as a project-scope source. */
  worktreePath?: string;
}

interface CommandCenterSource {
  scope: McpDefinitionScope;
  filePath: string;
}

export async function discoverCommandCenterSources(
  input: CommandCenterDiscoveryInput,
): Promise<McpSourceDiscoveryResult> {
  const sources = buildSources(input);

  const sourceFiles: McpSourceFileStatus[] = [];
  const diagnostics: McpDiagnostic[] = [];
  const parsedServersBySource: Array<{
    source: CommandCenterSource;
    servers: McpServerDefinition[];
  }> = [];

  for (const source of sources) {
    const outcome = await readCommandCenterSource(source);
    sourceFiles.push(outcome.status);
    diagnostics.push(...outcome.diagnostics);
    parsedServersBySource.push({ source, servers: outcome.servers });
  }

  const merged = mergeServers(parsedServersBySource);

  logger.info("cc.discovery.complete", {
    globalStatus: statusForScope(sourceFiles, "global"),
    projectStatus: statusForScope(sourceFiles, "project"),
    serverCount: merged.length,
    diagnosticCount: diagnostics.length,
  });

  return { servers: merged, diagnostics, sourceFiles };
}

function buildSources(
  input: CommandCenterDiscoveryInput,
): CommandCenterSource[] {
  const sources: CommandCenterSource[] = [
    { scope: "global", filePath: input.globalConfigPath },
  ];
  if (input.worktreePath !== undefined) {
    sources.push({
      scope: "project",
      filePath: path.join(input.worktreePath, PROJECT_MCP_FILENAME),
    });
  }
  return sources;
}

interface SourceOutcome {
  status: McpSourceFileStatus;
  servers: McpServerDefinition[];
  diagnostics: McpDiagnostic[];
}

async function readCommandCenterSource(
  source: CommandCenterSource,
): Promise<SourceOutcome> {
  const sourceRef = { scope: source.scope, filePath: source.filePath };

  const exists = await fileExists(source.filePath);
  if (!exists) {
    return {
      status: {
        scope: source.scope,
        filePath: source.filePath,
        status: "missing",
        serverCount: 0,
      },
      servers: [],
      diagnostics: [
        {
          severity: "info",
          code: "mcp.source.missing",
          message: `Command Center MCP source file not present: ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = await readFile(source.filePath, "utf-8");
  } catch {
    logger.warn("cc.source.unreadable", {
      filePath: source.filePath,
      scope: source.scope,
    });
    return {
      status: {
        scope: source.scope,
        filePath: source.filePath,
        status: "unreadable",
        serverCount: 0,
      },
      servers: [],
      diagnostics: [
        {
          severity: "error",
          code: "mcp.source.unreadable",
          message: `Unable to read Command Center MCP source at ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse errors from some runtimes include source excerpts in
    // err.message. Build the diagnostic only from path metadata so env values,
    // bearer tokens, or header values embedded in the malformed source cannot
    // escape through the view layer.
    logger.warn("cc.source.malformed", {
      filePath: source.filePath,
      scope: source.scope,
    });
    return {
      status: {
        scope: source.scope,
        filePath: source.filePath,
        status: "malformed",
        serverCount: 0,
      },
      servers: [],
      diagnostics: [
        {
          severity: "error",
          code: "mcp.source.parse-error",
          message: `Command Center MCP source at ${source.filePath} is not valid JSON`,
          sourceRef,
        },
      ],
    };
  }

  const mcpServers = extractMcpServersMap(parsed);
  if (!mcpServers) {
    return {
      status: {
        scope: source.scope,
        filePath: source.filePath,
        status: "empty",
        serverCount: 0,
      },
      servers: [],
      diagnostics: [],
    };
  }

  const servers: McpServerDefinition[] = [];
  const diagnostics: McpDiagnostic[] = [];
  for (const [nativeId, rawEntry] of Object.entries(mcpServers)) {
    const parsedServer = parseServerEntry(
      nativeId,
      rawEntry,
      source.filePath,
      source.scope,
    );
    if ("diagnostic" in parsedServer) {
      diagnostics.push(parsedServer.diagnostic);
      continue;
    }
    servers.push(parsedServer.server);
  }

  return {
    status: {
      scope: source.scope,
      filePath: source.filePath,
      status: servers.length > 0 ? "read" : "empty",
      serverCount: servers.length,
    },
    servers,
    diagnostics,
  };
}

function extractMcpServersMap(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const mcpServers = obj["mcpServers"];
  if (!mcpServers || typeof mcpServers !== "object") return null;
  return mcpServers as Record<string, unknown>;
}

type ParsedServer =
  | { server: McpServerDefinition }
  | { diagnostic: McpDiagnostic };

function parseServerEntry(
  nativeId: string,
  rawEntry: unknown,
  filePath: string,
  scope: McpDefinitionScope,
): ParsedServer {
  const sourceRef = { scope, filePath };
  if (!rawEntry || typeof rawEntry !== "object") {
    return {
      diagnostic: {
        severity: "error",
        code: "mcp.source.invalid-entry",
        message: `Entry for ${nativeId} is not an object`,
        serverKey: nativeId,
        sourceRef,
      },
    };
  }
  const entry = rawEntry as Record<string, unknown>;
  const typeField =
    typeof entry["type"] === "string" ? (entry["type"] as string) : undefined;

  const canonical = toCanonicalConfig(entry, typeField);
  if ("error" in canonical) {
    return {
      diagnostic: {
        severity: "error",
        code: canonical.code,
        message: canonical.error,
        serverKey: nativeId,
        sourceRef,
      },
    };
  }

  const definition: McpServerDefinition = {
    serverKey: nativeId,
    nativeId,
    transport: canonical.config.transport,
    config: canonical.config,
    sourceRefs: [sourceRef],
    configSignature: signatureFor(canonical.config),
    reserved: false,
    diagnostics: [],
  };

  return { server: definition };
}

type CanonicalOutcome =
  | { config: McpCanonicalServerConfig }
  | { error: string; code: string };

function toCanonicalConfig(
  entry: Record<string, unknown>,
  typeField: string | undefined,
): CanonicalOutcome {
  const transport = typeField ?? "stdio";

  if (transport === "stdio") {
    if (typeof entry["command"] !== "string") {
      return {
        code: "mcp.source.invalid-entry",
        error: "stdio server is missing a string `command`",
      };
    }
    const config: McpCanonicalServerConfig = {
      transport: "stdio",
      command: entry["command"],
      ...(Array.isArray(entry["args"])
        ? {
            args: (entry["args"] as unknown[]).filter(
              (v): v is string => typeof v === "string",
            ),
          }
        : {}),
      ...(typeof entry["cwd"] === "string" ? { cwd: entry["cwd"] } : {}),
      ...(isStringRecord(entry["env"]) ? { env: entry["env"] } : {}),
    };
    return { config };
  }

  if (transport === "http" || transport === "streamable-http") {
    if (typeof entry["url"] !== "string") {
      return {
        code: "mcp.source.invalid-entry",
        error: "http server is missing a string `url`",
      };
    }
    const config: McpCanonicalServerConfig = {
      transport: "streamable-http",
      url: entry["url"],
      ...(isStringRecord(entry["headers"])
        ? { headers: entry["headers"] }
        : {}),
    };
    return { config };
  }

  if (transport === "sse") {
    if (typeof entry["url"] !== "string") {
      return {
        code: "mcp.source.invalid-entry",
        error: "sse server is missing a string `url`",
      };
    }
    const config: McpCanonicalServerConfig = {
      transport: "sse",
      url: entry["url"],
      ...(isStringRecord(entry["headers"])
        ? { headers: entry["headers"] }
        : {}),
    };
    return { config };
  }

  // Do NOT echo the raw `type` value: a malformed entry can put a
  // credential-bearing URL or other secret-like string in `type`, and that
  // value would leak into diagnostics/logs via the view layer.
  return {
    code: "mcp.source.unknown-transport",
    error: "MCP server has an unknown or unsupported transport type",
  };
}

/**
 * Merge the per-source parsed server lists into a single list with project
 * definitions overriding same-key global definitions. The winning definition's
 * sourceRefs always contain only the winning file (no diagnostic is emitted
 * for an expected project→global replacement).
 */
function mergeServers(
  bySource: ReadonlyArray<{
    source: CommandCenterSource;
    servers: readonly McpServerDefinition[];
  }>,
): McpServerDefinition[] {
  const byKey = new Map<string, McpServerDefinition>();
  for (const { servers } of bySource) {
    for (const server of servers) {
      byKey.set(server.serverKey, server);
    }
  }
  return Array.from(byKey.values());
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function statusForScope(
  sourceFiles: readonly McpSourceFileStatus[],
  scope: McpDefinitionScope,
): McpSourceFileStatus["status"] | "absent" {
  const entry = sourceFiles.find((f) => f.scope === scope);
  return entry?.status ?? "absent";
}
