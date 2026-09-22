import type { AgentCapabilityRuntimeApplicationState } from "@/lib/agent-capabilities/schemas";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import {
  conversationTargetStoreSessionName,
  storeSessionNameFromScopeRef,
} from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { McpRuntimeApplicationStore } from "@/lib/mcp/runtime-apply";
import type { ManagedConversationRuntime } from "./runtime-binding";
import type { ConversationDurableEffects } from "./effects";

export interface ConversationPolicyState {
  mcp: McpRuntimeApplicationStore;
  readCapabilities(
    identity: ApplyConversationIdentity,
  ): Promise<AgentCapabilityRuntimeApplicationState | undefined>;
  updateCapabilities(
    identity: ApplyConversationIdentity,
    updater: (
      current: AgentCapabilityRuntimeApplicationState | undefined,
    ) => AgentCapabilityRuntimeApplicationState,
  ): Promise<void>;
}

export function createConversationPolicyState(input: {
  persistence: "durable" | "ephemeral";
  managed: ManagedConversationRuntime;
  effects: ConversationDurableEffects;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}): ConversationPolicyState {
  if (input.persistence === "ephemeral") {
    return {
      mcp: {
        async read() {
          return { found: true, state: input.managed.mcpApplicationState };
        },
        async update(_identity, _label, updater) {
          input.managed.mcpApplicationState = updater(
            input.managed.mcpApplicationState,
          );
        },
      },
      async readCapabilities() {
        return input.managed.capabilityApplicationState;
      },
      async updateCapabilities(_identity, updater) {
        input.managed.capabilityApplicationState = updater(
          input.managed.capabilityApplicationState,
        );
      },
    } satisfies ConversationPolicyState;
  }
  return {
    mcp: {
      async read(identity) {
        const row = await input.getConversation(
          identity.projectPath,
          conversationTargetStoreSessionName(identity.target),
          identity.target.conversationId,
        );
        return row ? { found: true, state: row.mcpRuntime } : { found: false };
      },
      async update(identity, label, updater) {
        await input.effects.mutateConversation(
          identity.projectPath,
          conversationTargetStoreSessionName(identity.target),
          identity.target.conversationId,
          label,
          (row) => {
            row.mcpRuntime = updater(row.mcpRuntime);
          },
        );
      },
    },
    async readCapabilities(identity) {
      return (
        await input.getConversation(
          identity.projectPath,
          storeSessionNameFromScopeRef(
            identity.conversationScope === "project"
              ? { scope: "project" }
              : { scope: "session", sessionName: identity.sessionName },
          ),
          identity.conversationId,
        )
      )?.agentCapabilitiesRuntime;
    },
    async updateCapabilities(identity, updater) {
      await input.effects.mutateConversation(
        identity.projectPath,
        storeSessionNameFromScopeRef(
          identity.conversationScope === "project"
            ? { scope: "project" }
            : { scope: "session", sessionName: identity.sessionName },
        ),
        identity.conversationId,
        "prompt.updateCapabilityRuntime",
        (row) => {
          row.agentCapabilitiesRuntime = updater(row.agentCapabilitiesRuntime);
        },
      );
    },
  } satisfies ConversationPolicyState;
}
