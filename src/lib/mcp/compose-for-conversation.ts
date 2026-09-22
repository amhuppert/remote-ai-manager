import type { ConversationTarget } from "@/lib/conversations/conversation-target";
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
import type { McpOverrides } from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { composeRuntimeMcpConfig } from "./composer";
import { mergeOverrideChain, type McpOverrideChain } from "./resolver";
import type { McpServerDefinition, McpSourceDiscoveryResult } from "./types";

export interface ComposePortableForConversationPureInput {
  overrideChain: McpOverrideChain;
  discovered: readonly McpServerDefinition[];
  gatewayServers: readonly PortableMcpServerConfig[];
  /** Ids reserved on the user-portable surface even when no gateway server is
   * emitted for them. Forwarded directly to `composeRuntimeMcpConfig`. */
  reservedGatewayIds: readonly string[];
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
    discovered: input.discovered,
    effective,
    gatewayServers: input.gatewayServers,
    reservedGatewayIds: input.reservedGatewayIds,
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
    target: ConversationTarget,
  ): Promise<McpOverrides | undefined>;
  discoverSources(input: {
    globalConfigPath: string;
    worktreePath?: string;
  }): Promise<McpSourceDiscoveryResult>;
  globalConfigPath(): string;
}

export interface ComposePortableMcpArgs {
  backend: AgentBackendId;
  projectPath: string;
  target: ConversationTarget;
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
      args.target.scope === "session"
        ? deps.readSessionOverrides(args.projectPath, args.target.sessionName)
        : undefined,
      deps.readConversationOverrides(args.projectPath, args.target),
      deps.discoverSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: args.worktreePath,
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

    const gatewayServers: readonly PortableMcpServerConfig[] = [];
    const reservedGatewayIds: readonly string[] = [];

    const { portable } = composePortableForConversation({
      overrideChain,
      discovered: discovery.servers,
      gatewayServers,
      reservedGatewayIds,
      ...(args.transientPortableMcp !== undefined
        ? { transientPortableMcp: args.transientPortableMcp }
        : {}),
    });

    return portable;
  };
}
