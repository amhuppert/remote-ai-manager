import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ConversationHistoryList from "./ConversationHistoryList";
import type { ConversationHistoryRow } from "./conversation-history";

/**
 * The canonical fixture's three-conversation history (README §3.3): iteration 1
 * split across two conversations by a rotation, a returning validation that
 * opened iteration 2 inside the conversation already live for it, and a later
 * conversation carrying iteration 2 to the seat now judging it.
 *
 * The fixture narrates the first rotation as a context-limit one. The execution
 * records no rotation provenance, so the rows link the transition in both
 * directions and claim no cause — which is what these stories show.
 *
 * Rows are authored here rather than derived from an execution: the story is
 * about how the shapes READ, and `conversation-history.test.ts` is what proves
 * an execution produces them.
 */
const CANONICAL_ROWS: ConversationHistoryRow[] = [
  {
    conversationId: "conv_b41f",
    status: "live",
    startedAt: "2026-03-27T10:52:00.000Z",
    endedAt: null,
    endReason: null,
    iterations: [2],
    events: [
      {
        kind: "started",
        at: "2026-03-27T10:52:00.000Z",
        iteration: 2,
        rotatedFrom: "conv_a9c2",
      },
      {
        kind: "task_completed",
        at: "2026-03-27T11:04:00.000Z",
        iteration: 2,
        taskId: "task-implement-1",
        taskTitle: "Write the timeout-path audit record",
      },
      {
        kind: "validating",
        at: "2026-03-27T11:09:00.000Z",
        seat: "security",
        iteration: 2,
        transcriptConversationId: "conv_val_security_2",
      },
    ],
  },
  {
    conversationId: "conv_a9c2",
    status: "ended",
    startedAt: "2026-03-27T10:14:00.000Z",
    endedAt: "2026-03-27T10:52:00.000Z",
    endReason: { kind: "superseded", successorId: "conv_b41f" },
    iterations: [1, 2],
    events: [
      {
        kind: "started",
        at: "2026-03-27T10:14:00.000Z",
        iteration: 1,
        rotatedFrom: "conv_88d0",
      },
      {
        kind: "task_completed",
        at: "2026-03-27T10:38:00.000Z",
        iteration: 1,
        taskId: "task-implement-1",
        taskTitle: "Write the timeout-path audit record",
      },
      {
        kind: "verdict",
        at: "2026-03-27T10:42:00.000Z",
        seat: "security",
        pass: false,
        summary: "risk rules bypass the audit log on the timeout path",
        iteration: 1,
        roundSeq: 1,
        transcriptConversationId: "conv_val_security_1",
      },
      {
        kind: "iteration_began",
        at: "2026-03-27T10:45:00.000Z",
        iteration: 2,
        reopenedTaskIds: ["task-implement-1"],
      },
      {
        kind: "ended",
        at: "2026-03-27T10:52:00.000Z",
        reason: { kind: "superseded", successorId: "conv_b41f" },
      },
    ],
  },
  {
    conversationId: "conv_88d0",
    status: "ended",
    startedAt: "2026-03-27T09:40:00.000Z",
    endedAt: "2026-03-27T10:14:00.000Z",
    endReason: { kind: "superseded", successorId: "conv_a9c2" },
    iterations: [1],
    events: [
      {
        kind: "started",
        at: "2026-03-27T09:40:00.000Z",
        iteration: 1,
        rotatedFrom: null,
      },
      {
        kind: "task_completed",
        at: "2026-03-27T10:10:00.000Z",
        iteration: 1,
        taskId: "task-implement-0",
        taskTitle: "Read the existing audit writer",
      },
      {
        kind: "ended",
        at: "2026-03-27T10:14:00.000Z",
        reason: { kind: "superseded", successorId: "conv_a9c2" },
      },
    ],
  },
];

function StoryWrapper(
  props: React.ComponentPropsWithoutRef<typeof ConversationHistoryList>,
) {
  return (
    <div className="w-[420px] bg-bg-void p-lg">
      <ConversationHistoryList {...props} />
    </div>
  );
}

const meta = {
  title: "Workflow/Inspector/ConversationHistoryList",
  component: StoryWrapper,
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All three conversations, each transcript independently reachable. */
export const CanonicalThreeConversations: Story = {
  args: { rows: CANONICAL_ROWS, onOpenTranscript: fn() },
};

/** The same history for a reader with no Log surface: no transcript controls. */
export const WithoutTranscriptAccess: Story = {
  args: { rows: CANONICAL_ROWS },
};

export const NeverRun: Story = {
  args: { rows: [], onOpenTranscript: fn() },
};
