import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabMobileBar from "@/features/session/conversation/collab/CollabMobileBar";

const meta = {
  title: "Collab/CollabMobileBar",
  component: CollabMobileBar,
  args: {
    currentIndex: 2,
    total: 7,
    onPrev: fn(),
    onNext: fn(),
    onOpenReader: fn(),
    onOpenControls: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 390,
          border: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabMobileBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveRound = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "negotiation", round: 2 }, status: "active" },
      { kind: { kind: "final_answer" }, status: "pending" },
    ],
  },
} satisfies Story;

export const Drafting = {
  args: {
    currentIndex: 0,
    total: 2,
    phases: [
      { kind: { kind: "initial_draft" }, status: "active" },
      { kind: { kind: "cross_review" }, status: "pending" },
    ],
  },
} satisfies Story;

export const AwaitingAlex = {
  args: {
    currentIndex: 4,
    total: 5,
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "open_conflicts" }, status: "active" },
    ],
    verdict: "ask_user",
  },
} satisfies Story;

export const Converged = {
  args: {
    currentIndex: 6,
    total: 7,
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

export const Failed = {
  args: {
    currentIndex: 2,
    total: 3,
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "failed" }, status: "done" },
    ],
    verdict: "failed",
  },
} satisfies Story;

export const SingleCard = {
  args: {
    currentIndex: 0,
    total: 1,
    phases: [{ kind: { kind: "initial_draft" }, status: "active" }],
  },
} satisfies Story;
