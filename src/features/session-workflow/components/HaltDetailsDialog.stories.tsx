import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import HaltDetailsDialog from "./HaltDetailsDialog";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";

const meta = {
  title: "SessionWorkflow/HaltDetailsDialog",
  component: HaltDetailsDialog,
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  args: {
    open: true,
    onOpenChange: () => {},
    onResume: () => {},
    conflictAnalysis: null,
    canResume: true,
    isMutating: false,
    isResuming: false,
  },
} satisfies Meta<typeof HaltDetailsDialog>;

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
    "Pre-merge validation failed\n$ bun scripts/generate-build-info.ts\n$ bun scripts/seam-adoption.ts --check\n$ bun run build:info && NODE_ENV=production next build && bun run build:cli\n⚠ Warning: Next.js inferred your workspace root, but it may not be correct.\nDetected additional lockfiles",
  conflictFiles: Array.from(
    { length: 40 },
    (_, i) => `src/lib/specs/generated-file-${i}.ts`,
  ),
};

const agentTurnFailed: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-implement",
  engine: "claude",
  cause: "sdk_error",
  message:
    "SDK stream ended unexpectedly after 42 turns.\nQuerySession ended: the underlying stdin channel was closed before the turn completed.",
};

const secondaryFailures: GraphWorkflowHaltReason[] = [
  {
    type: "agent_turn_failed",
    contextId: "context-review",
    engine: "codex",
    cause: "unknown",
    message: "Lane agent exited before reporting a result.",
  },
  {
    type: "max_iterations",
    contextId: "context-validate",
    iterationCount: 5,
  },
];

/** The screenshot scenario: a final-publish join failure with a long validation
 *  transcript and dozens of conflict files. The dialog body scrolls; the page
 *  layout behind it is untouched. */
export const JoinFailureWithConflicts: Story = {
  args: { primary: longJoinFailure },
};

export const AgentTurnFailed: Story = {
  args: { primary: agentTurnFailed },
};

export const WithSecondaryFailures: Story = {
  args: { primary: agentTurnFailed, secondary: secondaryFailures },
};

export const ResumingInFlight: Story = {
  args: { primary: agentTurnFailed, isMutating: true, isResuming: true },
};
