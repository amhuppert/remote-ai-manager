import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { ExecutionContextNodeData } from "./derive-graph";
import ExecutionContextNode from "./ExecutionContextNode";
import "./workflow-graph.css";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;

function makeContext(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx-1",
    title: "API Integration",
    description:
      "Implement REST API endpoints for user management with authentication and validation.",
    acceptanceCriteria: "All REST endpoints exist and pass integration tests.",
    placement: { lane: "ctx-1", mode: "full" },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
    },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    ...overrides,
  };
}

function makeTasks(count: number): ExecutionContextNodeData["tasks"] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    contextId: "ctx-1",
    order: i + 1,
    title: `Task ${i + 1}`,
    instructions: "",
    source: "user" as const,
  }));
}

function NodeStory({
  data,
  selected = false,
}: {
  data: ExecutionContextNodeData;
  selected?: boolean;
}) {
  const nodes = [
    {
      id: "ctx-1",
      type: "executionContext" as const,
      position: { x: 50, y: 30 },
      data,
      selected,
    },
  ];

  return (
    <ReactFlowProvider>
      <div style={{ width: 380, height: 320, background: "var(--bg-void)" }}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.15 }}
        />
      </div>
    </ReactFlowProvider>
  );
}

const meta = {
  title: "WorkflowGraph/ExecutionContextNode",
  component: NodeStory,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
} satisfies Meta<typeof NodeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const DependencyBlocked: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 5,
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
      waitState: {
        kind: "dependency-blocked",
        unmetDependencyIds: ["ctx-upstream"],
        blockedByApproval: false,
      },
    },
  },
};

export const Ready: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
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
      waitState: { kind: "ready" },
    },
  },
};

export const WaitingForLane: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "worktree",
        batchId: null,
        laneId: "lane-feature-x",
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      waitState: { kind: "waiting-for-lane", laneId: "lane-feature-x" },
    },
  },
};

export const WaitingForJoin: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "worktree",
        batchId: null,
        laneId: null,
        joinId: "join-publish",
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      waitState: { kind: "waiting-for-join", joinId: "join-publish" },
    },
  },
};

export const Running: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
        iterationCount: 1,
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
      waitState: { kind: "running" },
    },
  },
};

export const Validating: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
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
      waitState: { kind: "validating" },
    },
  },
};

export const Completed: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "completed",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
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
      waitState: { kind: "completed" },
    },
  },
};

export const Published: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "completed",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: "/tmp/wt-ctx-1",
        branchName: "feature/api-integration",
        isolation: "worktree",
        batchId: "batch-1",
        laneId: null,
        joinId: null,
        mergeStatus: "merged-success",
        cleanupStatus: "removed",
        lastMergeError: null,
      },
      waitState: { kind: "published" },
    },
  },
};

export const AwaitingApproval: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: {
          conversationId: "conv-1",
          requestedAt: "2026-06-10T09:00:00.000Z",
          decision: null,
          approvalScope: { kind: "whole_tree" },
        },
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "awaiting_approval",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
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
      waitState: { kind: "awaiting-approval" },
    },
  },
};

export const AwaitingUserInput: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(2),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {
          implementer: {
            conversationId: "conv-1",
            lane: "implementer",
            questionBatchId: "qb-1",
            questions: [],
            requestedAt: "2026-07-03T09:00:00.000Z",
            roundSeq: null,
            answers: null,
          },
        },
        contextId: "ctx-1",
        status: "awaiting_user_input",
        totalTaskCount: 2,
        completedTaskCount: 1,
        iterationCount: 1,
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
      waitState: { kind: "awaiting-user-input" },
    },
  },
};

export const BlockedBehindGate: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 5,
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
      waitState: {
        kind: "dependency-blocked",
        unmetDependencyIds: ["ctx-upstream"],
        blockedByApproval: true,
      },
    },
  },
};

export const Halted: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "halted",
        totalTaskCount: 5,
        completedTaskCount: 3,
        iterationCount: 2,
        consecutiveFailureCount: 2,
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
      waitState: { kind: "halted" },
    },
  },
};

export const Selected: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
    selected: true,
  },
};

export const SelectedRunning: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
        iterationCount: 1,
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
      waitState: { kind: "running" },
    },
    selected: true,
  },
};

export const Merging: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: "/tmp/wt-ctx-1",
        branchName: "feature/api-integration",
        isolation: "worktree",
        batchId: "batch-1",
        laneId: null,
        joinId: null,
        mergeStatus: "in-progress",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      waitState: { kind: "merging", targetBranch: "feature/api-integration" },
    },
  },
};

export const ValidatorsScriptOnly: Story = {
  args: {
    data: {
      context: makeContext({
        scriptValidator: { commands: ["pre-merge"] },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ValidatorsClaudeAgent: Story = {
  args: {
    data: {
      context: makeContext({
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
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
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ValidatorsCodexAgent: Story = {
  args: {
    data: {
      context: makeContext({
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.5",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ValidatorsScriptPlusClaude: Story = {
  args: {
    data: {
      context: makeContext({
        scriptValidator: { commands: ["pre-merge"] },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
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
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ValidatorsInheritedClaude: Story = {
  args: {
    data: {
      context: {
        placement: { lane: "ctx-1", mode: "full" as const },
        id: "ctx-1",
        title: "API Integration",
        description:
          "Inherits the workflow-level Claude validator — no node override.",
        acceptanceCriteria:
          "All REST endpoints exist and pass integration tests.",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
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
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ValidatorsInheritedScriptAndCodex: Story = {
  args: {
    data: {
      context: {
        placement: { lane: "ctx-1", mode: "full" as const },
        id: "ctx-1",
        title: "API Integration",
        description:
          "Both validators inherited from global/workflow — no node override.",
        acceptanceCriteria:
          "All REST endpoints exist and pass integration tests.",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.5",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
        scriptValidator: { commands: ["pre-merge"] },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ApprovalGate: Story = {
  args: {
    data: {
      context: makeContext({
        humanApprovalGate: { enabled: true },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ApprovalGateWithScript: Story = {
  args: {
    data: {
      context: makeContext({
        scriptValidator: { commands: ["pre-merge"] },
        humanApprovalGate: { enabled: true },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ApprovalGateWithValidators: Story = {
  args: {
    data: {
      context: {
        placement: { lane: "ctx-1", mode: "full" as const },
        id: "ctx-1",
        title: "API Integration",
        description:
          "Script + Codex validators run first; a human then signs off before this context can complete.",
        acceptanceCriteria:
          "All REST endpoints exist and pass integration tests.",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.5",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
        scriptValidator: { commands: ["pre-merge"] },
        humanApprovalGate: { enabled: true },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const ImplementerCodex: Story = {
  args: {
    data: {
      context: makeContext({
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "codex",
            model: "gpt-5.5",
            reasoningEffort: "medium",
          },
        },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "active",
      configOverrides: [],
    },
  },
};

export const WaitingForCapacity: Story = {
  args: {
    data: {
      context: makeContext({ title: "Run the full verification suite" }),
      tasks: makeTasks(4),
      mode: "execution",
      laneState: "pending",
      configOverrides: [],
      contextState: contextState("ready", { totalTaskCount: 4 }),
      waitState: { kind: "waiting-for-capacity" },
    },
  },
};

export const AdvisoryResponse: Story = {
  args: {
    data: {
      context: makeContext({ title: "Address advisory review" }),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: contextState("running", {
        completedTaskCount: 5,
        advisoryResponse: {
          roundSeq: 2,
          phase: "awaiting_response",
          enteredAt: "2026-08-23T04:11:00.000Z",
        },
      }),
      waitState: { kind: "advisory-response" },
    },
  },
};

export const SkippedBranch: Story = {
  args: {
    data: {
      context: makeContext({ title: "Publish production configuration" }),
      tasks: makeTasks(2),
      mode: "execution",
      laneState: "pending",
      configOverrides: [],
      contextState: contextState("skipped", {
        totalTaskCount: 2,
        skipReason: {
          at: "2026-08-23T04:12:00.000Z",
          edgeEvaluations: [
            { edgeId: "dev-environment", verdict: "inactive" },
            { edgeId: "production-fallback", verdict: "omitted" },
          ],
        },
      }),
      waitState: { kind: "skipped" },
      skip: {
        at: "2026-08-23T04:12:00.000Z",
        edgeEvaluations: [
          { edgeId: "dev-environment", verdict: "inactive" },
          { edgeId: "production-fallback", verdict: "omitted" },
        ],
        decidingEdgeIds: ["dev-environment"],
      },
    },
  },
};

export const OutputSchemaDeclared: Story = {
  args: {
    data: {
      context: makeContext({
        title: "Capture diagnostic context",
        outputSchema: {
          type: "object",
          required: ["schemaVersion", "providers"],
          properties: {
            schemaVersion: { type: "number" },
            providers: { type: "object" },
          },
        },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "pending",
      configOverrides: [],
      outputSchema: { captured: false },
    },
  },
};

export const OutputCaptured: Story = {
  args: {
    data: {
      context: makeContext({
        title: "Capture diagnostic context",
        outputSchema: {
          type: "object",
          required: ["schemaVersion", "providers"],
        },
      }),
      tasks: makeTasks(3),
      mode: "execution",
      laneState: "merged",
      configOverrides: [],
      contextState: contextState("completed", {
        totalTaskCount: 3,
        completedTaskCount: 3,
      }),
      waitState: { kind: "completed" },
      outputSchema: { captured: true },
    },
  },
};

export const LoopPass: Story = {
  args: {
    data: {
      context: makeContext({ title: "Refine delivery plan — pass 2" }),
      tasks: makeTasks(3),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: contextState("running", {
        totalTaskCount: 3,
        completedTaskCount: 1,
      }),
      waitState: { kind: "running" },
      loop: {
        loopGroupId: "plan-refinement",
        pass: 2,
        maxPasses: 4,
        passCount: 2,
        activation: "running",
        templateVersion: 1,
        authoredContextId: "refine-plan",
      },
    },
  },
};

export const RuntimeExpansion: Story = {
  args: {
    data: {
      context: makeContext({
        title: "Verify telemetry regression",
        placement: { lane: "telemetry", mode: "readOnly" },
      }),
      tasks: makeTasks(2),
      mode: "execution",
      laneState: "active",
      laneCreatedAtRuntime: true,
      configOverrides: [],
      contextState: contextState("ready", { totalTaskCount: 2 }),
      waitState: { kind: "ready" },
      provenance: {
        requestId: "expand-telemetry-check",
        invokerContextId: "end-to-end-verification",
        rationale: "The live verification exposed an unplanned telemetry gap.",
        payloadHash: "sha256:story-fixture",
        acceptedAt: "2026-08-23T04:13:00.000Z",
      },
    },
  },
};

export const ValidatorCohort: Story = {
  args: {
    data: {
      context: makeContext({
        title: "Review the trust boundary",
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "security",
              profile: { tier: "builtin", id: "security-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
              },
              continuity: { enabled: true },
            },
            {
              id: "product",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "conversation",
              authority: "advisory",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: false },
            },
          ],
        },
      }),
      tasks: makeTasks(4),
      mode: "builder",
      laneState: "pending",
      configOverrides: ["validator cohort"],
    },
  },
};

// ---------------------------------------------------------------------------
// The design's eight-state gallery (`0 Index.dc.html`), in one canvas so the
// states can be compared side by side rather than one story at a time.
// ---------------------------------------------------------------------------

function contextState(
  status: NonNullable<ExecutionContextNodeData["contextState"]>["status"],
  overrides: Partial<
    NonNullable<ExecutionContextNodeData["contextState"]>
  > = {},
): NonNullable<ExecutionContextNodeData["contextState"]> {
  return {
    skipReason: null,
    landingIntent: null,
    pendingApproval: null,
    pendingUserInputs: {},
    contextId: "ctx-1",
    status,
    totalTaskCount: 5,
    completedTaskCount: 0,
    iterationCount: 1,
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
    ...overrides,
  };
}

const OWNED_DELIVERY = {
  lane: "delivery",
  mode: "owned" as const,
  ownedPaths: ["src/checkout", "src/risk"],
};

interface GalleryEntry {
  id: string;
  data: ExecutionContextNodeData;
  selected?: boolean;
}

const GALLERY: [GalleryEntry, ...GalleryEntry[]] = [
  {
    id: "running-selected",
    selected: true,
    data: {
      context: makeContext({
        title: "Implement checkout",
        placement: OWNED_DELIVERY,
      }),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: ["implementer model"],
      contextState: contextState("running", { completedTaskCount: 3 }),
      waitState: { kind: "running" },
    },
  },
  {
    id: "completed-full",
    data: {
      context: makeContext({
        title: "Plan the migration",
        placement: { lane: "plan", mode: "full" },
      }),
      tasks: makeTasks(3),
      mode: "execution",
      laneState: "merged",
      configOverrides: [],
      contextState: contextState("completed", {
        totalTaskCount: 3,
        completedTaskCount: 3,
      }),
      waitState: { kind: "completed" },
    },
  },
  {
    id: "pending-waiting",
    data: {
      context: makeContext({
        title: "Rollout switch",
        placement: { lane: "delivery", mode: "full" },
      }),
      tasks: makeTasks(2),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: contextState("ready", { totalTaskCount: 2 }),
      // The amber notice is derived from grade + wait state, never authored.
      waitState: { kind: "waiting-for-lane", laneId: "delivery" },
    },
  },
  {
    id: "read-only-session",
    data: {
      context: makeContext({
        title: "Release notes",
        placement: { lane: "session", mode: "readOnly" },
      }),
      tasks: makeTasks(2),
      mode: "execution",
      laneState: "session",
      configOverrides: [],
      contextState: contextState("pending", { totalTaskCount: 2 }),
      waitState: {
        kind: "dependency-blocked",
        unmetDependencyIds: ["ctx-rollout"],
        blockedByApproval: false,
      },
    },
  },
  {
    id: "halted-resumable",
    data: {
      context: makeContext({
        title: "Implement checkout",
        placement: OWNED_DELIVERY,
      }),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: ["implementer model"],
      contextState: contextState("halted", { completedTaskCount: 3 }),
      waitState: { kind: "halted" },
    },
  },
  {
    id: "awaiting-approval",
    data: {
      context: makeContext({
        title: "Implement checkout",
        placement: OWNED_DELIVERY,
      }),
      tasks: makeTasks(5),
      mode: "execution",
      laneState: "active",
      configOverrides: [],
      contextState: contextState("awaiting_approval", {
        completedTaskCount: 5,
        pendingApproval: {
          conversationId: "conv-1",
          requestedAt: "2026-06-10T09:00:00.000Z",
          decision: null,
          approvalScope: { kind: "whole_tree" },
        },
      }),
      waitState: { kind: "awaiting-approval" },
    },
  },
  {
    id: "draft",
    data: {
      context: makeContext({
        title: "Settings surface",
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["src/settings"],
        },
      }),
      tasks: makeTasks(3),
      mode: "builder",
      laneState: "pending",
      configOverrides: [],
    },
  },
  {
    id: "published",
    data: {
      context: makeContext({
        title: "Plan the migration",
        placement: { lane: "plan", mode: "full" },
      }),
      tasks: makeTasks(3),
      mode: "execution",
      laneState: "merged",
      configOverrides: [],
      // Published is DERIVED from the run's publication data — there is no
      // stored `published` context status behind this card.
      contextState: contextState("completed", {
        totalTaskCount: 3,
        completedTaskCount: 3,
        worktreePath: "/tmp/wt-plan",
        branchName: "csm/checkout-v2.plan",
        isolation: "worktree",
        mergeStatus: "merged-success",
        cleanupStatus: "removed",
      }),
      waitState: { kind: "published" },
    },
  },
];

function GalleryStory() {
  const nodes = GALLERY.map((entry, index) => ({
    id: entry.id,
    type: "executionContext" as const,
    position: { x: (index % 4) * 300, y: Math.floor(index / 4) * 340 },
    data: entry.data,
    selected: entry.selected ?? false,
  }));

  return (
    <ReactFlowProvider>
      <div style={{ width: 1240, height: 760, background: "var(--bg-void)" }}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.05 }}
        />
      </div>
    </ReactFlowProvider>
  );
}

/**
 * running · selected, completed · full, pending · waiting, read-only · session,
 * halted · resumable, awaiting approval, draft, published.
 */
export const DesignStateGallery: Story = {
  args: { data: GALLERY[0].data },
  render: () => <GalleryStory />,
};
