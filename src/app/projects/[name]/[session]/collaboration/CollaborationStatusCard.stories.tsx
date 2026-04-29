import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { CollaborationStatusCard } from "./CollaborationStatusCard";
import type { CollaborationEnvelopeView } from "@/lib/api-client";

const baseEnvelope: CollaborationEnvelopeView = {
  workflowId: "wf-demo",
  workflowType: "collaboration",
  status: "running",
  phase: "round_2",
  createdAt: "2026-04-28T09:50:00.000Z",
  updatedAt: "2026-04-28T10:05:00.000Z",
  featureSnapshot: {
    brief:
      "Design a multi-agent debate loop that converges on a merged design, " +
      "with both agents producing structured per-round responses.",
    rounds: 2,
    maxIterations: 5,
  },
};

const meta = {
  title: "Session/Collaboration/CollaborationStatusCard",
  component: CollaborationStatusCard,
  args: {
    envelope: baseEnvelope,
    onResumeClick: fn(),
    onSelect: fn(),
    isSelected: false,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 480 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollaborationStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: {
    envelope: { ...baseEnvelope, status: "running", phase: "round_2" },
  },
};

export const Paused: Story = {
  args: {
    envelope: {
      ...baseEnvelope,
      status: "paused",
      phase: "round_3_review",
      pause: {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "tok-paused-demo",
        reason:
          "Codex flagged a disagreement that needs your input before " +
          "round 4 can begin.",
      },
      featureSnapshot: {
        ...(baseEnvelope.featureSnapshot as Record<string, unknown>),
        rounds: 3,
      },
    },
  },
};

export const Completed: Story = {
  args: {
    envelope: {
      ...baseEnvelope,
      status: "completed",
      phase: "scribe_done",
      updatedAt: "2026-04-28T10:42:00.000Z",
      completedAt: "2026-04-28T10:42:00.000Z",
      featureSnapshot: {
        brief: baseEnvelope.featureSnapshot
          ? (baseEnvelope.featureSnapshot as Record<string, unknown>)["brief"]
          : "",
        rounds: 4,
        maxIterations: 5,
        mergedDesignArtifactId: "art-merged-design-12",
        transcriptArtifactId: "art-transcript-12",
        openQuestionsArtifactId: "art-open-questions-12",
      },
    },
  },
};

export const Failed: Story = {
  args: {
    envelope: {
      ...baseEnvelope,
      status: "failed",
      phase: "round_2",
      updatedAt: "2026-04-28T10:18:00.000Z",
      errorSummary:
        "process restart - in-memory worker not found. Start a new run to retry.",
    },
  },
};

export const Selected: Story = {
  args: {
    envelope: { ...baseEnvelope, status: "running" },
    isSelected: true,
  },
};
