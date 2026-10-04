import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { ConversationBackendEvent, ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import { recordCapabilityConfigReceipt } from "@/lib/agent-capabilities/runtime-receipt";
import { reconcileDeliveredCapabilityState } from "@/lib/agent-capabilities/runtime-seed";
import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import { conversationTargetStoreSessionName, type ConversationTarget } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import {
  createMcpRuntimeApplicationStore,
  recordMcpConfigReceipt,
  seedMcpRuntimeState,
} from "@/lib/mcp/runtime-apply";
import type { McpConfigUpdatedEvent } from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendRuntimeIndex } from "@/lib/workflows/conversation/core-coexistence";

/** What a runtime is created with, and the capability baseline composed alongside it. */
export interface ComposedTooling {
  overrides: ConversationToolingOverrides;
  /** The desired state of each capability cascade in `overrides.capabilities`, as the composer seeded it. */
  capabilityState?: AgentCapabilityRuntimeApplicationState;
}

interface ApplicationTarget {
  projectPath: string;
  target: ConversationTarget;
}

export interface RuntimeApplicationState {
  /** A runtime was created from `composed`: persist the baseline its delivery is compared against. */
  seed(
    conversation: ApplicationTarget,
    composed: ComposedTooling,
    runtime: Pick<ConversationBackendRuntime, "mcpConfigDelivery" | "capabilityConfigDelivery" | "capabilitiesAtCreation">,
  ): Promise<void>;
  /** The backend accepted input under the configuration this event names. */
  recordAccepted(
    conversation: ApplicationTarget,
    event: Extract<ConversationBackendEvent, { type: "input_accepted" }>,
  ): Promise<void>;
}

export interface RuntimeApplicationStateDeps {
  conversations: Parameters<typeof createMcpRuntimeApplicationStore>[0];
  publish(event: McpConfigUpdatedEvent | AgentCapabilitiesUpdatedEvent): void;
  log: Pick<Logger, "info">;
}

/**
 * How a core conversation's MCP and capability configuration reached its
 * agent, recorded on the conversation row through the same transitions the
 * conversation actor uses. Every core runtime is created for its turn with
 * the current configuration, so creation seeds the baseline and the
 * backend's acceptance settles it. There is no turn-start apply: the actor's
 * looks runtimes up in the shared registry, which never holds a core runtime,
 * and would record every overridden capability as rejected.
 */
export function createRuntimeApplicationState(deps: RuntimeApplicationStateDeps): RuntimeApplicationState {
  const mcp = createMcpRuntimeApplicationStore(deps.conversations);

  function updateCapabilities(
    conversation: ApplicationTarget,
    label: string,
    updater: (current: AgentCapabilityRuntimeApplicationState | undefined) => AgentCapabilityRuntimeApplicationState,
  ): Promise<void> {
    return deps.conversations.mutateConversation(
      conversation.projectPath,
      conversationTargetStoreSessionName(conversation.target),
      conversation.target.conversationId,
      label,
      (row) => {
        row.agentCapabilitiesRuntime = updater(row.agentCapabilitiesRuntime);
      },
    );
  }

  return {
    async seed(conversation, composed, runtime) {
      const identity = { projectPath: conversation.projectPath, target: conversation.target };
      const { portableMcp } = composed.overrides;
      if (portableMcp !== undefined) await seedMcpRuntimeState(mcp, identity, portableMcp, runtime.mcpConfigDelivery);
      const { capabilityState } = composed;
      if (capabilityState !== undefined) {
        const baseline = reconcileDeliveredCapabilityState(
          capabilityState,
          runtime.capabilityConfigDelivery === "input-accepted" ? undefined : runtime.capabilitiesAtCreation,
        );
        await updateCapabilities(conversation, "conversation_core.seedCapabilityRuntime", () => baseline);
      }
      deps.log.info("conversation_core.runtime_application_seeded", {
        conversationId: conversation.target.conversationId,
        mcpSeeded: portableMcp !== undefined,
        seededCascadeKinds: Object.keys(capabilityState?.cascades ?? {}),
      });
    },

    async recordAccepted(conversation, event) {
      const identity = { projectPath: conversation.projectPath, target: conversation.target };
      if (event.mcpConfigHash !== undefined) {
        await recordMcpConfigReceipt(mcp, identity, event.mcpConfigHash, {
          error: event.mcpConfigError,
          emit: deps.publish,
        });
      }
      if (event.capabilities !== undefined) {
        await recordCapabilityConfigReceipt(
          conversation.target,
          event.capabilities,
          (updater) => updateCapabilities(conversation, "conversation_core.capabilityReceipt", updater),
          deps.publish,
        );
      }
    },
  };
}

/** What a status reader learns of a runtime: whether it lives and for which backend, never a handle to act on. */
export interface RuntimeStatus {
  status: ConversationBackendRuntime["status"];
  backend: AgentBackendId;
}

// One map per process: the build loads this module once for the instrumentation
// layer (where core turns register their runtimes) and once for the route layer
// (where configuration routes read them).
const coreRuntimes = getGlobalSingleton("__cc_core_runtime_index", () => new Map<string, ConversationBackendRuntime>());

/**
 * The runtimes core turns hold. Kept out of the shared runtime registry: live
 * delivery, commands and the actor's turn-start apply act on what that
 * registry returns, and none of them may act on a turn the core runs.
 */
export const coreRuntimeIndex: BackendRuntimeIndex = {
  register(conversationId, runtime) {
    coreRuntimes.set(conversationId, runtime);
  },
  unregister(conversationId, runtime) {
    if (coreRuntimes.get(conversationId) === runtime) coreRuntimes.delete(conversationId);
  },
};

/**
 * A runtime lookup that also sees the runtimes core turns hold, so a
 * configuration change saved while a core turn runs reports that it applies
 * next turn. For status readers only: a core runtime is answered with its
 * status, never as a runtime to call.
 */
export function withCoreRuntimes<R extends RuntimeStatus>(
  registered: (conversationId: string) => R | undefined,
): (conversationId: string) => R | RuntimeStatus | undefined {
  return (conversationId) => {
    const runtime = registered(conversationId);
    if (runtime !== undefined) return runtime;
    const core = coreRuntimes.get(conversationId);
    return core === undefined ? undefined : { status: core.status, backend: core.backend };
  };
}
