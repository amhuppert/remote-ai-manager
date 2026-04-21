import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { createLogger } from "@/lib/logging";
import type { McpDefinitionScope, McpDiagnostic } from "@/lib/schemas";

import { signatureFor } from "./discovery-claude";
import type {
  McpCanonicalServerConfig,
  McpNativeFilterFields,
  McpServerDefinition,
  McpSourceDiscoveryResult,
  McpSourceFileStatus,
} from "./types";

const logger = createLogger("mcp.source-discovery");

interface CodexSource {
  scope: McpDefinitionScope;
  filePath: string;
}

export interface DiscoverCodexInput {
  worktreePath: string;
  homePath: string;
}

export async function discoverCodexSources(
  input: DiscoverCodexInput,
): Promise<McpSourceDiscoveryResult> {
  const sources = buildCodexSources(input);
  const servers: McpServerDefinition[] = [];
  const diagnostics: McpDiagnostic[] = [];
  const sourceFiles: McpSourceFileStatus[] = [];

  for (const source of sources) {
    const outcome = await readCodexSource(source);
    sourceFiles.push(outcome.status);
    diagnostics.push(...outcome.diagnostics);
    servers.push(...outcome.servers);
  }

  logger.info("Codex MCP discovery complete", {
    worktreePath: input.worktreePath,
    serverCount: servers.length,
    scopes: countByScope(servers),
  });

  return { servers, diagnostics, sourceFiles };
}

function buildCodexSources({
  worktreePath,
  homePath,
}: DiscoverCodexInput): CodexSource[] {
  return [
    {
      scope: "project",
      filePath: path.join(worktreePath, ".codex", "config.toml"),
    },
    {
      scope: "user",
      filePath: path.join(homePath, ".codex", "config.toml"),
    },
  ];
}

interface CodexSourceOutcome {
  status: McpSourceFileStatus;
  servers: McpServerDefinition[];
  diagnostics: McpDiagnostic[];
}

async function readCodexSource(
  source: CodexSource,
): Promise<CodexSourceOutcome> {
  const sourceRef = {
    backend: "codex" as const,
    scope: source.scope,
    filePath: source.filePath,
  };

  if (!(await fileExists(source.filePath))) {
    return {
      status: {
        backend: "codex",
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
          message: `Codex MCP source file not present: ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = await readFile(source.filePath, "utf-8");
  } catch {
    logger.warn("Codex MCP source unreadable", {
      filePath: source.filePath,
      scope: source.scope,
    });
    return {
      status: {
        backend: "codex",
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
          message: `Unable to read Codex MCP source at ${source.filePath}`,
          sourceRef,
        },
      ],
    };
  }

  let parsed: unknown;
  let parseLocation: string | undefined;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    parseLocation = safeLocationFromTomlError(err);
    logger.warn("Codex MCP source malformed", {
      filePath: source.filePath,
      scope: source.scope,
      ...(parseLocation !== undefined ? { location: parseLocation } : {}),
    });
    // Sanitize diagnostic — smol-toml error.message embeds a `codeblock`
    // excerpt of the offending lines. Those lines may contain env values,
    // bearer tokens, or header values from the malformed source. Only the
    // path and (if safely extractable) line/column leave this boundary.
    const location = parseLocation !== undefined ? ` (${parseLocation})` : "";
    return {
      status: {
        backend: "codex",
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
          message: `Codex MCP source at ${source.filePath} is not valid TOML${location}`,
          sourceRef,
        },
      ],
    };
  }

  const mcpServers = extractMcpServersTable(parsed);
  if (!mcpServers) {
    return {
      status: {
        backend: "codex",
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
    const parsedServer = parseCodexServerEntry(
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
      backend: "codex",
      scope: source.scope,
      filePath: source.filePath,
      status: servers.length > 0 ? "read" : "empty",
      serverCount: servers.length,
    },
    servers,
    diagnostics,
  };
}

function extractMcpServersTable(
  parsed: unknown,
): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const table = obj["mcp_servers"];
  if (!table || typeof table !== "object") return null;
  return table as Record<string, unknown>;
}

type ParsedServer =
  | { server: McpServerDefinition }
  | { diagnostic: McpDiagnostic };

function parseCodexServerEntry(
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
        message: `Entry for ${nativeId} is not a table`,
        serverKey: nativeId,
        sourceRef: { backend: "codex", scope, filePath },
      },
    };
  }
  const entry = rawEntry as Record<string, unknown>;
  const canonical = toCanonicalCodexConfig(entry);
  if ("error" in canonical) {
    return {
      diagnostic: {
        severity: "error",
        code: canonical.code,
        message: canonical.error,
        serverKey: nativeId,
        sourceRef: { backend: "codex", scope, filePath },
      },
    };
  }

  const native = extractCodexNativeFields(entry);

  const definition: McpServerDefinition = {
    serverKey: nativeId,
    nativeId,
    backend: "codex",
    transport: canonical.config.transport,
    config: canonical.config,
    ...(native !== undefined ? { native } : {}),
    sourceRefs: [{ backend: "codex", scope, filePath }],
    configSignature: signatureFor(canonical.config, "codex"),
    reserved: false,
    diagnostics: [],
  };

  return { server: definition };
}

type CodexCanonicalOutcome =
  | { config: McpCanonicalServerConfig }
  | { error: string; code: string };

function toCanonicalCodexConfig(
  entry: Record<string, unknown>,
): CodexCanonicalOutcome {
  const hasCommand = typeof entry["command"] === "string";
  const hasUrl = typeof entry["url"] === "string";

  if (!hasCommand && !hasUrl) {
    return {
      code: "mcp.source.invalid-entry",
      error: "Codex MCP server must declare either `command` or `url`",
    };
  }

  if (hasCommand) {
    const config: McpCanonicalServerConfig = {
      transport: "stdio",
      command: entry["command"] as string,
      ...(Array.isArray(entry["args"])
        ? {
            args: (entry["args"] as unknown[]).filter(
              (v): v is string => typeof v === "string",
            ),
          }
        : {}),
      ...(typeof entry["cwd"] === "string" ? { cwd: entry["cwd"] } : {}),
      ...(isStringRecord(entry["env"]) ? { env: entry["env"] } : {}),
      ...(typeof entry["startup_timeout_sec"] === "number"
        ? { startupTimeoutSec: entry["startup_timeout_sec"] }
        : {}),
      ...(typeof entry["tool_timeout_sec"] === "number"
        ? { toolTimeoutSec: entry["tool_timeout_sec"] }
        : {}),
    };
    return { config };
  }

  const url = entry["url"] as string;
  const headersValue = entry["http_headers"];
  const config: McpCanonicalServerConfig = {
    transport: "streamable-http",
    url,
    ...(isStringRecord(headersValue) ? { headers: headersValue } : {}),
    ...(typeof entry["bearer_token_env_var"] === "string"
      ? { bearerTokenEnvVar: entry["bearer_token_env_var"] }
      : {}),
    ...(typeof entry["startup_timeout_sec"] === "number"
      ? { startupTimeoutSec: entry["startup_timeout_sec"] }
      : {}),
    ...(typeof entry["tool_timeout_sec"] === "number"
      ? { toolTimeoutSec: entry["tool_timeout_sec"] }
      : {}),
  };
  return { config };
}

function extractCodexNativeFields(
  entry: Record<string, unknown>,
): McpNativeFilterFields | undefined {
  const native: McpNativeFilterFields = {};
  let hasField = false;
  if (typeof entry["enabled"] === "boolean") {
    native.enabled = entry["enabled"];
    hasField = true;
  }
  if (isStringArray(entry["enabled_tools"])) {
    native.enabledTools = entry["enabled_tools"];
    hasField = true;
  }
  if (isStringArray(entry["disabled_tools"])) {
    native.disabledTools = entry["disabled_tools"];
    hasField = true;
  }
  return hasField ? native : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
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

// Extract only numeric line/column from a smol-toml error. Never touch
// `err.message` or `err.codeblock` — they embed raw source excerpts which
// can contain env values, headers, or bearer tokens from the malformed file.
function safeLocationFromTomlError(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;
  const line = typeof record["line"] === "number" ? record["line"] : undefined;
  const column =
    typeof record["column"] === "number" ? record["column"] : undefined;
  if (line === undefined && column === undefined) return undefined;
  const parts: string[] = [];
  if (line !== undefined) parts.push(`line ${line}`);
  if (column !== undefined) parts.push(`column ${column}`);
  return parts.join(", ");
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
