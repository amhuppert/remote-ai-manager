import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { GraphWorkflowExecutionContextDefinition } from "@/types";
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
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
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

export const Pending: Story = {
  args: {
    data: {
      context: makeContext(),
      tasks: makeTasks(5),
      mode: "execution",
      contextState: {
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
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
        contextId: "ctx-1",
        status: "ready",
        totalTaskCount: 5,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
      },
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
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
        iterationCount: 1,
        consecutiveFailureCount: 0,
      },
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
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
      },
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
        contextId: "ctx-1",
        status: "completed",
        totalTaskCount: 5,
        completedTaskCount: 5,
        iterationCount: 1,
        consecutiveFailureCount: 0,
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
        contextId: "ctx-1",
        status: "halted",
        totalTaskCount: 5,
        completedTaskCount: 3,
        iterationCount: 2,
        consecutiveFailureCount: 2,
      },
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
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 5,
        completedTaskCount: 2,
        iterationCount: 1,
        consecutiveFailureCount: 0,
      },
    },
    selected: true,
  },
};
