import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
} from "@/lib/workflows/schemas";
import WorkflowEventLog from "./WorkflowEventLog";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import "./workflow-graph.css";

const PROJECT = "demo";
const SESSION = "demo-session";
const EXEC = "exec-1";

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: EXEC,
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [
        {
          id: "ctx-plan",
          title: "Plan",
          acceptanceCriteria: "Plan approved.",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
          contextValidator: null,
          scriptValidator: { enabled: false },
          humanApprovalGate: { enabled: false },
        },
        {
          id: "ctx-implement",
          title: "Implement",
          acceptanceCriteria: "All tasks pass validation.",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
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
          scriptValidator: { enabled: true },
          humanApprovalGate: { enabled: false },
        },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "ctx-plan",
          order: 1,
          title: "Draft plan",
          instructions: "Draft an outline of the implementation plan.",
          source: "user" as const,
        },
        {
          id: "task-impl-1",
          contextId: "ctx-implement",
          order: 1,
          title: "Wire up API route",
          instructions: "Wire up the API route per the plan.",
          source: "user" as const,
        },
        {
          id: "task-impl-2",
          contextId: "ctx-implement",
          order: 2,
          title: "Add integration test",
          instructions: "Cover the route with a vitest integration test.",
          source: "user" as const,
        },
      ],
      edges: [
        {
          id: "e-1",
          sourceContextId: "ctx-plan",
          targetContextId: "ctx-implement",
        },
      ],
    },
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-implement"],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
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

const richHistory: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T09:00:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      workflowStatus: "running",
      activeContextIds: ["ctx-plan"],
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: null,
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    },
  },
  {
    occurredAt: "2026-03-30T09:02:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-plan",
      status: "running",
      remainingTaskCount: 1,
      iterationCount: 0,
    },
  },
  {
    occurredAt: "2026-03-30T09:05:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-plan",
      taskId: "task-plan-1",
      status: "running",
      source: "user",
      order: 1,
    },
  },
  {
    occurredAt: "2026-03-30T09:10:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-plan",
      taskId: "task-plan-1",
      status: "completed",
      source: "user",
      order: 1,
      summary: "Plan drafted. Identified **3 stages**: schema, route, test.",
    },
  },
  {
    occurredAt: "2026-03-30T09:11:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-plan",
      status: "completed",
      remainingTaskCount: 0,
      iterationCount: 1,
    },
  },
  {
    occurredAt: "2026-03-30T09:12:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-batch-scheduled",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      batchId: "batch-1",
      contextIds: ["ctx-implement"],
    },
  },
  {
    occurredAt: "2026-03-30T09:15:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      taskId: "task-impl-1",
      status: "completed",
      source: "user",
      order: 1,
      summary: "Wired POST /api/widgets to the controller.",
    },
  },
  {
    occurredAt: "2026-03-30T09:25:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      validatorType: "context",
      pass: false,
      summary: "Found issues that need follow-up.",
      issues: [
        {
          taskId: "task-impl-2",
          title: "Missing integration test",
          description:
            "The new route is not covered by any integration test. Add a vitest test that exercises the success and error paths.",
        },
      ],
      reopenTaskIds: ["task-impl-2"],
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-val-1",
      },
    },
  },
  {
    occurredAt: "2026-03-30T09:30:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      taskId: "task-impl-2",
      status: "completed",
      source: "agent",
      order: 2,
      summary: "Added vitest coverage for success + error paths.",
    },
  },
  {
    occurredAt: "2026-03-30T09:35:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      validatorType: "context",
      pass: true,
      summary: "All acceptance criteria satisfied.",
      issues: [],
      reopenTaskIds: [],
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-val-2",
      },
    },
  },
  {
    occurredAt: "2026-03-30T09:36:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-merge-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      branchName: "feature/widgets",
      mergeStatus: "in-progress",
      cleanupStatus: "not-applicable",
      lastMergeError: null,
    },
  },
  {
    occurredAt: "2026-03-30T09:37:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-merge-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      branchName: "feature/widgets",
      mergeStatus: "merged-success",
      cleanupStatus: "removed",
      lastMergeError: null,
    },
  },
];

const failureHistory: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T10:00:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      taskId: "task-impl-1",
      status: "failed",
      source: "user",
      order: 1,
      failureMessage: "TypeError: Cannot read property 'id' of undefined",
    },
  },
  {
    occurredAt: "2026-03-30T10:05:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      validatorType: "context",
      pass: false,
      summary: "Validation failed after retry.",
      issues: [
        {
          taskId: "task-impl-1",
          title: "Crash on missing input",
          description: "Endpoint throws when body is empty.",
        },
      ],
      reopenTaskIds: ["task-impl-1"],
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-fail-1",
      },
    },
  },
  {
    occurredAt: "2026-03-30T10:10:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-circuit-breaker",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: "Validator rejected the implementation three times in a row.",
    },
  },
  {
    occurredAt: "2026-03-30T10:10:30Z",
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      status: "halted",
      remainingTaskCount: 1,
      iterationCount: 3,
    },
  },
  {
    occurredAt: "2026-03-30T10:11:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      workflowStatus: "halted",
      activeContextIds: [],
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: {
        type: "circuit_breaker",
        contextId: "ctx-implement",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: "Validator rejected the implementation three times in a row.",
      },
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    },
  },
];

const mergeFailureHistory: GraphWorkflowExecutionEvent[] = [
  {
    occurredAt: "2026-03-30T11:00:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-merge-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      branchName: "feature/widgets",
      mergeStatus: "in-progress",
      cleanupStatus: "not-applicable",
      lastMergeError: null,
    },
  },
  {
    occurredAt: "2026-03-30T11:01:00Z",
    preReset: false,
    event: {
      type: "graph-workflow-merge-status",
      projectName: PROJECT,
      sessionName: SESSION,
      executionId: EXEC,
      contextId: "ctx-implement",
      branchName: "feature/widgets",
      mergeStatus: "conflicts",
      cleanupStatus: "not-applicable",
      lastMergeError:
        "Merge conflict in src/lib/widgets.ts\nMerge conflict in src/types/index.ts",
    },
  },
];

const meta = {
  title: "WorkflowGraph/WorkflowEventLog",
  component: WorkflowEventLog,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 560,
          padding: 16,
          background: "var(--bg-void)",
          color: "var(--text-strong)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    onSelectContext: fn(),
    onViewConversation: fn(),
  },
} satisfies Meta<typeof WorkflowEventLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichTimeline: Story = {
  args: {
    execution: makeExecution(),
    events: richHistory,
  },
};

export const FailureAndHalt: Story = {
  args: {
    execution: makeExecution({
      status: "halted",
      activeContextIds: [],
      haltReason: {
        type: "circuit_breaker",
        contextId: "ctx-implement",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: "Validator rejected the implementation three times in a row.",
      },
    }),
    events: failureHistory,
  },
};

export const MergeConflict: Story = {
  args: {
    execution: makeExecution(),
    events: mergeFailureHistory,
  },
};

export const FilteredByContext: Story = {
  args: {
    execution: makeExecution(),
    events: richHistory,
    contextId: "ctx-implement",
  },
};

export const LimitedToFive: Story = {
  args: {
    execution: makeExecution(),
    events: richHistory,
    limit: 5,
  },
};

export const Empty: Story = {
  args: {
    execution: makeExecution(),
    events: [],
  },
};
