import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";
import type { ValidatorRunnerDeps } from "../validator-runner";
import type { SeededValidatorAssignment } from "../config-schemas";
import type { GraphWorkflowResolvedContext } from "../definition-schemas";
import type { GraphWorkflowExecution } from "../schemas";
import { assignmentFingerprint, laneStateKey } from "../lane-identity";
import { createValidatorRuntimeInstructionReader } from "../validator-runtime-instructions";

/** The production host, actor, instruction reader, facade, and durable profile. */
export function createValidatorConversationHarness(options: {
  backendFactory: ConversationBackendFactory;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowResolvedContext;
  validator: SeededValidatorAssignment;
  worktreePath: string;
}): Required<
  Pick<ValidatorRunnerDeps, "executeConversationTurn" | "stopConversationActor">
> {
  let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
  return {
    async executeConversationTurn(input) {
      const conversationId = input.binding.address.target.conversationId;
      const execution: GraphWorkflowExecution = {
        ...options.execution,
        workingDefinition: {
          ...options.execution.workingDefinition,
          executionContexts:
            options.execution.workingDefinition.executionContexts.map(
              (context) =>
                context.id === options.context.id ? options.context : context,
            ),
        },
        laneStates: {
          ...options.execution.laneStates,
          [options.context.id]: {
            [laneStateKey("context_validator", options.validator.id)]: {
              lane: "context_validator",
              contextId: options.context.id,
              assignmentId: options.validator.id,
              assignmentFingerprint: assignmentFingerprint(options.validator),
              backend: options.validator.agent.backend,
              workflowConversationId: conversationId,
              metrics: {},
              lastUsedAt: "2026-09-20T00:00:00.000Z",
            },
          },
        },
      };
      fixture = await createLifecycleFixture({
        binding: input.binding,
        conversation: {
          agentBackend: options.validator.agent.backend,
          role: "validator",
          profileSnapshot: options.validator.profileSnapshot,
        },
        actorDeps: {
          getConversationBackendFactory: () => options.backendFactory,
          getWorkflowLaneInstructions: createValidatorRuntimeInstructionReader({
            getActiveExecution: async () => execution,
            readValidationConfig: async () => null,
          }),
          composePortableMcpForConversation: async () => ({ servers: [] }),
        },
      });
      return fixture.manager.executeConversationTurn({
        ...input,
        binding: { ...input.binding, worktreePath: options.worktreePath },
      });
    },
    async stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      reason,
    ) {
      try {
        await fixture?.manager.stopConversationActor(
          projectPath,
          sessionName,
          conversationId,
          reason,
        );
      } finally {
        await fixture?.close();
        fixture = undefined;
      }
    },
  };
}
