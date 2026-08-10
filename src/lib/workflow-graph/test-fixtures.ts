import type {
  ValidationCandidateTree,
  ValidationCandidateTreeResolution,
} from "@/lib/workflow-graph/validation-round";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  AgentAssignment,
  GraphWorkflowAgentConfig,
  SeededAgentAssignment,
  SeededValidatorAssignment,
  SeededValidatorCohort,
  ValidatorAssignment,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import {
  prepareLiveEditAssignmentSnapshots,
  type PrepareAssignmentSnapshotsResult,
} from "@/lib/workflow-graph/live-edit-preparation";
const timestamp = "2026-03-27T12:00:00.000Z";

/**
 * Assignment builders for tests whose subject is something other than the
 * assignment itself. They keep the required identity fields (id, profile) out
 * of every unrelated fixture while leaving each one free to override exactly
 * the field it is about.
 */
export function makeImplementerAssignment(
  agent: GraphWorkflowAgentConfig,
  overrides: Partial<AgentAssignment> = {},
): AgentAssignment {
  return {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent,
    ...overrides,
  };
}

export function makeValidatorAssignment(
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "conversation",
    // The schema default, so a fixture whose subject is not authority behaves
    // like an ordinary authored specialist rather than like the seeded verifier.
    authority: "advisory",
    agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    continuity: { enabled: true },
    ...overrides,
  };
}

export function makeValidatorCohort(
  overrides: Partial<ValidatorCohort> = {},
): ValidatorCohort {
  return {
    enabled: true,
    assignments: [makeValidatorAssignment()],
    ...overrides,
  };
}

/**
 * A resolved profile snapshot, as execution start would have stored one.
 *
 * The hashes are fixtures, not computed: this module is imported by browser-
 * project stories and tests, which cannot reach `node:crypto`. Any test whose
 * subject is hash provenance should compose a real snapshot through
 * `buildAgentProfileSnapshot` instead of overriding these.
 */
export function makeProfileSnapshot(
  overrides: Partial<AgentProfileSnapshot> = {},
): AgentProfileSnapshot {
  const instructions = "Fixture profile instructions.";
  return {
    tier: "builtin",
    id: "general-implementer",
    name: "General Implementer",
    revision: 1,
    sourceContentHash: `sha256:${"a".repeat(64)}`,
    instructions,
    renderedInstructionBlock: `# Agent profile (subordinate specialization lens)\n<<<CC_AGENT_PROFILE_BEGIN>>>\n${instructions}\n<<<CC_AGENT_PROFILE_END>>>`,
    resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

/**
 * The seeded counterparts, for fixtures that stand in for a WORKING definition
 * rather than an authored one. `seedAssignment` mirrors what execution start
 * does — attach the snapshot without disturbing anything else — so a fixture
 * built from an authored assignment stays in step with it.
 */
export function seedAssignment<T extends AgentAssignment>(
  assignment: T,
  snapshot: Partial<AgentProfileSnapshot> = {},
): T & { profileSnapshot: AgentProfileSnapshot } {
  return {
    ...assignment,
    profileSnapshot: makeProfileSnapshot({
      tier: assignment.profile.tier,
      id: assignment.profile.id,
      ...snapshot,
    }),
  };
}

export function makeSeededImplementerAssignment(
  agent: GraphWorkflowAgentConfig,
  overrides: Partial<AgentAssignment> = {},
): SeededAgentAssignment {
  return seedAssignment(makeImplementerAssignment(agent, overrides));
}

export function makeSeededValidatorAssignment(
  overrides: Partial<ValidatorAssignment> = {},
): SeededValidatorAssignment {
  return seedAssignment(makeValidatorAssignment(overrides));
}

/**
 * A candidate-tree resolver that always resolves, for tests whose subject is
 * something other than candidate identity. The engine refuses to open a round on
 * an unreadable tree, so a test that enables any validator has to say what the
 * tree is — this is the "nothing interesting here" answer.
 */
export function stubValidationRoundService(
  tree: {
    headSha?: string;
    candidateTreeHash?: string;
    identityScope?: ValidationCandidateTree["identityScope"];
  } = {},
): {
  resolveCandidateTree(): Promise<ValidationCandidateTreeResolution>;
} {
  return {
    async resolveCandidateTree() {
      return {
        kind: "resolved",
        identityScope: tree.identityScope ?? "wholeTree",
        headSha: tree.headSha ?? "stub-head",
        candidateTreeHash: tree.candidateTreeHash ?? "stub-tree",
      };
    },
  };
}

export function makeSeededValidatorCohort(
  overrides: Partial<ValidatorCohort> = {},
): SeededValidatorCohort {
  const cohort = makeValidatorCohort(overrides);
  return {
    ...cohort,
    assignments: cohort.assignments.map((assignment) =>
      seedAssignment(assignment),
    ),
  };
}

/**
 * Live-edit snapshot preparation over an always-resolvable library, for tests
 * whose subject is something other than profile resolution. A test about a
 * dangling reference should inject its own `composeSnapshot` instead.
 */
export function stubAssignmentSnapshotPreparation(): (
  projectPath: string,
  operations: readonly WorkflowLiveEditOperation[],
) => Promise<PrepareAssignmentSnapshotsResult> {
  return (_projectPath, operations) =>
    prepareLiveEditAssignmentSnapshots({
      operations,
      composeSnapshot: async (assignment) =>
        makeProfileSnapshot({
          tier: assignment.profile.tier,
          id: assignment.profile.id,
        }),
    });
}

export function createWorkflowDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    // Carries the workflow-only lane-merge block (its single legal tier) with
    // values equal to the seeded defaults, so cascade outcomes are unchanged
    // while every surface that round-trips the definition exercises the field.
    workflowConfig: {
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
    },
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "context-plan",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "Plan is documented",
        placement: { lane: "plan", mode: "full" },
        implementer: makeImplementerAssignment({
          backend: "claude",
          model: "opus",
          reasoningEffort: "high",
        }),
        mutability: {
          allowAgentTaskAdd: true,
          allowAgentContextAdd: false,
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
        placement: { lane: "implement", mode: "full" },
        implementer: makeImplementerAssignment({
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        }),
        // Name-free selector override (equal to the seeded default value) so
        // fixture consumers never need a validation registry to be valid.
        agentValidation: {
          implementer: { mode: "all", except: [] },
        },
        // Explicit empty selection — the post-cutover disabled state. Carries
        // the `commands` key (name-free) so every surface that round-trips
        // the definition must preserve `[]` as distinct from an absent list.
        scriptValidator: { commands: [] },
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
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
        placement: { lane: "verify", mode: "full" },
        implementer: makeImplementerAssignment({
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        }),
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
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
    // What production resolution snapshots at seed time from the fixture's
    // workflow-tier block (values equal to the seeded defaults).
    laneMergeValidation: {
      strategy: "final-only",
      commands: { mode: "project" },
    },
    executionContexts: source.executionContexts.map((ctx) => ({
      id: ctx.id,
      title: ctx.title,
      ...(ctx.description !== undefined
        ? { description: ctx.description }
        : {}),
      acceptanceCriteria: ctx.acceptanceCriteria,
      // Mirrored, like production resolution: a launched execution schedules and
      // edits its WORKING definition, so placement has to survive the resolve.
      placement: ctx.placement,
      implementer: seedAssignment(
        ctx.implementer ??
          makeImplementerAssignment({
            backend: "claude",
            model: "opus",
            reasoningEffort: "medium",
          }),
      ),
      contextValidator: makeSeededValidatorCohort({
        enabled: false,
        assignments: [],
      }),
      scriptValidator: ctx.scriptValidator ?? { commands: [] },
      scriptValidatorSource: ctx.scriptValidator ? "per-node" : "global",
      humanApprovalGate: ctx.humanApprovalGate ?? { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: ctx.mutability ?? {
        allowAgentTaskAdd: false,
        allowAgentContextAdd: false,
      },
      circuitBreaker: ctx.circuitBreaker ?? {},
      iterationPolicy: ctx.iterationPolicy ?? {
        maxIterations: 10,
        continuity: { enabled: true },
      },
      planRepair: ctx.planRepair ?? {
        enabled: true,
        maxAttemptsPerContext: 2,
      },
      // Matches what production resolution now snapshots on every context:
      // the seeded role-selector defaults plus the seed-time expansion frozen
      // against an empty registry (name-free, registry-independent).
      agentValidation: {
        implementer: {
          value: { mode: "all", except: [] },
          source: "global",
          commands: [],
        },
        contextValidator: {
          value: { mode: "only", commands: [] },
          source: "global",
          commands: [],
        },
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
    executionStateRevision: 0,
    structuralRevision: 0,
    charterAmendments: [],
    planRepairRounds: [],
    loopControlAmendments: [],
    contextOutputs: {},
    routeControlRevisions: {},
    routeSettlements: {},
    expansionReceipts: { accepted: [], refusals: [] },
    loopStates: {},
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    ownerConversationId: null,
    definitionApproval: null,
    workingDefinition: definition,
    charter: makeTestCharter(),
    status: "pending",
    activeContextIds: [],
    contextStates: {
      "context-plan": {
        pendingApproval: null,
        pendingUserInputs: {},
        skipReason: null,
        landingIntent: null,
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
        pendingUserInputs: {},
        skipReason: null,
        landingIntent: null,
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
        pendingUserInputs: {},
        skipReason: null,
        landingIntent: null,
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
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    laneReservations: {},
    joins: {},
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
