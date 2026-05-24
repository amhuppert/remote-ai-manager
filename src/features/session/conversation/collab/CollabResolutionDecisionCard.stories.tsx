import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeBlockingImplementationDisagreement,
  makeImplementationDisagreement,
  makeObjectiveDisagreement,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFail,
  makeResolutionDecisionFinal,
  makeResolvedDisagreement,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabResolutionDecisionCard, {
  type CollabResolutionDecisionCardProps,
} from "@/features/session/conversation/collab/CollabResolutionDecisionCard";

const meta = {
  title: "Collab/CollabResolutionDecisionCard",
  component: CollabResolutionDecisionCard,
  args: {
    onRefClick: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabResolutionDecisionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromResolutionDecisionFixture(
  fixture: ReturnType<typeof makeResolutionDecisionFinal>,
  backend: CollaborationAgent,
  round: number,
  trajectory: number[],
): Omit<CollabResolutionDecisionCardProps, "onRefClick"> {
  return {
    agent: backend,
    round,
    agreementReached: fixture.agreementReached,
    nextAction: fixture.nextAction,
    acceptedPoints: fixture.acceptedPoints,
    resolvedDisagreements: fixture.resolvedDisagreements,
    remainingDisagreements: fixture.remainingDisagreements,
    userQuestions: fixture.userQuestions,
    rationale: fixture.rationale,
    trajectory,
  };
}

export const ConvergedR3FromFixture = {
  args: fromResolutionDecisionFixture(
    makeResolutionDecisionFinal({
      resolvedDisagreements: [
        makeResolvedDisagreement(),
        makeResolvedDisagreement({
          disagreementId: "D-obj-1",
          resolution: "Treat as design doc, not implementation plan",
          rationale: "Aligns with the user's original ask",
        }),
      ],
    }),
    "claude",
    3,
    [3, 2, 0],
  ),
} satisfies Story;

export const ContinueR1NoSparklineFromFixture = {
  args: fromResolutionDecisionFixture(
    makeResolutionDecisionContinue({
      remainingDisagreements: [
        makeImplementationDisagreement(),
        makeObjectiveDisagreement(),
      ],
    }),
    "claude",
    1,
    [3],
  ),
} satisfies Story;

export const AskUserR2FromFixture = {
  args: fromResolutionDecisionFixture(
    makeResolutionDecisionAskUser(),
    "claude",
    2,
    [3, 1],
  ),
} satisfies Story;

export const FailedR3FromFixture = {
  args: fromResolutionDecisionFixture(
    makeResolutionDecisionFail({
      remainingDisagreements: [
        makeBlockingImplementationDisagreement(),
        makeObjectiveDisagreement(),
      ],
    }),
    "claude",
    3,
    [4, 3, 2],
  ),
} satisfies Story;
