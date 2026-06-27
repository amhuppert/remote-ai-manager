import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeAgentTwoCrossReview,
  makeBlockingImplementationDisagreement,
  makeMinorImplementationDisagreement,
  makeObjectiveDisagreement,
  makeReviseSelf,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabCrossReviewCard, {
  type CollabCrossReviewCardProps,
} from "@/features/session/conversation/collab/CollabCrossReviewCard";

const meta = {
  title: "Collab/CollabCrossReviewCard",
  component: CollabCrossReviewCard,
  args: {
    onRefClick: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabCrossReviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromCrossReviewFixture(
  fixture: ReturnType<typeof makeAgentTwoCrossReview>,
  reviewerBackend: CollaborationAgent,
  targetBackend: CollaborationAgent,
): Omit<CollabCrossReviewCardProps, "onRefClick"> {
  return {
    reviewerAgent: reviewerBackend,
    targetAgent: targetBackend,
    summary: fixture.summary,
    artifacts: fixture.artifacts,
    agree: fixture.agree,
    disagree: fixture.disagree,
    revise_self: fixture.revise_self,
  };
}

export const CodexReviewsClaudeFromFixture = {
  args: fromCrossReviewFixture(
    makeAgentTwoCrossReview({
      disagree: [
        makeBlockingImplementationDisagreement(),
        makeMinorImplementationDisagreement(),
      ],
      revise_self: [makeReviseSelf()],
    }),
    "codex",
    "claude",
  ),
} satisfies Story;

export const ClaudeReviewsCodexFromFixture = {
  args: fromCrossReviewFixture(
    makeAgentTwoCrossReview({
      agent: "agent_one",
      target_agent: "agent_two",
      summary:
        "Claude reviewing Codex's draft — objective scope concern blocks acceptance.",
      agree: [],
      disagree: [makeObjectiveDisagreement()],
      revise_self: [],
    }),
    "claude",
    "codex",
  ),
} satisfies Story;
