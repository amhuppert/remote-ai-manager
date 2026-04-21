/**
 * Compose the emitted `PortableMcpConfig` for a single conversation turn.
 *
 * Two layers:
 *
 * 1. `composePortableForConversation` (pure) — wraps `mergeOverrideChain` and
 *    `composeRuntimeMcpConfig` to honor the four-level cascade, gateway
 *    protection, and orphan omission. Appends transient caller-supplied
 *    tooling (graph workflow / validator) by id, replacing any colliding base
 *    entry so one-shot task runners keep working unchanged.
 *
 * 2. `createComposePortableMcpForConversation` (factory) — reads all four
 *    override levels and discovery through injected deps, then delegates to
 *    the pure function. The resulting closure is the single call site the
 *    conversation actor uses instead of `mergePortableMcpConfigs` at build
 *    time.
 */

import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { AgentBackendId, McpOverrides } from "@/lib/schemas";

import { composeRuntimeMcpConfig } from "./composer";
import { mergeOverrideChain, type McpOverrideChain } from "./resolver";
import type { McpServerDefinition, McpSourceDiscoveryResult } from "./types";

export interface ComposePortableForConversationPureInput {
  backend: AgentBackendId;
  overrideChain: McpOverrideChain;
  discovered: readonly McpServerDefinition[];
  gatewayServers: readonly PortableMcpServerConfig[];
  transientPortableMcp?: PortableMcpConfig;
}

export interface ComposePortableForConversationPureResult {
  portable: PortableMcpConfig;
  omittedOrphanServerKeys: readonly string[];
  droppedServerKeys: readonly string[];
}

/**
 * Pure compose: already-resolved override chain + discovery + gateway +
 * transient → final `PortableMcpConfig`.
 */
export function composePortableForConversation(
  input: ComposePortableForConversationPureInput,
): ComposePortableForConversationPureResult {
  const effective = mergeOverrideChain(input.overrideChain, "conversation");
  const composed = composeRuntimeMcpConfig({
    backend: input.backend,
    discovered: input.discovered,
    effective,
    gatewayServers: input.gatewayServers,
  });

  const portable = mergeTransientLast(
    composed.portable,
    input.transientPortableMcp,
  );

  return {
    portable,
    omittedOrphanServerKeys: composed.omittedOrphanServerKeys,
    droppedServerKeys: composed.droppedServerKeys,
  };
}

function mergeTransientLast(
  base: PortableMcpConfig,
  transient: PortableMcpConfig | undefined,
): PortableMcpConfig {
  if (!transient || transient.servers.length === 0) return base;
  const byId = new Map<string, PortableMcpServerConfig>();
  for (const server of base.servers) byId.set(server.id, server);
  for (const server of transient.servers) byId.set(server.id, server);
  return { servers: Array.from(byId.values()) };
}

// ---------------------------------------------------------------------------
// Factory layer — reads all four override levels + discovery through deps.
// ---------------------------------------------------------------------------

export interface ComposePortableMcpDeps {
  readGlobalOverrides(): Promise<McpOverrides>;
  readProjectOverrides(projectPath: string): Promise<McpOverrides | undefined>;
  readSessionOverrides(
    projectPath: string,
    sessionName: string,
  ): Promise<McpOverrides | undefined>;
  readConversationOverrides(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<McpOverrides | undefined>;
  discoverSources(input: {
    worktreePath: string;
    homePath: string;
    backends?: readonly AgentBackendId[];
  }): Promise<McpSourceDiscoveryResult>;
  homePath(): string;
  buildGatewayServers(
    projectName: string,
    sessionName: string,
  ): readonly PortableMcpServerConfig[];
}

export interface ComposePortableMcpArgs {
  backend: AgentBackendId;
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  /** Optional caller-supplied tooling (e.g., graph workflow context tools).
   * Merged last so one-shot task runners continue to work. */
  transientPortableMcp?: PortableMcpConfig;
}

const EMPTY_OVERRIDES: McpOverrides = { servers: {} };

/**
 * Build the production compose function that reads all four override levels
 * and discovery from the current environment and produces a `PortableMcpConfig`.
 */
export function createComposePortableMcpForConversation(
  deps: ComposePortableMcpDeps,
): (args: ComposePortableMcpArgs) => Promise<PortableMcpConfig> {
  return async (args) => {
    const [
      globalOverrides,
      projectOverrides,
      sessionOverrides,
      conversationOverrides,
      discovery,
    ] = await Promise.all([
      deps.readGlobalOverrides(),
      deps.readProjectOverrides(args.projectPath),
      deps.readSessionOverrides(args.projectPath, args.sessionName),
      deps.readConversationOverrides(
        args.projectPath,
        args.sessionName,
        args.conversationId,
      ),
      deps.discoverSources({
        worktreePath: args.worktreePath,
        homePath: deps.homePath(),
        backends: [args.backend],
      }),
    ]);

    const overrideChain: McpOverrideChain = {
      global: globalOverrides ?? EMPTY_OVERRIDES,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
      ...(sessionOverrides !== undefined ? { session: sessionOverrides } : {}),
      ...(conversationOverrides !== undefined
        ? { conversation: conversationOverrides }
        : {}),
    };

    const gatewayServers = deps.buildGatewayServers(
      args.projectName,
      args.sessionName,
    );

    const { portable } = composePortableForConversation({
      backend: args.backend,
      overrideChain,
      discovered: discovery.servers,
      gatewayServers,
      ...(args.transientPortableMcp !== undefined
        ? { transientPortableMcp: args.transientPortableMcp }
        : {}),
    });

    return portable;
  };
}
