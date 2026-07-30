import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
const timestamp = "2026-03-27T12:00:00.000Z";

export function createWorkflowDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "context-plan",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "Plan is documented",
        implementer: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "high",
        },
        mutability: {
          allowAgentTaskAdd: true,
        },
        circuitBreaker: {},
        iterationPolicy: {
          maxIterations: 4,
          continuity: { enabled: true },
        },
      },
      {
        id: "context-implement",
        title: "Implement",
        description: "Implement the feature",
        acceptanceCriteria: "Feature implemented",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: {
          allowAgentTaskAdd: false,
        },
        circuitBreaker: {},
        iterationPolicy: {
          maxIterations: 3,
          continuity: { enabled: true },
        },
      },
      {
        id: "context-verify",
        title: "Verify",
        description: "Verify the result",
        acceptanceCriteria: "Verification passes",
        implementer: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
        mutability: {
          allowAgentTaskAdd: false,
        },
        circuitBreaker: {},
        iterationPolicy: {
          maxIterations: 2,
          continuity: { enabled: true },
        },
      },
    ],
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Inspect code",
        instructions: "Read the relevant files.",
        source: "user",
      },
      {
        id: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        title: "Write code",
        instructions: "Implement the feature.",
        source: "user",
      },
      {
        id: "task-verify-1",
        contextId: "context-verify",
        order: 1,
        title: "Run checks",
        instructions: "Verify behavior.",
        source: "user",
      },
    ],
    edges: [
      {
        id: "edge-plan-implement",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
      {
        id: "edge-implement-verify",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
    ],
    ...overrides,
  };
}

export function createWorkflowLayout(
  overrides: Partial<GraphWorkflowVisualLayout> = {},
): GraphWorkflowVisualLayout {
  return {
    workflowId: "workflow-1",
    contextPositions: {
      "context-plan": { x: 0, y: 0 },
      "context-implement": { x: 360, y: 0 },
      "context-verify": { x: 720, y: 0 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

export function createWorkflowDefinitionRecord(
  overrides: Partial<WorkflowDefinitionRecord> = {},
): WorkflowDefinitionRecord {
  return {
    id: "workflow-1",
    name: "Workflow Graph Builder",
    description: "Foundational workflow",
    schemaVersion: 1,
    revision: 1,
    definition: createWorkflowDefinition(),
    layout: createWorkflowLayout(),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function createResolvedWorkflowDefinition(
  overrides: Partial<ResolvedWorkflowSemanticDefinition> = {},
): ResolvedWorkflowSemanticDefinition {
  const source = createWorkflowDefinition();
  return {
    schemaVersion: source.schemaVersion,
    executionContexts: source.executionContexts.map((ctx) => ({
      id: ctx.id,
      title: ctx.title,
      ...(ctx.description !== undefined
        ? { description: ctx.description }
        : {}),
      acceptanceCriteria: ctx.acceptanceCriteria,
      implementer: ctx.implementer ?? {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      contextValidator: null,
      scriptValidator: ctx.scriptValidator ?? { enabled: false },
      humanApprovalGate: ctx.humanApprovalGate ?? { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: ctx.mutability ?? { allowAgentTaskAdd: false },
      circuitBreaker: ctx.circuitBreaker ?? {},
      iterationPolicy: ctx.iterationPolicy ?? {
        maxIterations: 10,
        continuity: { enabled: true },
      },
    })),
    tasks: source.tasks,
    edges: source.edges,
    ...overrides,
  };
}

export function createWorkflowExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const definition =
    overrides.workingDefinition ?? createResolvedWorkflowDefinition();

  return {
    id: "execution-1",
    seedDefinitionId: "workflow-1",
    seedDefinitionRevision: 1,
    liveRevision: 1,
    charterAmendments: [],
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    definitionApproval: null,
    workingDefinition: definition,
    charter: makeTestCharter(),
    status: "pending",
    activeContextIds: [],
    contextStates: {
      "context-plan": {
        pendingApproval: null,
        pendingUserInput: null,
        contextId: "context-plan",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-implement": {
        pendingApproval: null,
        pendingUserInput: null,
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-verify": {
        pendingApproval: null,
        pendingUserInput: null,
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-plan-1": {
        taskId: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-verify-1": {
        taskId: "task-verify-1",
        contextId: "context-verify",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    startedAt: timestamp,
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
    ...overrides,
  };
}
