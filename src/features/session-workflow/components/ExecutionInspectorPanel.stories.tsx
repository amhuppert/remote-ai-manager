import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [
        {
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
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: true },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
          },
          contextValidator: {
            type: "claude",
            enabled: true,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
        },
        {
          id: "ctx-2",
          title: "Frontend Components",
          description: "Build React components for the user management UI.",
          acceptanceCriteria: "UI components render and handle edit flows.",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          contextValidator: null,
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        },
        {
          id: "ctx-3",
          title: "Database Migrations",
          acceptanceCriteria: "Schema changes applied and reversible.",
          implementer: {
            backend: "claude",
            model: "haiku",
            reasoningEffort: "low",
          },
          contextValidator: null,
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 2, continuity: { enabled: true } },
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
        pendingApproval: null,
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
        pendingApproval: null,
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
        pendingApproval: null,
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
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    history: [
      {
        occurredAt: "2026-03-30T09:30:00Z",
        event: {
          type: "graph-workflow-validation-result" as const,
          projectName: "test",
          sessionName: "test",
          executionId: "exec-1",
          contextId: "ctx-3",
          validatorType: "context" as const,
          pass: true,
          summary: "All database migrations applied successfully",
          issues: [],
          reopenTaskIds: [],
          sessionRef: {
            engine: "claude" as const,
            lane: "context_validator" as const,
            conversationId: "conv-val-1",
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
            engine: "codex" as const,
            lane: "context_validator" as const,
            threadId: "thread-abc123",
          },
          reviewArtifact: {
            engine: "codex" as const,
            threadId: "thread-abc123",
            response:
              "Reviewed the POST /api/users endpoint. Found missing error handling for duplicate emails and insufficient input validation.",
            usage: {
              inputTokens: 1240,
              cachedInputTokens: 800,
              outputTokens: 312,
            },
          },
        },
      },
    ],
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
        pendingApproval: null,
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
        pendingApproval: null,
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
        pendingApproval: null,
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
    history: [
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
    ],
  });
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
        width: 340,
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
    selectedContextId: null,
    ...sharedHandlers,
  },
};

export const OverviewHalted: Story = {
  args: {
    execution: makeHaltedExecution(),
    selectedContextId: null,
    ...sharedHandlers,
  },
};

export const ContextRunning: Story = {
  args: {
    execution: makeExecution(),
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

export const ContextCompleted: Story = {
  args: {
    execution: makeExecution(),
    selectedContextId: "ctx-3",
    ...sharedHandlers,
  },
};

export const ContextPending: Story = {
  args: {
    execution: makeExecution(),
    selectedContextId: "ctx-2",
    ...sharedHandlers,
  },
};

export const ContextHalted: Story = {
  args: {
    execution: makeHaltedExecution(),
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};

export const ContextHistoryTab: Story = {
  name: "Context — History Tab",
  args: {
    execution: makeHaltedExecution(),
    selectedContextId: "ctx-1",
    ...sharedHandlers,
  },
};
