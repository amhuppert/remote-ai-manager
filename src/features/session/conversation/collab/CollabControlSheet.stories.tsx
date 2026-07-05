import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabControlSheet from "@/features/session/conversation/collab/CollabControlSheet";

const meta = {
  title: "Collab/CollabControlSheet",
  component: CollabControlSheet,
  args: {
    onExpandAll: fn(),
    onCollapseAll: fn(),
    onStop: fn(),
    onClose: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CollabControlSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningRound = {
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

export const Converged = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "final_answer" }, status: "done" },
    ],
    verdict: "converged",
    onStop: undefined,
  },
} satisfies Story;
