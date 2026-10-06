import type { ConversationBackendEvent, ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import { recordCapabilityConfigReceipt } from "@/lib/agent-capabilities/runtime-receipt";
import { seededCapabilityRuntimeState } from "@/lib/agent-capabilities/runtime-seed";
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

export type SeededRuntime = Pick<
  ConversationBackendRuntime,
  "mcpConfigDelivery" | "capabilityConfigDelivery" | "capabilitiesAtCreation"
>;

/** A runtime's configuration baseline, opened before its configuration is composed. */
export interface RuntimeSeeding {
  /**
   * The runtime was created from `composed`: persist the baseline its delivery
   * is compared against. A change saved since the seeding began is newer than
   * `composed`, so it stays pending rather than being replaced.
   */
  commit(composed: ComposedTooling, runtime: SeededRuntime): Promise<void>;
}

export interface RuntimeApplicationState {
  /** Reads the application state a runtime about to be composed is created over. */
  beginSeed(conversation: ApplicationTarget): Promise<RuntimeSeeding>;
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
 * backend's acceptance settles it. There is no turn-start apply: a change
 * saved while a core turn runs applies to the runtime its next turn creates.
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
    async beginSeed(conversation) {
      const identity = { projectPath: conversation.projectPath, target: conversation.target };
      const row = await deps.conversations.getConversation(
        conversation.projectPath,
        conversationTargetStoreSessionName(conversation.target),
        conversation.target.conversationId,
      );
      const before = {
        pendingConfigHash: row?.mcpRuntime?.pendingConfigHash,
        capabilities: row?.agentCapabilitiesRuntime,
      };
      return {
        async commit(composed, runtime) {
          const { portableMcp } = composed.overrides;
          if (portableMcp !== undefined)
            await seedMcpRuntimeState(mcp, identity, portableMcp, runtime.mcpConfigDelivery, before);
          const { capabilityState } = composed;
          if (capabilityState !== undefined) {
            await updateCapabilities(conversation, "conversation_core.seedCapabilityRuntime", (current) =>
              seededCapabilityRuntimeState({
                seeded: capabilityState,
                delivered:
                  runtime.capabilityConfigDelivery === "input-accepted" ? undefined : runtime.capabilitiesAtCreation,
                current,
                before: before.capabilities,
              }),
            );
          }
          deps.log.info("conversation_core.runtime_application_seeded", {
            conversationId: conversation.target.conversationId,
            mcpSeeded: portableMcp !== undefined,
            seededCascadeKinds: Object.keys(capabilityState?.cascades ?? {}),
          });
        },
      };
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
