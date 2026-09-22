import {
  createCapabilityRuntimeApplyService,
  type ApplyServiceDeps,
} from "@/lib/agent-capabilities/apply";
import { type ConversationStartCapabilityComposerInput } from "@/lib/agent-capabilities/default-deps";
import {
  createCapabilityConfigComposer,
  type ComposedProjectConversationCapabilitySeed,
} from "@/lib/agent-capabilities/runtime-seed";
import type { ComposeConversationStartResult } from "@/lib/agent-capabilities/runtime-composer";
import { createMcpRuntimeApplyService } from "@/lib/mcp/runtime-apply";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { ConversationPolicyDependencies } from "./actor-dependencies";
import type { ConversationPolicyState } from "./policy-state";

export interface ConversationPolicyInfrastructure {
  composePortableMcp: ConversationPolicyDependencies["composePortableMcpForConversation"];
  composeCapabilities(
    input: ConversationStartCapabilityComposerInput,
  ): Promise<ComposeConversationStartResult>;
  composeDurableProject: ConversationPolicyDependencies["composeCapabilityConfigForProjectConversation"];
  applyRuntimeConfig: NonNullable<ApplyServiceDeps["applyRuntimeConfig"]>;
}

export function createConversationRuntimePolicy(
  deps: ConversationPolicyInfrastructure,
  input: {
    persistence: "durable" | "ephemeral";
    projectName: string;
    worktreePath: string;
    state: ConversationPolicyState;
    getRuntime(): ConversationBackendRuntime | undefined;
    getTooling(): ConversationToolingOverrides | undefined;
  },
): ConversationPolicyDependencies {
  const mcp = createMcpRuntimeApplyService({
    applicationState: input.state.mcp,
    getRuntime: input.getRuntime,
    async resolvePortableForConversation(identity) {
      return {
        portable: await deps.composePortableMcp({
          ...identity,
          worktreePath: input.worktreePath,
          transientPortableMcp: input.getTooling()?.portableMcp,
        }),
      };
    },
  });
  const capabilities = createCapabilityRuntimeApplyService({
    async listAffectedConversations() {
      return [];
    },
    composeForConversation: deps.composeCapabilities,
    readRuntimeState: input.state.readCapabilities,
    updateRuntimeState: input.state.updateCapabilities,
    applyRuntimeConfig: deps.applyRuntimeConfig,
  });
  const composeSeed = createCapabilityConfigComposer(deps.composeCapabilities);
  return {
    state: input.state,
    composePortableMcpForConversation: deps.composePortableMcp,
    applyMcpAtTurnStart: mcp.applyAtTurnStart,
    applyCapabilityAtTurnStart: capabilities.applyAtTurnStart,
    composeCapabilityConfigForConversation: composeSeed,
    async composeCapabilityConfigForProjectConversation(
      identity,
    ): Promise<ComposedProjectConversationCapabilitySeed | undefined> {
      if (input.persistence === "durable")
        return deps.composeDurableProject(identity);
      const backend = identity.backend;
      const seed = await composeSeed({
        ...identity,
        conversationScope: "project",
        backend,
        worktreePath: input.worktreePath,
      });
      return seed ? { ...seed, backend } : undefined;
    },
  };
}
