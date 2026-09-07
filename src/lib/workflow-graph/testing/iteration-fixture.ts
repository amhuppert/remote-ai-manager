import type { GraphWorkflowRunAgentIterationInput } from "../iteration-orchestrator";
import {
  createGraphWorkflowContextIteration,
  createGraphWorkflowGates,
  type ContextIterationPorts,
} from "../engine-composition";
import { createValidatorCohortRunner } from "../validator-cohort-runner";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { randomUUID } from "node:crypto";

import { createGraphWorkflowExecutionToolContext } from "../execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "../runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "../shared-documents";
import { createGraphWorkflowExecutionEventPublisher } from "../execution-events";
import type { GraphWorkflowExecution } from "../schemas";

export interface BoundIterationCompletion extends Pick<
  GraphWorkflowRunAgentIterationInput,
  | "projectPath"
  | "projectName"
  | "sessionName"
  | "executionId"
  | "conversationId"
  | "contextId"
> {
  contextTitle: string;
  allowAgentTaskAdd: boolean;
  sharedDocuments: GraphWorkflowExecution["sharedDocuments"];
  completeTask(
    taskId: string,
    summary: string,
  ): Promise<GraphWorkflowExecution>;
}

type FixtureDefaultKeys =
  | "validationService"
  | "continuityService"
  | "signalHalt"
  | "eventPublisher"
  | "approvalGateService"
  | "userInputGateService"
  | "readLaneConversation"
  | "readRepoConfig"
  | "createTaskId";
export type ContextIterationFixtureDeps = Omit<
  ContextIterationPorts,
  FixtureDefaultKeys
> &
  Partial<Pick<ContextIterationPorts, FixtureDefaultKeys>> & {
    bindTaskCompletion?(input: BoundIterationCompletion): void;
  };

export function createIterationFixturePorts(
  deps: ContextIterationFixtureDeps,
): ContextIterationPorts {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const gates = createGraphWorkflowGates({
    getActive: deps.executionRepository.getActive,
    mutateActive: deps.executionRepository.mutateActive,
    clearConversationQuestion: async () => false,
    eventPublisher,
    now: deps.now ?? (() => new Date().toISOString()),
  });
  return {
    ...deps,
    eventPublisher,
    approvalGateService: deps.approvalGateService ?? gates.approvalGateService,
    userInputGateService:
      deps.userInputGateService ?? gates.userInputGateService,
    readLaneConversation: deps.readLaneConversation ?? (async () => null),
    readRepoConfig: deps.readRepoConfig ?? readRepoConfig,
    continuityService: deps.continuityService ?? null,
    signalHalt:
      deps.signalHalt ??
      (async () => {
        throw new Error("Halt handling is outside this fixture");
      }),
    validationService:
      deps.validationService ??
      createValidatorCohortRunner({
        runContextValidator: async () => {
          throw new Error("Reviewer dispatch is outside this fixture");
        },
      }),
    createTaskId: deps.createTaskId ?? (() => `task-${randomUUID()}`),
  };
}

export function createContextIterationFixture(
  deps: ContextIterationFixtureDeps,
) {
  const ports = createIterationFixturePorts(deps);
  const publisher = ports.eventPublisher;
  const tasks = createGraphWorkflowExecutionToolContext({
    executionRepository: deps.executionRepository,
    executionContract: deps.executionContract,
    runtimeEditService: createGraphWorkflowRuntimeEditService(),
    sharedDocumentRegistry: createGraphWorkflowSharedDocumentRegistryService(),
    publishLiveEditApplied: publisher.publishLiveEditApplied,
    readLiveOccupancy: () => null,
    now: deps.now,
  });
  return createGraphWorkflowContextIteration({
    ...ports,
    async runAgentIteration(input) {
      if (deps.bindTaskCompletion) {
        const execution = await deps.executionRepository.getActive(
          input.projectPath,
          input.sessionName,
        );
        const context = execution?.workingDefinition.executionContexts.find(
          (context) => context.id === input.contextId,
        );
        if (!execution || !context)
          throw new Error("Iteration fixture context missing");
        const bound = tasks.create({
          ...input,
          executionContextTitle: context.title,
          allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
          allowAgentCollaboration:
            context.collaboration?.enabled.value ?? false,
          executionTarget: input.executionTarget ?? {
            worktreePath: input.projectPath,
            branchName: "fixture",
            isolation: "session",
            laneId: null,
          },
        });
        deps.bindTaskCompletion({
          ...input,
          contextTitle: context.title,
          allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
          sharedDocuments: execution.sharedDocuments,
          completeTask: async (taskId, summary) =>
            (await bound.completeTask(taskId, summary)).execution,
        });
      }
      return deps.runAgentIteration(input);
    },
  });
}
