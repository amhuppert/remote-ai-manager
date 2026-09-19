import type {
  RecordLaneTurnOutcomeInput,
  ResolveValidatorCallInput,
  ResolvedValidatorCall,
} from "./lane-continuity";
import type {
  ValidationCandidateTree,
  ValidationCandidateTreeResolution,
} from "@/lib/workflow-graph/validation-round";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaunchDocument,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecutionReservation,
  GraphWorkflowReservationOutcome,
} from "@/lib/state-store/setters";
import { evaluateLeaseAdmission } from "@/lib/workflow-graph/lifecycle-classifier";
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
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { deriveTemplateOriginFromSeedFields } from "@/lib/workflow-graph/execution-origin";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import {
  prepareLiveEditAssignmentSnapshots,
  type PrepareAssignmentSnapshotsResult,
} from "@/lib/workflow-graph/live-edit-preparation";
import { z } from "zod";
import type { AgentBackendsConfig } from "@/lib/config/schemas";
const timestamp = "2026-03-27T12:00:00.000Z";

export const TEST_AGENT_BACKENDS_CONFIG = {
  claude: {
    modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    timeoutMs: 3_600_000,
  },
  codex: {
    modelSelection: {
      modelId: "gpt-5.4",
      parameters: { fast: "false", reasoning: "high" },
    },
    timeoutMs: null,
  },
  cursor: {
    modelSelection: {
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    },
    timeoutMs: null,
  },
} satisfies AgentBackendsConfig;

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

/**
 * A continuity service that anchors every validator turn to one fixed CC
 * conversation and records nothing. For tests whose subject is the turn's
 * prompt, transport, or parsing rather than lane continuity.
 */
export function makeStubValidatorContinuityService(
  conversationId = "validator-conversation",
): {
  resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall>;
  recordLaneTurnOutcome(
    input: RecordLaneTurnOutcomeInput,
  ): Promise<GraphWorkflowExecution>;
} {
  return {
    async resolveValidatorCall(input) {
      return {
        execution: input.execution,
        sessionAction: "create",
        backend: input.backend,
        conversationId,
      };
    },
    async recordLaneTurnOutcome(input) {
      return input.execution;
    },
  };
}

export function makeValidatorAssignment(
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
    // The schema default, so a fixture whose subject is not authority behaves
    // like an ordinary authored specialist rather than like the seeded verifier.
    authority: "advisory",
    agent: {
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    },
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

// The authored-shape twin of makeTestCharter's source list: definition
// fixtures feed authored write paths (validateAuthoredDefinition, the
// definition mutation schema), which refuse the retired accessPolicy field and
// legacy prose appliesTo. Execution fixtures keep makeTestCharter()'s
// legacy-shaped sources — frozen execution charters exercise persisted
// tolerance.
function makeAuthoredTestCharter(): WorkflowCharter {
  return makeTestCharter({
    sourcesOfTruth: [
      {
        rank: 1,
        id: "design-doc",
        label: "Approved design document",
        type: "document",
        locator: ".kiro/specs/workflow-charter/design.md",
        description: "The authoritative architecture for this workflow",
      },
      {
        rank: 2,
        id: "acceptance-criteria",
        label: "Per-context acceptance criteria",
        type: "spec",
        locator: "context.acceptanceCriteria",
        description: "Context-level criteria authored by the planner",
      },
    ],
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
    charter: makeAuthoredTestCharter(),
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
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        }),
        mutability: {
          allowAgentTaskAdd: true,
          allowAgentContextAdd: false,
        },
        circuitBreaker: {},
        iterationPolicy: {
          maxIterations: 4,
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
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
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
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "medium" },
          },
        }),
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
        },
        circuitBreaker: {},
        iterationPolicy: {
          maxIterations: 2,
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

export function createRootIndependentWarningDefinition(): WorkflowSemanticDefinition {
  const definition = createWorkflowDefinition();
  const firstSource = definition.charter.sourcesOfTruth[0]!;
  const warningOutputSchema = {
    ...z.toJSONSchema(z.object({ verdict: z.enum(["ship", "hold"]) })),
  };
  delete warningOutputSchema.$schema;
  return {
    ...definition,
    charter: {
      ...definition.charter,
      sourcesOfTruth: [
        {
          ...firstSource,
          rank: 1,
          id: "safe-relative-missing",
          locator: "docs/not-present-without-a-session.md",
        },
        {
          ...firstSource,
          rank: 2,
          id: "url",
          locator: "https://example.test/design",
        },
        {
          ...firstSource,
          rank: 3,
          id: "absolute",
          locator: "/etc/hosts",
        },
        {
          ...firstSource,
          rank: 4,
          id: "traversal",
          locator: "../outside.md",
        },
      ],
    },
    executionContexts: definition.executionContexts.map((context, index) =>
      index === 0
        ? {
            ...context,
            acceptanceCriteria: [
              { id: "ac-sweep", statement: "Every call site is migrated" },
              ...Array.from({ length: 12 }, (_, criterionIndex) => ({
                id: `ac-fixed-${criterionIndex + 1}`,
                statement: `Fixed behavior ${criterionIndex + 1} is pinned`,
              })),
            ],
            outputSchema: warningOutputSchema,
          }
        : context,
    ),
    edges: definition.edges.map((edge) =>
      edge.sourceContextId === "context-plan"
        ? {
            ...edge,
            when: {
              schema: {
                type: "object" as const,
                properties: { verdict: { const: "ship" } },
                required: ["verdict"],
              },
            },
          }
        : edge,
    ),
    tasks: definition.tasks.map((task, index) =>
      index === 0 ? { ...task, instructions: "i".repeat(8001) } : task,
    ),
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

/**
 * The authored document an execution seed snapshots (D7 decision D13). Built
 * around whatever definition a seed is launching so the snapshot describes the
 * graph that actually ran rather than a fixture default.
 */
export function makeLaunchDocument(
  definition: WorkflowSemanticDefinition,
  overrides: Partial<GraphWorkflowLaunchDocument> = {},
): GraphWorkflowLaunchDocument {
  return {
    name: "Workflow Graph Builder",
    description: "Foundational workflow",
    definition,
    layout: createWorkflowLayout(),
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
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "medium" },
            },
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

  const seedDefinitionId = overrides.seedDefinitionId ?? "workflow-1";
  const seedDefinitionRevision = overrides.seedDefinitionRevision ?? 1;

  return {
    id: "execution-1",
    // Derived from whatever seed identity the caller asked for, so a fixture
    // that overrides the seed fields does not silently describe a run whose
    // origin names a different definition.
    origin: deriveTemplateOriginFromSeedFields({
      seedDefinitionId,
      seedDefinitionRevision,
      launchedTier: overrides.launchedTier,
    }),
    seedDefinitionId,
    seedDefinitionRevision,
    launchDocument: null,
    liveSessionReadOnlyPinned: false,
    abandonment: null,
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
    definitionApprovalClaim: null,
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
        consecutiveCandidateMismatchCount: 0,
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
        consecutiveCandidateMismatchCount: 0,
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
        consecutiveCandidateMismatchCount: 0,
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

/**
 * An in-memory stand-in for the authoritative lease reservation, for fixtures
 * whose "active row" is a plain map rather than SQLite.
 *
 * It runs the REAL {@link evaluateLeaseAdmission} over whatever the reader
 * returns, so the admission rule a fixture exercises is production's — only the
 * storage is fake. A fixture that hand-rolled its own admit/refuse branch would
 * be asserting against its own opinion of the lease.
 */
export function createInMemoryLeaseReservation(deps: {
  readActive(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution | null;
  installActive(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): void;
  onArchived?(execution: GraphWorkflowExecution): void;
  onEvents?(events: GraphWorkflowExecutionEvent[]): void;
}) {
  return async function reserveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    _label: string,
    reservation: GraphWorkflowExecutionReservation,
  ): Promise<GraphWorkflowReservationOutcome> {
    const incumbent = deps.readActive(projectPath, sessionName);
    const decision = evaluateLeaseAdmission(incumbent);
    if (decision.kind === "refuse") {
      return { reserved: false, refusal: decision };
    }
    if (decision.kind === "admit-with-normalization" && incumbent !== null) {
      deps.onArchived?.(incumbent);
    }
    deps.installActive(projectPath, sessionName, reservation.execution);
    deps.onEvents?.(reservation.events);
    return {
      reserved: true,
      execution: reservation.execution,
      delivery: {
        events: reservation.events,
        pushes: reservation.pushes ?? [],
      },
      normalized:
        decision.kind === "admit-with-normalization"
          ? decision.incumbent
          : null,
      normalizedExecution:
        decision.kind === "admit-with-normalization" ? incumbent : null,
    };
  };
}
