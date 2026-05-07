import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabPassage from "./CollabPassage";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
} from "@/lib/workflows/collaboration/test-fixtures";

const meta = {
  title: "Collab/CollabPassage",
  component: CollabPassage,
  args: {
    workflowId: "wf-1",
    primary: "claude",
    status: "drafting",
    artifacts: [],
    onStop: fn(),
    onRefClick: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: 32,
          background: "var(--bg-void)",
          minHeight: "100vh",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabPassage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DraftingNoArtifacts = {
  args: {
    status: "drafting",
    artifacts: [],
  },
} satisfies Story;

export const DraftingPrimaryFirst = {
  args: {
    status: "drafting",
    artifacts: [makeAgentOneInitialDraft()],
  },
} satisfies Story;

export const DraftingBothDrafts = {
  args: {
    status: "drafting",
    artifacts: [makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()],
  },
} satisfies Story;

export const NegotiatingThroughCrossReview = {
  args: {
    status: "negotiating",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
    ],
  },
} satisfies Story;

export const NegotiatingRoundOneInProgress = {
  args: {
    status: "negotiating",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
    ],
  },
} satisfies Story;

export const NegotiatingTwoRoundsContinuing = {
  args: {
    status: "negotiating",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
      makeResolutionDecisionContinue(),
      makeAgentOneProposedChanges({ narrative: "Round 2 proposal" }),
      makeAgentTwoCounterProposalRound2(),
    ],
  },
} satisfies Story;

export const PausedOnOpenConflicts = {
  args: {
    status: "paused",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeOpenConflicts(),
    ],
    pauseHandlers: {
      drafts: {},
      onDraftChange: fn(),
      onSubmit: fn(),
      isSubmitting: false,
    },
  },
} satisfies Story;

export const ConvergedFinalAnswer = {
  args: {
    status: "converged",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
      makeResolutionDecisionFinal(),
      makeFinalAnswer(),
    ],
  },
} satisfies Story;

export const UserStopped = {
  args: {
    status: "user-stopped",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
    ],
  },
} satisfies Story;

export const Failed = {
  args: {
    status: "failed",
    artifacts: [makeAgentOneInitialDraft()],
  },
} satisfies Story;

export const FailedWithErrorSummary = {
  args: {
    status: "failed",
    artifacts: [makeAgentTwoInitialDraft()],
    errorSummary:
      "agent_one initial_draft failed: Conversation not found (Claude session MCP server could not resolve the synthetic per-lane conversationId).",
  },
} satisfies Story;

export const PrimaryCodex = {
  args: {
    primary: "codex",
    status: "negotiating",
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
    ],
  },
} satisfies Story;

export const HiddenInlinePhaseStrip = {
  args: {
    status: "negotiating",
    hideInlinePhaseStrip: true,
    artifacts: [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
    ],
  },
} satisfies Story;
