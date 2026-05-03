import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabPhaseStrip from "./CollabPhaseStrip";

const meta = {
  title: "Collab/CollabPhaseStrip",
  component: CollabPhaseStrip,
  args: {
    onStop: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 16, maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabPhaseStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullActiveR1 = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "active" },
      { kind: { kind: "negotiation", round: 2 }, status: "pending" },
      { kind: { kind: "negotiation", round: 3 }, status: "pending" },
      { kind: { kind: "final_answer" }, status: "pending" },
    ],
  },
} satisfies Story;

export const ConvergedFinal = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "negotiation", round: 2 }, status: "done" },
      { kind: { kind: "final_answer" }, status: "done" },
    ],
    verdict: "converged",
  },
} satisfies Story;

export const AwaitingAlex = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "open_conflicts" }, status: "active" },
    ],
    verdict: "ask_user",
  },
} satisfies Story;

export const Failed = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "failed" }, status: "done" },
    ],
    verdict: "failed",
  },
} satisfies Story;

export const UserStopped = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "active" },
    ],
    verdict: "user_stopped",
  },
} satisfies Story;

export const PinnedCompactActive = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "active" },
      { kind: { kind: "negotiation", round: 2 }, status: "pending" },
      { kind: { kind: "final_answer" }, status: "pending" },
    ],
    compact: true,
  },
} satisfies Story;

export const PinnedCompactConverged = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "final_answer" }, status: "done" },
    ],
    verdict: "converged",
    compact: true,
  },
} satisfies Story;
