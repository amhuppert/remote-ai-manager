import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ConversationHistoryList from "./ConversationHistoryList";
import type { ConversationHistoryRow } from "./conversation-history";

const CANONICAL_ROWS: ConversationHistoryRow[] = [
  {
    conversationId: "conv_implementer",
    status: "live",
    startedAt: "2026-03-27T09:40:00.000Z",
    endedAt: null,
    endReason: null,
    iterations: [1, 2],
    events: [
      { kind: "started", at: "2026-03-27T09:40:00.000Z", iteration: 1 },
      {
        kind: "task_completed",
        at: "2026-03-27T10:10:00.000Z",
        iteration: 1,
        taskId: "task-implement-0",
        taskTitle: "Read the existing audit writer",
      },
      {
        kind: "verdict",
        at: "2026-03-27T10:42:00.000Z",
        seat: "security",
        pass: false,
        summary: "risk rules bypass the audit log on the timeout path",
        iteration: 1,
        roundSeq: 1,
        transcriptConversationId: "conv_val_security",
      },
      {
        kind: "iteration_began",
        at: "2026-03-27T10:45:00.000Z",
        iteration: 2,
        reopenedTaskIds: ["task-implement-1"],
      },
      {
        kind: "validating",
        at: "2026-03-27T11:09:00.000Z",
        seat: "security",
        iteration: 2,
        transcriptConversationId: "conv_val_security",
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

/** Iterations and validator verdicts stay in the same conversation. */
export const ContinuousConversation: Story = {
  args: { rows: CANONICAL_ROWS, onOpenTranscript: fn() },
};

/** Resetting a validator preserves both judgements in its continuous transcript. */
export const RepeatedVerdictAfterReset: Story = {
  args: {
    rows: CANONICAL_ROWS.map(
      (row): ConversationHistoryRow => ({
        ...row,
        iterations: [1],
        events: [
          { kind: "started", at: "2026-03-27T09:40:00.000Z", iteration: 1 },
          ...["2026-03-27T10:41:00.000Z", "2026-03-27T10:52:00.000Z"].map(
            (at) => ({
              kind: "verdict" as const,
              at,
              seat: "security",
              pass: false,
              summary: "risk rules bypass the audit log on the timeout path",
              iteration: 1,
              roundSeq: 1,
              transcriptConversationId: "conv_val_security",
            }),
          ),
        ],
      }),
    ),
    onOpenTranscript: fn(),
  },
};

/** The same history for a reader with no Log surface: no transcript controls. */
export const WithoutTranscriptAccess: Story = {
  args: { rows: CANONICAL_ROWS },
};

export const NeverRun: Story = {
  args: { rows: [], onOpenTranscript: fn() },
};
