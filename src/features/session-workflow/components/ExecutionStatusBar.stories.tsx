import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
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

export const Running: Story = {
  args: {
    execution: createWorkflowExecution({ status: "running" }),
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
