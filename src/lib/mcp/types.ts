/**
 * Internal domain types for the MCP discovery/resolver/composer pipeline.
 *
 * Persisted and API-facing shapes live in `src/lib/schemas.ts`. The types in
 * this module describe the canonical server definition used between discovery,
 * the cascade resolver, and the runtime composer.
 */

import type {
  AgentBackendId,
  McpBackendAvailability,
  McpDefinitionScope,
  McpDiagnostic,
  McpSourceRef,
  McpTransport,
} from "@/lib/schemas";

export interface McpCanonicalStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface McpCanonicalHttpServerConfig {
  transport: "streamable-http";
  url: string;
  headers?: Readonly<Record<string, string>>;
  bearerTokenEnvVar?: string;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface McpCanonicalSseServerConfig {
  transport: "sse";
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export type McpCanonicalServerConfig =
  | McpCanonicalStdioServerConfig
  | McpCanonicalHttpServerConfig
  | McpCanonicalSseServerConfig;

/**
 * Native per-server filter fields understood by Codex today. Claude sources do
 * not emit these — Claude enforces per-tool filtering through the `canUseTool`
 * fallback at emission time.
 */
export interface McpNativeFilterFields {
  enabled?: boolean;
  enabledTools?: readonly string[];
  disabledTools?: readonly string[];
}

export interface McpServerDefinition {
  /** Stable Command Center identifier. Equal to `nativeId` for single-source
   * definitions; coalesced definitions share a `serverKey` but carry multiple
   * `sourceRefs`. */
  serverKey: string;
  /** Backend-native identifier used for emission. */
  nativeId: string;
  backend: McpBackendAvailability;
  transport: McpTransport;
  /** Canonical config carrying raw (non-redacted) values for signature and
   * runtime emission. View-facing code must pass this through `redactForView`
   * before rendering, logging, or returning from API responses. */
  config: McpCanonicalServerConfig;
  /** Native filter fields (Codex). Ignored by translators that do not support
   * them. */
  native?: McpNativeFilterFields;
  sourceRefs: readonly McpSourceRef[];
  /** Stable hash of non-secret canonical config used to key tool discovery
   * caches. Secret values participate so the cache invalidates on rotation. */
  configSignature: string;
  /** CC-injected gateway servers are flagged reserved and not togglable. */
  reserved: boolean;
  diagnostics: readonly McpDiagnostic[];
}

export interface McpSourceFileStatus {
  backend: AgentBackendId;
  scope: McpDefinitionScope;
  filePath: string;
  status: "read" | "missing" | "malformed" | "unreadable" | "empty";
  /** Number of servers successfully parsed from this file. */
  serverCount: number;
}

export interface McpSourceDiscoveryResult {
  servers: readonly McpServerDefinition[];
  diagnostics: readonly McpDiagnostic[];
  sourceFiles: readonly McpSourceFileStatus[];
}

export interface McpSourceDiscoveryInput {
  /** Absolute path to the active worktree (project-scope files live here). */
  worktreePath: string;
  /** Absolute path to the current user's home directory. Overridable so tests
   * can point discovery at a fixture tree. */
  homePath: string;
  /** Restrict discovery to specific backends when narrowing a scope view. */
  backends?: readonly AgentBackendId[];
}
