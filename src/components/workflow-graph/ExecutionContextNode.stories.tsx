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
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
    },
    mutability: { allowAgentTaskAdd: false },
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
    },
  },
};

export const DependencyBlocked: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 5,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 5,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "completed",
        totalTaskCount: 5,
        completedTaskCount: 5,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "completed",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
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
      contextState: {
        pendingApproval: {
          conversationId: "conv-1",
          requestedAt: "2026-06-10T09:00:00.000Z",
          decision: null,
        },
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "awaiting_approval",
        totalTaskCount: 5,
        completedTaskCount: 5,
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
      contextState: {
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 5,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "halted",
        totalTaskCount: 5,
        completedTaskCount: 3,
        iterationCount: 2,
        consecutiveFailureCount: 2,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
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
      contextState: {
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
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
    },
  },
};

export const ValidatorsInheritedClaude: Story = {
  args: {
    data: {
      context: {
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
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
    },
  },
};

export const ValidatorsInheritedScriptAndCodex: Story = {
  args: {
    data: {
      context: {
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
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
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
    },
  },
};

export const ApprovalGateWithValidators: Story = {
  args: {
    data: {
      context: {
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
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
      tasks: makeTasks(3),
      mode: "builder",
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
    },
  },
};
