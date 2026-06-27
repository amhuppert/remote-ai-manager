import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { DecisionApprovalPanelView } from "@/features/session/conversation/DecisionApprovalPanel";
import type {
  DecisionProposal,
  DecisionProposalBatch,
} from "@/lib/session-alignment/schemas";

function proposal(overrides: Partial<DecisionProposal> = {}): DecisionProposal {
  return {
    id: "p1",
    projectPath: "/repo",
    sessionName: "sess",
    conversationId: "conv-1",
    batchId: "batch-1",
    statement:
      "Persist alignment in dedicated tables, app state authoritative.",
    rationale: null,
    context: null,
    originMessageId: "msg-1",
    createdAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

function batch(proposals: DecisionProposal[]): DecisionProposalBatch {
  return { batchId: "batch-1", proposals };
}

const meta = {
  title: "Session/DecisionApprovalPanel",
  component: DecisionApprovalPanelView,
  args: {
    isSubmitting: false,
    onSubmit: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: "680px", background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof DecisionApprovalPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleDecision = {
  args: { batch: batch([proposal()]) },
} satisfies Story;

export const MultipleDecisions = {
  args: {
    batch: batch([
      proposal({
        id: "p1",
        statement:
          "Guarantee per-turn charter propagation via runtime recreation.",
        rationale:
          "A baked-once runtime would miss mid-session charter changes.",
      }),
      proposal({
        id: "p2",
        statement: "Keep the worktree charter mirror non-authoritative.",
        context:
          "App state stays the source of truth; the mirror is for transparency.",
      }),
      proposal({
        id: "p3",
        statement: "Limit alignment to attended normal sessions.",
      }),
    ]),
  },
} satisfies Story;

export const Submitting = {
  args: { batch: batch([proposal()]), isSubmitting: true },
} satisfies Story;
