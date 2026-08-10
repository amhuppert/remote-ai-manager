import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { NodeTypes, EdgeTypes, Node, Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { GraphWorkflowContextStatus } from "@/lib/workflow-graph/definition-schemas";
import type { ExecutionContextNodeData, ContextEdgeData } from "./derive-graph";
import ExecutionContextNode from "./ExecutionContextNode";
import ContextEdge from "./ContextEdge";
import "./workflow-graph.css";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

function makeNode(
  id: string,
  title: string,
  x: number,
  y: number,
  status?: GraphWorkflowContextStatus,
): Node<ExecutionContextNodeData> {
  return {
    id,
    type: "executionContext",
    position: { x, y },
    data: {
      context: {
        id,
        title,
        acceptanceCriteria: "TBD",
        placement: { lane: id, mode: "full" },
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
      },
      tasks: [
        {
          id: `${id}-t1`,
          contextId: id,
          order: 1,
          title: "Task 1",
          instructions: "",
          source: "user",
        },
      ],
      mode: status ? "execution" : "builder",
      ...(status && {
        contextState: {
          contextId: id,
          status,
          totalTaskCount: 1,
          completedTaskCount: status === "completed" ? 1 : 0,
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
          pendingApproval: null,
          pendingUserInputs: {},
          skipReason: null,
          landingIntent: null,
        },
      }),
    },
  };
}

function EdgeStory({
  sourceStatus,
  targetStatus,
}: {
  sourceStatus?: GraphWorkflowContextStatus;
  targetStatus?: GraphWorkflowContextStatus;
}) {
  const nodes = [
    makeNode("src", "Source Context", 50, 20, sourceStatus),
    makeNode("tgt", "Target Context", 50, 320, targetStatus),
  ];

  const edges: Edge<ContextEdgeData>[] = [
    {
      id: "e1",
      source: "src",
      target: "tgt",
      type: "contextEdge",
      data: {
        sourceStatus: sourceStatus as ContextEdgeData["sourceStatus"],
        targetStatus: targetStatus as ContextEdgeData["targetStatus"],
      },
    },
  ];

  return (
    <ReactFlowProvider>
      <div style={{ width: 380, height: 620, background: "var(--bg-void)" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.1 }}
        />
      </div>
    </ReactFlowProvider>
  );
}

const meta = {
  title: "WorkflowGraph/ContextEdge",
  component: EdgeStory,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
} satisfies Meta<typeof EdgeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const Active: Story = {
  args: {
    sourceStatus: "completed",
    targetStatus: "running",
  },
};

export const Completed: Story = {
  args: {
    sourceStatus: "completed",
    targetStatus: "completed",
  },
};

export const PendingToReady: Story = {
  args: {
    sourceStatus: "completed",
    targetStatus: "ready",
  },
};
