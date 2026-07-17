import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CollabPendingCard from "@/features/session/conversation/collab/CollabPendingCard";
import type { CollabPendingStep } from "@/features/session/conversation/collab/collab-pending";

const meta = {
  title: "Collab/CollabPendingCard",
  component: CollabPendingCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabPendingCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const draftPrimary: CollabPendingStep = {
  id: "pending-draft-primary",
  kind: "initial_draft",
  flowAgent: "agent_one",
  agent: "claude",
  lane: "left",
  rowId: "drafts",
  rowKind: "drafts",
  mergeIntoDraftsRow: true,
  eyebrow: "Initial Draft",
  statusText: "drafting",
  lines: 3,
};

export const ClaudeDrafting = {
  args: {
    step: draftPrimary,
    modelSettings: { model: "Opus", effort: "xhigh" },
  },
} satisfies Story;

export const CodexDrafting = {
  args: {
    step: {
      ...draftPrimary,
      id: "pending-draft-secondary",
      flowAgent: "agent_two",
      agent: "codex",
      lane: "right",
    },
    modelSettings: { model: "GPT-5.4", effort: "high" },
  },
} satisfies Story;

export const CrossReview = {
  args: {
    step: {
      id: "pending-cross-review",
      kind: "cross_review",
      flowAgent: "agent_two",
      agent: "codex",
      lane: "right",
      sourceLaneOverride: "left",
      rowId: "cross-review",
      rowKind: "cross-review",
      mergeIntoDraftsRow: false,
      eyebrow: "Cross-review",
      statusText: "reviewing Claude's draft",
      lines: 2,
    },
    modelSettings: { model: "GPT-5.4", effort: "high" },
  },
} satisfies Story;

export const CounterProposal = {
  args: {
    step: {
      id: "pending-round-1-counter",
      kind: "counter_proposal",
      flowAgent: "agent_two",
      agent: "codex",
      lane: "right",
      rowId: "round-1-counter",
      rowKind: "counter",
      mergeIntoDraftsRow: false,
      eyebrow: "Counter-proposal",
      statusText: "drafting counter-proposal",
      round: 1,
      lines: 2,
    },
    modelSettings: { model: "GPT-5.4", effort: "high" },
  },
} satisfies Story;

export const FinalAnswer = {
  args: {
    step: {
      id: "pending-final-answer",
      kind: "final_answer",
      flowAgent: "agent_one",
      agent: "claude",
      lane: "full",
      rowId: "final-answer",
      rowKind: "final-answer",
      mergeIntoDraftsRow: false,
      eyebrow: "Final answer",
      statusText: "composing final answer",
      lines: 3,
    },
    modelSettings: { model: "Opus", effort: "xhigh" },
  },
} satisfies Story;

// Pre-model-settings runs render the header without a model/effort suffix.
export const NoModelSettings = {
  args: { step: draftPrimary },
} satisfies Story;
