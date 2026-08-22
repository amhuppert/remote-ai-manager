import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import ExecutionStatusBar from "./ExecutionStatusBar";

const meta = {
  title: "SessionWorkflow/ExecutionStatusBar",
  component: ExecutionStatusBar,
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  args: {
    onPause: fn(),
    onResume: fn(),
    onAbort: fn(),
    isMutating: false,
    pendingAction: null,
  },
} satisfies Meta<typeof ExecutionStatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const longJoinFailure: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: "join-final",
  joinKind: "final_publish",
  contextId: null,
  sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
  targetLaneId: "__session__",
  message:
    "Pre-merge validation failed\n$ bun scripts/generate-build-info.ts\n$ bun scripts/seam-adoption.ts --check\n$ bun run build:info && NODE_ENV=production next build && bun run build:cli\nDetected additional lockfiles",
  conflictFiles: Array.from(
    { length: 40 },
    (_, i) => `src/lib/specs/generated-file-${i}.ts`,
  ),
};

const resumableHalt: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-implement",
  engine: "claude",
  cause: "sdk_error",
  message: "SDK stream ended unexpectedly",
};

/** A run with two contexts parked on a human gate, so the amber chip counts. */
function withWaitingGates(): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "running" });
  return {
    ...base,
    contextStates: Object.fromEntries(
      Object.entries(base.contextStates).map(([contextId, state]) => [
        contextId,
        contextId === "context-plan" || contextId === "context-implement"
          ? {
              ...state,
              status: "awaiting_approval" as const,
              pendingApproval: {
                conversationId: `conv-${contextId}`,
                requestedAt: "2026-08-20T10:00:00.000Z",
                decision: null,
                approvalScope: { kind: "whole_tree" as const },
              },
            }
          : state,
      ]),
    ),
  };
}

/** README §9: a run that has not started yet can only be aborted. */
export const Pending: Story = {
  args: {
    execution: createWorkflowExecution({ status: "pending" }),
  },
};

/** §9: the definition decision replaces the ordinary controls while parked. */
export const AwaitingDefinitionApproval: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-08-20T09:00:00.000Z",
        approvedAt: null,
      },
    }),
    onApproveDefinition: fn(),
    onRejectDefinition: fn(),
  },
};

/** A refused decision is reported where the decision was made. */
export const DefinitionApprovalRefused: Story = {
  args: {
    ...AwaitingDefinitionApproval.args,
    definitionApprovalError:
      "The execution changed since you started reviewing it.",
  },
};

export const Running: Story = {
  args: {
    execution: createWorkflowExecution({ status: "running" }),
  },
};

/** The state chip is the only pulsing element, and only while running. */
export const RunningWithWaitingGates: Story = {
  args: {
    execution: withWaitingGates(),
    onOpenGates: fn(),
  },
};

export const Paused: Story = {
  args: {
    execution: createWorkflowExecution({ status: "paused" }),
  },
};

/** §9: a resumable halt still holds the lease, so it offers Resume and Abandon. */
export const ResumableHalt: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "halted",
      haltReason: resumableHalt,
    }),
    onAbandon: fn(),
  },
};

/** Mid-mutation: the acting control names what it is doing and all are disabled. */
export const ResumePending: Story = {
  args: {
    execution: createWorkflowExecution({ status: "paused" }),
    isMutating: true,
    pendingAction: "resume",
  },
};

/**
 * A History selection: status and halt details stay readable, every mutation
 * control is gone (README §9, last row).
 */
export const HistoricalReadOnly: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "halted",
      haltReason: resumableHalt,
    }),
    onAbandon: fn(),
    allowActions: false,
  },
};

/** The bar stays one row tall no matter how large the failure output is; the
 *  summary truncates and "Details" opens the halt-details dialog. */
export const HaltedLongJoinFailure: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "halted",
      haltReason: longJoinFailure,
    }),
  },
};

export const HaltedWithSecondaryFailures: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "halted",
      haltReason: longJoinFailure,
      secondaryHaltReasons: [
        {
          type: "agent_turn_failed",
          contextId: "context-review",
          engine: "codex",
          cause: "unknown",
          message: "Lane agent exited before reporting a result.",
        },
      ],
    }),
  },
};
