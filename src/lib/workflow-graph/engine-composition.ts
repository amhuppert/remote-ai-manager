import {
  createContextValidationCoordinator,
  type ContextValidationCoordinatorDeps,
} from "./context-validation-coordinator";
import {
  createContextLanding,
  type ContextLandingDeps,
} from "./context-landing";
import { createApprovalGateService } from "./approval-gate";
import {
  createUserInputGateService,
  type UserInputGateServiceDeps,
} from "./user-input-gate";
import { runCircuitBreakerGate } from "@/lib/workflows/primitives/circuit-breaker-gate";
import {
  createContextScheduler,
  type ContextSchedulerDeps,
} from "./context-scheduler";
import type { GraphExecutionContract } from "./execution-contract-port";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowExecutionEventPublisherDeps,
} from "./execution-events";
import {
  createGraphWorkflowExecutionRepository,
  type GraphWorkflowExecutionRepository,
  type GraphWorkflowExecutionRepositoryDeps,
} from "./execution-repository";
import {
  createGraphWorkflowManager,
  type GraphWorkflowManagerDeps,
} from "./workflow-manager";
import {
  createGraphWorkflowExecutionLoop,
  type GraphWorkflowExecutionLoopDeps,
  type GraphWorkflowExecutionLoopInput,
} from "./execution-loop";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowIterationOrchestratorDeps,
} from "./iteration-orchestrator";
import {
  createValidatorCohortRunner,
  type ValidatorCohortRunnerDeps,
} from "./validator-cohort-runner";
import { createGraphWorkflowSignalHaltHandler } from "./graph-workflow-signal-halt";
import {
  createPlanRepairSupervisor,
  type PlanRepairSupervisorDeps,
} from "./plan-repair/supervisor";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import {
  createGraphLaneStore,
  type GraphLaneStoreDeps,
} from "./graph-lane-store";
import {
  createGraphLaneContinuity,
  type GraphLaneContinuityDeps,
  type GraphLaneContinuity,
} from "./lane-continuity";

export type ContextIterationPorts = Omit<
  GraphWorkflowIterationOrchestratorDeps,
  "contextValidation"
> &
  Pick<
    ContextValidationCoordinatorDeps,
    | "validationService"
    | "scriptValidatorService"
    | "outputCaptureService"
    | "advisoryResponseService"
    | "createTaskId"
  >;

export function createGraphWorkflowContextIteration(
  ports: ContextIterationPorts,
) {
  const contextValidation = createContextValidationCoordinator({
    ...ports,
    now: ports.now ?? (() => new Date().toISOString()),
    runCircuitBreakerGate: ports.runCircuitBreakerGate ?? runCircuitBreakerGate,
  });
  return createGraphWorkflowIterationOrchestrator({
    ...ports,
    contextValidation,
  });
}

export type ExecutionServicesPorts = Omit<
  GraphWorkflowExecutionLoopDeps,
  "contextLanding"
> &
  Omit<ContextLandingDeps, "recordPendingHaltReason">;

export function createGraphWorkflowExecutionServices(
  ports: ExecutionServicesPorts,
) {
  const contextLanding = createContextLanding({
    ...ports,
    recordPendingHaltReason: ports.workflowManager.recordPendingHaltReason,
  });
  return createGraphWorkflowExecutionLoop({ ...ports, contextLanding });
}

export function createGraphWorkflowGates(
  ports: Pick<
    UserInputGateServiceDeps,
    "getActive" | "mutateActive" | "clearConversationQuestion" | "now"
  > & {
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >;
  },
) {
  return {
    approvalGateService: createApprovalGateService(ports),
    userInputGateService: createUserInputGateService({
      ...ports,
      publishUserInputPending: ports.eventPublisher.publishUserInputPending,
      publishUserInputResolved: ports.eventPublisher.publishUserInputResolved,
      deliver: ports.eventPublisher.deliver,
    }),
  };
}

type IterationDeps = ContextIterationPorts;
type ContextStorage = Pick<
  IterationDeps,
  "executionRepository" | "eventPublisher" | "findLatestContextValidationEvent"
>;
type ContextConversation = Pick<
  IterationDeps,
  | "createConversation"
  | "runAgentIteration"
  | "continuityService"
  | "readConversationTelemetry"
  | "outputCaptureService"
  | "advisoryResponseService"
>;
type ContextValidation = Pick<
  IterationDeps,
  "scriptValidatorService" | "validationRoundService"
> & {
  cohort: ValidatorCohortRunnerDeps;
};
type ContextPolicy = Omit<
  IterationDeps,
  | keyof ContextStorage
  | keyof ContextConversation
  | "validationService"
  | "scriptValidatorService"
  | "validationRoundService"
>;

export interface GraphWorkflowContextPorts {
  storage: ContextStorage;
  conversation: ContextConversation;
  validation: ContextValidation;
  policy: ContextPolicy;
}

export function createGraphWorkflowContextServices(
  ports: GraphWorkflowContextPorts,
) {
  const validationService = createValidatorCohortRunner(
    ports.validation.cohort,
  );
  const iterationOrchestrator = createGraphWorkflowContextIteration({
    ...ports.storage,
    ...ports.conversation,
    ...ports.policy,
    validationService,
    scriptValidatorService: ports.validation.scriptValidatorService,
    validationRoundService: ports.validation.validationRoundService,
  });
  return { validationService, iterationOrchestrator };
}

type EngineGit = Pick<
  ExecutionServicesPorts,
  | "parallelWorktrees"
  | "mergeMutex"
  | "sessionGitLock"
  | "soloContextCommitter"
  | "laneCommitter"
  | "joinRunner"
  | "executionTargetResolver"
>;
type EngineStorage = {
  repository(
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >,
  ): Omit<GraphWorkflowExecutionRepositoryDeps, "eventPublisher">;
  publication: GraphWorkflowExecutionEventPublisherDeps;
};

export interface GraphWorkflowEnginePorts {
  executionContract: GraphExecutionContract;
  storage: EngineStorage;
  lifecycle: Omit<
    GraphWorkflowManagerDeps,
    | "executionContract"
    | "executionRepository"
    | "eventPublisher"
    | "getSession"
  >;
  git: EngineGit;
  scheduler?: Pick<ContextSchedulerDeps, "createBatchId">;
  repair(input: {
    workflowManager: ReturnType<typeof createGraphWorkflowManager>;
    executionRepository: GraphWorkflowExecutionRepository;
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >;
    runExecutionLoopWithPlanRepair(
      input: GraphWorkflowExecutionLoopInput,
    ): Promise<void>;
  }): PlanRepairSupervisorDeps | null;
  clearConversationQuestion: UserInputGateServiceDeps["clearConversationQuestion"];
  conversation: Omit<
    GraphLaneContinuityDeps,
    "executionRepository" | "laneService"
  > &
    Pick<GraphLaneStoreDeps, "listActiveExecutions">;
  context(input: {
    executionRepository: GraphWorkflowExecutionRepository;
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >;
    continuityService: GraphLaneContinuity;
  }): Omit<GraphWorkflowContextPorts, "storage" | "policy"> & {
    storage: Omit<ContextStorage, "executionRepository" | "eventPublisher">;
    policy: Omit<
      ContextPolicy,
      | "signalHalt"
      | "executionContract"
      | "approvalGateService"
      | "userInputGateService"
    >;
  };
  execution: Omit<
    ExecutionServicesPorts,
    | "executionContract"
    | keyof EngineGit
    | "workflowManager"
    | "contextScheduler"
    | "executionRepository"
    | "iterationOrchestrator"
    | "approvalGateService"
    | "userInputGateService"
    | "eventPublisher"
  >;
}

export function createGraphWorkflowEngine(ports: GraphWorkflowEnginePorts) {
  const eventPublisher = createGraphWorkflowExecutionEventPublisher(
    ports.storage.publication,
  );
  const executionRepository = createGraphWorkflowExecutionRepository({
    ...ports.storage.repository(eventPublisher),
    eventPublisher,
  });
  const gates = createGraphWorkflowGates({
    getActive: executionRepository.getActive,
    mutateActive: executionRepository.mutateActive,
    clearConversationQuestion: ports.clearConversationQuestion,
    eventPublisher,
    now: ports.lifecycle.now ?? (() => new Date().toISOString()),
  });
  const workflowManager = createGraphWorkflowManager({
    ...ports.lifecycle,
    userInputGateService: gates.userInputGateService,
    executionContract: ports.executionContract,
    executionRepository,
    eventPublisher,
    getSession: ports.execution.getSession,
  });
  const contextScheduler = createContextScheduler({
    ...ports.scheduler,
    executionRepository,
    parallelWorktrees: ports.git.parallelWorktrees,
    getSession: ports.execution.getSession,
    now: ports.lifecycle.now,
  });
  /**
   * Durable lane continuity lives on the execution row (`laneStates`). Every
   * write uses the repository's critical section and loop fence so backend
   * continuity handles survive restarts.
   */
  const continuityService = createGraphLaneContinuity({
    ...ports.conversation,
    executionRepository,
    laneService: createLaneService({
      store: createGraphLaneStore({
        listActiveExecutions: ports.conversation.listActiveExecutions,
        mutateActiveExecution: executionRepository.mutateActive,
      }),
      now: ports.conversation.now,
    }),
  });
  const contextPorts = ports.context({
    executionRepository,
    eventPublisher,
    continuityService,
  });
  const contextServices = createGraphWorkflowContextServices({
    ...contextPorts,
    storage: { ...contextPorts.storage, executionRepository, eventPublisher },
    policy: {
      ...contextPorts.policy,
      ...gates,
      executionContract: ports.executionContract,
      signalHalt: createGraphWorkflowSignalHaltHandler(workflowManager),
    },
  });
  const executionLoop = createGraphWorkflowExecutionServices({
    ...ports.execution,
    ...gates,
    executionContract: ports.executionContract,
    ...ports.git,
    workflowManager,
    contextScheduler,
    executionRepository,
    iterationOrchestrator: contextServices.iterationOrchestrator,
    eventPublisher,
  });
  const repairDeps = ports.repair({
    workflowManager,
    executionRepository,
    eventPublisher,
    runExecutionLoopWithPlanRepair,
  });
  const planRepairSupervisor =
    repairDeps === null ? null : createPlanRepairSupervisor(repairDeps);

  /**
   * Loop settlement gives the bounded repair supervisor its next admission
   * point. A repair's resume re-enters this wrapper under the same round caps.
   */
  async function runExecutionLoopWithPlanRepair(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<void> {
    await executionLoop.run(input);
    await planRepairSupervisor?.maybeRunPlanRepair({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
    });
  }
  return {
    eventPublisher,
    executionRepository,
    workflowManager,
    continuityService,
    ...contextServices,
    contextScheduler,
    executionLoop,
    planRepairSupervisor,
    runExecutionLoopWithPlanRepair,
  };
}
