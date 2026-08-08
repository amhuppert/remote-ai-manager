import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import { makeProfileSnapshot } from "@/lib/workflow-graph/test-fixtures";

const overviewEvents: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T09:30:00Z",
    event: {
      type: "graph-workflow-validation-result" as const,
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-3",
      validatorType: "context" as const,
      kind: "context_validation" as const,
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: true,
      summary: "All database migrations applied successfully",
      issues: [],
      reopenTaskIds: [],
      sessionRef: {
        backend: "claude" as const,
        ref: "conv-val-1",
        lane: "context_validator" as const,
        refKind: "conversation" as const,
        workflowConversationId: "conv-val-1",
      },
    },
    preReset: false,
  },
  {
    occurredAt: "2026-03-30T10:00:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result" as const,
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-1",
      validatorType: "context" as const,
      kind: "context_validation" as const,
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: false,
      summary: "Context validation failed: missing error handling",
      issues: [
        {
          taskId: "task-1",
          title: "Missing error handler",
          description:
            "POST /api/users does not handle duplicate email errors. The endpoint should return 409 Conflict with a descriptive message.",
        },
        {
          taskId: "task-2",
          title: "Missing input validation",
          description:
            "Email format validation is not strict enough — accepts strings without TLD",
        },
      ],
      reopenTaskIds: ["task-1", "task-2"],
      sessionRef: {
        backend: "codex" as const,
        ref: "thread-abc123",
        lane: "context_validator" as const,
        refKind: "backend" as const,
      },
      reviewArtifact: {
        backend: "codex" as const,
        kind: "response" as const,
        ref: "thread-abc123",
        response:
          "Reviewed the POST /api/users endpoint. Found missing error handling for duplicate emails and insufficient input validation.",
        usage: {
          inputTokens: 1240,
          cachedInputTokens: 800,
          outputTokens: 312,
          costUsd: null,
        },
      },
    },
  },
];

const haltedEvents: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T09:30:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-3",
      validatorType: "context",
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: true,
      summary: "Migrations passed",
      issues: [],
      reopenTaskIds: [],
    },
  },
  {
    occurredAt: "2026-03-30T10:00:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-1",
      validatorType: "context",
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: false,
      summary: "Missing error handling in endpoints",
      issues: [
        {
          taskId: "task-2",
          title: "Missing error handler",
          description: "POST /api/users does not handle duplicate emails",
        },
      ],
      reopenTaskIds: ["task-2"],
    },
  },
  {
    occurredAt: "2026-03-30T10:20:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-1",
      validatorType: "context",
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: false,
      summary: "JWT middleware still broken",
      issues: [
        {
          taskId: "task-2",
          title: "Dependency missing",
          description: "jsonwebtoken not installed",
        },
        {
          taskId: "task-2",
          title: "Token verification incomplete",
          description:
            "Middleware does not check token expiration or validate issuer claim",
        },
        {
          taskId: "task-3",
          title: "Missing auth error responses",
          description:
            "Endpoints return 500 instead of 401 when token is invalid",
        },
      ],
      reopenTaskIds: ["task-2", "task-3"],
    },
  },
  {
    occurredAt: "2026-03-30T10:30:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-circuit-breaker",
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-1",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
  },
];

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
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
    definitionApproval: null,
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: [
        {
          placement: { lane: "ctx-1", mode: "full" as const },
          id: "ctx-1",
          title: "API Integration",
          description: `Implement REST API endpoints for **user management** with authentication and validation.

### Requirements
- All endpoints must use \`Zod\` schema validation
- JWT tokens for auth middleware
- Rate limiting on public endpoints

> Note: The existing \`/api/health\` endpoint pattern should be followed for consistency.`,
          acceptanceCriteria: "Validate the completed context output",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
          },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
          contextValidator: {
            enabled: true,
            assignments: [
              {
                id: "general",
                profile: { tier: "builtin", id: "general-reviewer" },
                profileSnapshot: makeProfileSnapshot(),
                strategy: "conversation",
                authority: "blocking",
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                continuity: { enabled: true },
              },
            ],
          },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
        },
        {
          placement: { lane: "ctx-2", mode: "full" as const },
          id: "ctx-2",
          title: "Frontend Components",
          description: "Build React components for the user management UI.",
          acceptanceCriteria: "UI components render and handle edit flows.",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
        {
          placement: { lane: "ctx-3", mode: "full" as const },
          id: "ctx-3",
          title: "Database Migrations",
          acceptanceCriteria: "Schema changes applied and reversible.",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              model: "haiku",
              reasoningEffort: "low",
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 2, continuity: { enabled: true } },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "Create user endpoint",
          instructions: `Implement \`POST /api/users\` with Zod validation.

### Acceptance Criteria
1. Request body validated with \`createUserSchema\`
2. Returns **201** with user object on success
3. Returns **409** if email already exists
4. Password hashed with \`bcrypt\` before storage

\`\`\`typescript
const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});
\`\`\``,
          source: "user" as const,
        },
        {
          id: "task-2",
          contextId: "ctx-1",
          order: 2,
          title: "Auth middleware",
          instructions:
            "Add JWT authentication middleware to protect the endpoints. Verify tokens using `jsonwebtoken` library and attach decoded user to `req.user`.",
          source: "user" as const,
        },
        {
          id: "task-3",
          contextId: "ctx-1",
          order: 3,
          title: "Rate limiting",
          instructions: "Add rate limiting to all API endpoints",
          source: "agent" as const,
        },
        {
          id: "task-4",
          contextId: "ctx-2",
          order: 1,
          title: "UserList component",
          instructions: "Create a paginated user list table",
          source: "user" as const,
        },
        {
          id: "task-5",
          contextId: "ctx-2",
          order: 2,
          title: "UserForm component",
          instructions: "Create a form for adding/editing users",
          source: "user" as const,
        },
        {
          id: "task-6",
          contextId: "ctx-3",
          order: 1,
          title: "Users table migration",
          instructions: "Create the users table with proper schema",
          source: "user" as const,
        },
      ],
      edges: [
        { id: "e-1", sourceContextId: "ctx-3", targetContextId: "ctx-1" },
        { id: "e-2", sourceContextId: "ctx-1", targetContextId: "ctx-2" },
      ],
    },
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 3,
        completedTaskCount: 1,
        iterationCount: 2,
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
      "ctx-2": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-2",
        status: "pending",
        totalTaskCount: 2,
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
      "ctx-3": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-3",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
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
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        status: "completed",
        summary: "Created user endpoint with validation",
        startedAt: "2026-03-30T09:45:00Z",
        completedAt: "2026-03-30T09:50:00Z",
        lastConversationId: "conv-1",
        failureMessage: null,
        failureHistory: [],
      },
      "task-2": {
        taskId: "task-2",
        contextId: "ctx-1",
        order: 2,
        status: "running",
        summary: null,
        startedAt: "2026-03-30T09:55:00Z",
        completedAt: null,
        lastConversationId: "conv-2",
        failureMessage: null,
        failureHistory: [],
      },
      "task-3": {
        taskId: "task-3",
        contextId: "ctx-1",
        order: 3,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-6": {
        taskId: "task-6",
        contextId: "ctx-3",
        order: 1,
        status: "completed",
        summary: "Migration created and applied",
        startedAt: "2026-03-30T09:20:00Z",
        completedAt: "2026-03-30T09:28:00Z",
        lastConversationId: "conv-3",
        failureMessage: null,
        failureHistory: [],
      },
    },
    sharedDocuments: [
      {
        id: "doc-1",
        relativePath: ".kiro/specs/user-management/design.md",
        description: "User management design spec",
        readWhen: "Starting any user management task",
        kind: "shared",
        createdAt: "2026-03-30T09:00:00Z",
        updatedAt: "2026-03-30T09:00:00Z",
        lastUpdatedByConversationId: null,
      },
    ],
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    laneReservations: {},
    joins: {},
    machineSnapshot: null,
    startedAt: "2026-03-30T09:00:00Z",
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

function makeHaltedExecution(): GraphWorkflowExecution {
  return makeExecution({
    status: "halted",
    activeContextIds: [],
    haltReason: {
      type: "circuit_breaker",
      contextId: "ctx-1",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
    contextStates: {
      "ctx-1": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "halted",
        totalTaskCount: 3,
        completedTaskCount: 1,
        iterationCount: 3,
        consecutiveFailureCount: 3,
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
      "ctx-2": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-2",
        status: "pending",
        totalTaskCount: 2,
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
      "ctx-3": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-3",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
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
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        status: "completed",
        summary: "Created user endpoint",
        startedAt: "2026-03-30T09:45:00Z",
        completedAt: "2026-03-30T09:50:00Z",
        lastConversationId: "conv-1",
        failureMessage: null,
        failureHistory: [],
      },
      "task-2": {
        taskId: "task-2",
        contextId: "ctx-1",
        order: 2,
        status: "failed",
        summary: null,
        startedAt: "2026-03-30T10:20:00Z",
        completedAt: null,
        lastConversationId: "conv-5",
        failureMessage:
          "Failed to implement JWT middleware: missing jsonwebtoken dependency",
        failureHistory: [],
      },
      "task-3": {
        taskId: "task-3",
        contextId: "ctx-1",
        order: 3,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-6": {
        taskId: "task-6",
        contextId: "ctx-3",
        order: 1,
        status: "completed",
        summary: "Migration created",
        startedAt: "2026-03-30T09:20:00Z",
        completedAt: "2026-03-30T09:28:00Z",
        lastConversationId: "conv-3",
        failureMessage: null,
        failureHistory: [],
      },
    },
  });
}

// ---- R12.3 cohort fixtures ----

const COHORT_ROSTER = [
  {
    assignmentId: "general",
    profileRef: { tier: "builtin" as const, id: "general-reviewer" },
    revision: 1,
    resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
    strategy: "conversation" as const,
  },
  {
    assignmentId: "security",
    profileRef: { tier: "project" as const, id: "security-reviewer" },
    revision: 4,
    resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
    strategy: "task" as const,
  },
  {
    assignmentId: "docs",
    profileRef: { tier: "global" as const, id: "docs-reviewer" },
    revision: 2,
    resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
    strategy: "conversation" as const,
  },
];

function makeCohortRound(): GraphWorkflowValidationRound {
  return {
    seq: 3,
    candidate: {
      headSha: "9f1c2ab7",
      candidateTreeHash: "4c7d91ea0b3f",
      taskStateHash: "tasks-7",
    },
    roster: COHORT_ROSTER,
    specialists: {
      general: {
        state: "verdict_pass",
        attempts: 1,
        summary: "Endpoints match the acceptance criteria.",
        issues: [],
        advisories: [],
        questionToken: null,
        sessionRef: {
          backend: "claude",
          ref: "conv-general",
          lane: "context_validator",
          assignmentId: "general",
          refKind: "conversation",
          workflowConversationId: "conv-general",
        },
        reviewArtifact: null,
        lastInfraFailure: null,
      },
      security: {
        state: "infra_failed",
        attempts: 2,
        summary: null,
        issues: [],
        advisories: [],
        questionToken: null,
        sessionRef: null,
        reviewArtifact: null,
        lastInfraFailure: {
          reason: "unparseable",
          message: "Validator returned no parseable verdict",
          engine: "codex",
        },
      },
      docs: {
        state: "running",
        attempts: 1,
        summary: null,
        issues: [],
        advisories: [],
        questionToken: null,
        sessionRef: null,
        reviewArtifact: null,
        lastInfraFailure: null,
      },
    },
    phase: "specialists",
    outcome: null,
    startedAt: "2026-03-30T10:35:00Z",
  };
}

const cohortEvents: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T10:38:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-incident",
      projectName: "test",
      sessionName: "test",
      executionId: "exec-1",
      contextId: "ctx-1",
      incident: "infra_failure",
      roundSeq: 3,
      stage: "specialist_result",
      assignmentId: "security",
      attempts: 2,
      driftedComponents: "",
      message: "Validator returned no parseable verdict; retrying the lane.",
    },
  },
];

const cohortAggregateEvent: GraphWorkflowExecutionEvent = {
  occurredAt: "2026-03-30T10:45:00Z",
  preReset: false,
  event: {
    type: "graph-workflow-validation-result",
    projectName: "test",
    sessionName: "test",
    executionId: "exec-1",
    contextId: "ctx-1",
    validatorType: "context",
    kind: "context_validation",
    rejectedOutput: null,
    gateRepairAttempts: null,
    gateRepairBudget: null,
    pass: false,
    summary: "The cohort rejected the candidate: 1 of 3 validators refused.",
    // Production shape: `concludeCohort` concatenates every failing lane's
    // findings onto the aggregate, stamped with the assignment that raised
    // them, while each lane's entry below carries its own copy. The card
    // renders the attributed copy inside its assignment group only.
    issues: [
      {
        taskId: "task-2",
        title: "Plaintext secret in logs",
        description:
          "`req.headers.authorization` is logged verbatim in the auth middleware.",
        assignmentId: "security",
      },
    ],
    reopenTaskIds: ["task-2"],
    roundSeq: 3,
    sessionRef: null,
    reviewArtifact: null,
    specialists: [
      {
        assignmentId: "general",
        profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
        advisories: [],
        pass: true,
        summary: "Endpoints match the acceptance criteria.",
        issues: [],
        sessionRef: {
          backend: "claude",
          ref: "conv-general",
          lane: "context_validator",
          assignmentId: "general",
          refKind: "conversation",
          workflowConversationId: "conv-general",
        },
        reviewArtifact: null,
        usage: null,
      },
      {
        assignmentId: "security",
        profile: { tier: "project", id: "security-reviewer", revision: 4 },
        resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
        advisories: [],
        pass: false,
        summary: "The bearer token is written to the request log.",
        issues: [
          {
            taskId: "task-2",
            title: "Plaintext secret in logs",
            description:
              "`req.headers.authorization` is logged verbatim in the auth middleware.",
            assignmentId: "security",
          },
        ],
        sessionRef: {
          backend: "codex",
          ref: "thread-security",
          lane: "context_validator",
          assignmentId: "security",
          refKind: "backend",
        },
        reviewArtifact: {
          backend: "codex",
          kind: "response",
          ref: "thread-security",
          response:
            "Reviewed the auth middleware and the request logger. The bearer token reaches the log sink unredacted.",
          usage: {
            inputTokens: 2130,
            cachedInputTokens: 1600,
            outputTokens: 284,
            costUsd: null,
          },
        },
        usage: null,
      },
      {
        assignmentId: "docs",
        profile: { tier: "global", id: "docs-reviewer", revision: 2 },
        resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
        advisories: [],
        pass: true,
        summary: "The route docs cover every new endpoint.",
        issues: [],
        sessionRef: {
          backend: "claude",
          ref: "conv-docs",
          lane: "context_validator",
          assignmentId: "docs",
          refKind: "conversation",
          workflowConversationId: "conv-docs",
        },
        reviewArtifact: null,
        usage: null,
      },
    ],
  },
};

function makeCohortExecution({
  round,
  status,
}: {
  round: GraphWorkflowValidationRound;
  status: GraphWorkflowExecution["status"];
}): GraphWorkflowExecution {
  const base = makeExecution({ status });
  const planContext = base.workingDefinition.executionContexts[0]!;
  const planState = base.contextStates["ctx-1"]!;
  return {
    ...base,
    workingDefinition: {
      ...base.workingDefinition,
      executionContexts: [
        {
          ...planContext,
          implementer: {
            ...planContext.implementer,
            profileSnapshot: makeProfileSnapshot({ revision: 3 }),
          },
          contextValidator: {
            enabled: true,
            assignments: COHORT_ROSTER.map((seat) => ({
              id: seat.assignmentId,
              profile: seat.profileRef,
              profileSnapshot: makeProfileSnapshot({
                tier: seat.profileRef.tier,
                id: seat.profileRef.id,
                revision: seat.revision,
              }),
              strategy: seat.strategy,
              authority: "blocking" as const,
              agent:
                seat.strategy === "task"
                  ? {
                      backend: "codex" as const,
                      model: "gpt-5.6-sol" as const,
                      reasoningEffort: "medium" as const,
                    }
                  : {
                      backend: "claude" as const,
                      model: "sonnet" as const,
                      reasoningEffort: "medium" as const,
                    },
              continuity: { enabled: true },
            })),
          },
        },
        ...base.workingDefinition.executionContexts.slice(1),
      ],
    },
    contextStates: {
      ...base.contextStates,
      "ctx-1": { ...planState, validationRound: round },
    },
  };
}

const sharedHandlers = {
  onSelectContext: fn(),
  onDeselectContext: fn(),
  onAddTask: fn(),
  onUpdateTask: fn(),
  onRemoveTask: fn(),
  onReorderTask: fn(),
  onResetContext: fn(),
  onViewTask: fn(),
  onViewConversation: fn(),
  viewingTaskId: null,
  isMutating: false,
};

function StoryWrapper(
  props: React.ComponentPropsWithoutRef<typeof ExecutionInspectorPanel>,
) {
  return (
    <div
      style={{
        width: 500,
        height: 700,
        background: "var(--bg-void)",
      }}
    >
      <ExecutionInspectorPanel {...props} />
    </div>
  );
}

const meta = {
  title: "Workflow/ExecutionInspectorPanel",
  component: StoryWrapper,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  args: {
    execution: makeExecution(),
    events: overviewEvents,
    selectedContextId: null,
    ...sharedHandlers,
  },
};

// R6.3 bound-input audit surface (a zero-input run omits the section).
export const OverviewWithLaunchInputs: Story = {
  args: {
    execution: makeExecution({
      boundInputs: {
        feature: "search box",
        priority: "high",
        notes: "first line\nsecond line",
      },
    }),
    events: overviewEvents,
    selectedContextId: null,
    ...sharedHandlers,
  },
};

export const OverviewHalted: Story = {
  args: {
    execution: makeHaltedExecution(),
    events: haltedEvents,
    selectedContextId: null,
    ...sharedHandlers,
  },
};

export const ContextRunning: Story = {
  args: {
    execution: makeExecution(),
    events: overviewEvents,
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

export const ContextCompleted: Story = {
  args: {
    execution: makeExecution(),
    events: overviewEvents,
    selectedContextId: "ctx-3",
    ...sharedHandlers,
  },
};

export const ContextPending: Story = {
  args: {
    execution: makeExecution(),
    events: overviewEvents,
    selectedContextId: "ctx-2",
    ...sharedHandlers,
  },
};

export const ContextHalted: Story = {
  args: {
    execution: makeHaltedExecution(),
    events: haltedEvents,
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

export const ContextHistoryTab: Story = {
  name: "Context — History Tab",
  args: {
    execution: makeHaltedExecution(),
    events: haltedEvents,
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

// R12.3: a cohort round mid-flight — one seat has passed, one is still
// reviewing, and one spent an attempt on infrastructure. Select the History tab
// to read the round record.
export const ContextCohortRoundRunning: Story = {
  name: "Context — Cohort Round (running)",
  args: {
    execution: makeCohortExecution({
      round: makeCohortRound(),
      status: "running",
    }),
    events: cohortEvents,
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

// The same round after a semantic conclusion: one aggregate verdict, with each
// member's own verdict, issues and artifact grouped beneath it.
export const ContextCohortRoundRejected: Story = {
  name: "Context — Cohort Round (rejected)",
  args: {
    execution: makeCohortExecution({
      round: {
        ...makeCohortRound(),
        phase: "concluded",
        outcome: "failed",
        specialists: {
          ...makeCohortRound().specialists,
          security: {
            ...makeCohortRound().specialists.security!,
            state: "verdict_fail",
            attempts: 1,
            summary: "Secret is logged in plaintext.",
            lastInfraFailure: null,
          },
        },
      },
      status: "running",
    }),
    events: [...cohortEvents, cohortAggregateEvent],
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

// An infrastructure conclusion: the tree moved under the cohort, so the round
// has no verdict at all. The distinction is carried by the label and the
// incident text, not by the chip tone.
export const ContextCohortRoundInfrastructure: Story = {
  name: "Context — Cohort Round (infrastructure)",
  args: {
    execution: makeCohortExecution({
      round: {
        ...makeCohortRound(),
        phase: "concluded",
        outcome: "candidate_mismatch",
      },
      status: "running",
    }),
    events: [
      ...cohortEvents,
      {
        occurredAt: "2026-03-30T10:41:00Z",
        preReset: false,
        event: {
          type: "graph-workflow-validation-incident",
          projectName: "test",
          sessionName: "test",
          executionId: "exec-1",
          contextId: "ctx-1",
          incident: "candidate_mismatch",
          roundSeq: 3,
          stage: "aggregate",
          assignmentId: null,
          attempts: 0,
          driftedComponents: "candidateTreeHash",
          message:
            "The worktree changed while the cohort was reviewing; the round was discarded and will re-freeze.",
        },
      },
    ],
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};
