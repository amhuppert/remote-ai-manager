import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { createLogger } from "@/lib/logging";
import type { McpDefinitionScope, McpDiagnostic } from "@/lib/schemas";

import type {
  McpCanonicalServerConfig,
  McpServerDefinition,
  McpSourceDiscoveryResult,
  McpSourceFileStatus,
} from "./types";

const logger = createLogger("mcp.source-discovery");

interface ClaudeSource {
  scope: McpDefinitionScope;
  filePath: string;
  /** Key inside the parsed JSON that holds MCP servers. `null` when the file
   * IS the MCP servers map (like `.mcp.json`, which has an outer `mcpServers`
   * wrapper but no surrounding settings keys). */
  container: "root" | "mcpServers-only";
}

export interface DiscoverClaudeInput {
  worktreePath: string;
  homePath: string;
}

export async function discoverClaudeSources(
  input: DiscoverClaudeInput,
): Promise<McpSourceDiscoveryResult> {
  const sources = buildClaudeSources(input);
  const servers: McpServerDefinition[] = [];
  const diagnostics: McpDiagnostic[] = [];
  const sourceFiles: McpSourceFileStatus[] = [];

  for (const source of sources) {
    const fileOutcome = await readClaudeSource(source);
    sourceFiles.push(fileOutcome.status);
    diagnostics.push(...fileOutcome.diagnostics);
    servers.push(...fileOutcome.servers);
  }

  logger.info("Claude MCP discovery complete", {
    worktreePath: input.worktreePath,
    serverCount: servers.length,
    scopes: countByScope(servers),
  });

  return { servers, diagnostics, sourceFiles };
}

function buildClaudeSources({
  worktreePath,
  homePath,
}: DiscoverClaudeInput): ClaudeSource[] {
  return [
    {
      scope: "project",
      filePath: path.join(worktreePath, ".mcp.json"),
      container: "mcpServers-only",
    },
    {
      scope: "project",
      filePath: path.join(worktreePath, ".claude", "settings.json"),
      container: "root",
    },
    {
      scope: "local",
      filePath: path.join(worktreePath, ".claude", "settings.local.json"),
      container: "root",
    },
    {
      scope: "user",
      filePath: path.join(homePath, ".claude", "settings.json"),
      container: "root",
    },
  ];
}

interface ClaudeSourceOutcome {
  status: McpSourceFileStatus;
  servers: McpServerDefinition[];
  diagnostics: McpDiagnostic[];
}

async function readClaudeSource(
  source: ClaudeSource,
): Promise<ClaudeSourceOutcome> {
  const sourceRef = {
    backend: "claude" as const,
    scope: source.scope,
    filePath: source.filePath,
  };

  const exists = await fileExists(source.filePath);
  if (!exists) {
    return {
      status: {
        backend: "claude",
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
          message: `Claude MCP source file not present: ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = await readFile(source.filePath, "utf-8");
  } catch {
    // Sanitize diagnostic: never include the raw error message — FS errors can
    // include file contents or path details that overlap with secrets.
    logger.warn("Claude MCP source unreadable", {
      filePath: source.filePath,
      scope: source.scope,
    });
    return {
      status: {
        backend: "claude",
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
          message: `Unable to read Claude MCP source at ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse errors can include source excerpts in some runtimes. Build
    // the diagnostic from path metadata only so env values, headers, and
    // bearer tokens from the malformed source cannot escape through the view
    // layer.
    logger.warn("Claude MCP source malformed", {
      filePath: source.filePath,
      scope: source.scope,
    });
    return {
      status: {
        backend: "claude",
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
          message: `Claude MCP source at ${source.filePath} is not valid JSON`,
          sourceRef,
        },
      ],
    };
  }

  const mcpServers = extractMcpServersMap(parsed);
  if (!mcpServers) {
    return {
      status: {
        backend: "claude",
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
    const parsedServer = parseClaudeServerEntry(
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
      backend: "claude",
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

function parseClaudeServerEntry(
  nativeId: string,
  rawEntry: unknown,
  filePath: string,
  scope: McpDefinitionScope,
): ParsedServer {
  if (!rawEntry || typeof rawEntry !== "object") {
    return {
      diagnostic: {
        severity: "error",
        code: "mcp.source.invalid-entry",
        message: `Entry for ${nativeId} is not an object`,
        serverKey: nativeId,
        sourceRef: { backend: "claude", scope, filePath },
      },
    };
  }
  const entry = rawEntry as Record<string, unknown>;
  const typeField =
    typeof entry["type"] === "string" ? (entry["type"] as string) : undefined;

  const canonical = toCanonicalClaudeConfig(entry, typeField);
  if ("error" in canonical) {
    return {
      diagnostic: {
        severity: "error",
        code: canonical.code,
        message: canonical.error,
        serverKey: nativeId,
        sourceRef: { backend: "claude", scope, filePath },
      },
    };
  }

  const definition: McpServerDefinition = {
    serverKey: nativeId,
    nativeId,
    backend: "claude",
    transport: canonical.config.transport,
    config: canonical.config,
    sourceRefs: [{ backend: "claude", scope, filePath }],
    configSignature: signatureFor(canonical.config, "claude"),
    reserved: false,
    diagnostics: [],
  };

  return { server: definition };
}

type ClaudeCanonicalOutcome =
  | { config: McpCanonicalServerConfig }
  | { error: string; code: string };

function toCanonicalClaudeConfig(
  entry: Record<string, unknown>,
  typeField: string | undefined,
): ClaudeCanonicalOutcome {
  // Claude treats absent `type` as stdio. `http` and `sse` are the two
  // remote transports exposed through the SDK.
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
            args: entry["args"].filter(
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

  return {
    code: "mcp.source.unknown-transport",
    error: `Unknown MCP server transport "${transport}"`,
  };
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

function countByScope(servers: readonly McpServerDefinition[]): {
  user: number;
  project: number;
  local: number;
} {
  const counts = { user: 0, project: 0, local: 0 };
  for (const s of servers) {
    const scope = s.sourceRefs[0]?.scope;
    if (scope === "user" || scope === "project" || scope === "local") {
      counts[scope]++;
    }
  }
  return counts;
}

export function signatureFor(
  config: McpCanonicalServerConfig,
  backend: string,
): string {
  const normalized = JSON.stringify({
    backend,
    ...config,
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
