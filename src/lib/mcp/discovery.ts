import { createLogger } from "@/lib/logging";
import type {
  AgentBackendId,
  McpBackendAvailability,
  McpDiagnostic,
} from "@/lib/schemas";

import { signatureFor } from "./discovery-claude";
import { discoverClaudeSources } from "./discovery-claude";
import { discoverCodexSources } from "./discovery-codex";
import type {
  McpCanonicalServerConfig,
  McpNativeFilterFields,
  McpServerDefinition,
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
  McpSourceFileStatus,
} from "./types";

const logger = createLogger("mcp.source-discovery");

export async function discoverAllSources(
  input: McpSourceDiscoveryInput,
): Promise<McpSourceDiscoveryResult> {
  const backends = input.backends ?? (["claude", "codex"] as const);
  const includeClaude = backends.includes("claude");
  const includeCodex = backends.includes("codex");

  const [claudeResult, codexResult] = await Promise.all([
    includeClaude
      ? discoverClaudeSources({
          worktreePath: input.worktreePath,
          homePath: input.homePath,
        })
      : Promise.resolve(emptyResult()),
    includeCodex
      ? discoverCodexSources({
          worktreePath: input.worktreePath,
          homePath: input.homePath,
        })
      : Promise.resolve(emptyResult()),
  ]);

  const diagnostics: McpDiagnostic[] = [
    ...claudeResult.diagnostics,
    ...codexResult.diagnostics,
  ];
  const sourceFiles: McpSourceFileStatus[] = [
    ...claudeResult.sourceFiles,
    ...codexResult.sourceFiles,
  ];

  const servers = coalesceServers([
    ...claudeResult.servers,
    ...codexResult.servers,
  ]);

  logger.info("MCP source discovery complete", {
    worktreePath: input.worktreePath,
    backends: Array.from(backends),
    serverCount: servers.length,
    claudeCount: claudeResult.servers.length,
    codexCount: codexResult.servers.length,
    diagnosticCount: diagnostics.length,
  });

  return { servers, diagnostics, sourceFiles };
}

function emptyResult(): McpSourceDiscoveryResult {
  return { servers: [], diagnostics: [], sourceFiles: [] };
}

function coalesceServers(
  servers: readonly McpServerDefinition[],
): McpServerDefinition[] {
  const byKey = new Map<string, McpServerDefinition[]>();
  for (const server of servers) {
    const existing = byKey.get(server.serverKey);
    if (existing) {
      existing.push(server);
    } else {
      byKey.set(server.serverKey, [server]);
    }
  }

  const result: McpServerDefinition[] = [];
  for (const group of byKey.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only) result.push(only);
      continue;
    }
    const partition = partitionByEquivalentConfig(group);
    for (const equivalent of partition) {
      if (equivalent.length === 1) {
        const only = equivalent[0];
        if (only) result.push(only);
      } else {
        result.push(mergeIntoShared(equivalent));
      }
    }
  }
  return result;
}

/**
 * Group definitions sharing a serverKey into sub-groups whose non-secret
 * canonical config matches. Each sub-group becomes a single row — either
 * `shared` (when it spans backends) or a backend-tagged row (single backend).
 */
function partitionByEquivalentConfig(
  group: readonly McpServerDefinition[],
): McpServerDefinition[][] {
  const buckets: McpServerDefinition[][] = [];
  for (const server of group) {
    const target = buckets.find((bucket) => {
      const first = bucket[0];
      return first !== undefined && equivalentNonSecret(first, server);
    });
    if (target) {
      target.push(server);
    } else {
      buckets.push([server]);
    }
  }
  return buckets;
}

function equivalentNonSecret(
  a: McpServerDefinition,
  b: McpServerDefinition,
): boolean {
  return (
    nonSecretSignature(a.config) === nonSecretSignature(b.config) &&
    a.transport === b.transport
  );
}

function nonSecretSignature(config: McpCanonicalServerConfig): string {
  // Compute a signature that excludes env/header values. Keys are kept so a
  // config that adds an env var still differs from one that doesn't.
  if (config.transport === "stdio") {
    return signatureFor(
      {
        transport: "stdio",
        command: config.command,
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.env !== undefined
          ? { env: keysOnlyRecord(config.env) }
          : {}),
        ...(config.startupTimeoutSec !== undefined
          ? { startupTimeoutSec: config.startupTimeoutSec }
          : {}),
        ...(config.toolTimeoutSec !== undefined
          ? { toolTimeoutSec: config.toolTimeoutSec }
          : {}),
      },
      "shared",
    );
  }
  if (config.transport === "streamable-http") {
    return signatureFor(
      {
        transport: "streamable-http",
        url: config.url,
        ...(config.headers !== undefined
          ? { headers: keysOnlyRecord(config.headers) }
          : {}),
        ...(config.bearerTokenEnvVar !== undefined
          ? { bearerTokenEnvVar: config.bearerTokenEnvVar }
          : {}),
        ...(config.startupTimeoutSec !== undefined
          ? { startupTimeoutSec: config.startupTimeoutSec }
          : {}),
        ...(config.toolTimeoutSec !== undefined
          ? { toolTimeoutSec: config.toolTimeoutSec }
          : {}),
      },
      "shared",
    );
  }
  return signatureFor(
    {
      transport: "sse",
      url: config.url,
      ...(config.headers !== undefined
        ? { headers: keysOnlyRecord(config.headers) }
        : {}),
    },
    "shared",
  );
}

function keysOnlyRecord(
  record: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    out[key] = "";
  }
  return out;
}

function mergeIntoShared(
  group: readonly McpServerDefinition[],
): McpServerDefinition {
  const first = group[0];
  if (!first) {
    throw new Error("mergeIntoShared called with empty group");
  }
  const backends = new Set<AgentBackendId>();
  for (const server of group) {
    for (const ref of server.sourceRefs) {
      backends.add(ref.backend);
    }
  }
  const availability: McpBackendAvailability =
    backends.size > 1
      ? "shared"
      : (group[0]?.backend as McpBackendAvailability);

  const mergedNative = mergeNativeFilterFields(group);
  const mergedDiagnostics = group.flatMap((s) => s.diagnostics);
  const mergedSourceRefs = group.flatMap((s) => s.sourceRefs);

  return {
    serverKey: first.serverKey,
    nativeId: first.nativeId,
    backend: availability,
    transport: first.transport,
    config: first.config,
    ...(mergedNative !== undefined ? { native: mergedNative } : {}),
    sourceRefs: mergedSourceRefs,
    configSignature: first.configSignature,
    reserved: group.some((s) => s.reserved),
    diagnostics: mergedDiagnostics,
  };
}

function mergeNativeFilterFields(
  group: readonly McpServerDefinition[],
): McpNativeFilterFields | undefined {
  const merged: McpNativeFilterFields = {};
  let hasField = false;
  for (const server of group) {
    if (!server.native) continue;
    if (server.native.enabled !== undefined && merged.enabled === undefined) {
      merged.enabled = server.native.enabled;
      hasField = true;
    }
    if (
      server.native.enabledTools !== undefined &&
      merged.enabledTools === undefined
    ) {
      merged.enabledTools = server.native.enabledTools;
      hasField = true;
    }
    if (
      server.native.disabledTools !== undefined &&
      merged.disabledTools === undefined
    ) {
      merged.disabledTools = server.native.disabledTools;
      hasField = true;
    }
  }
  return hasField ? merged : undefined;
}
