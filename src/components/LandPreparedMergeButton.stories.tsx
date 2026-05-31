import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import LandPreparedMergeButton from "./LandPreparedMergeButton";
import type { BackgroundJob } from "@/lib/jobs/schemas";

const baseJob: BackgroundJob = {
  jobId: "job-001",
  jobType: "merge",
  status: "ready-to-land",
  projectName: "my-app",
  sessionName: "implement-auth",
  branchName: "csm/implement-auth",
  startedAt: new Date().toISOString(),
  preparedSha: "a3f7c2e1d8b9f4c5e6a7b8c9d0e1f2a3b4c5d6e7",
  parkedRef: "refs/cc-merges/job-001",
  phase: "awaiting-land",
};

const meta = {
  title: "Components/LandPreparedMergeButton",
  component: LandPreparedMergeButton,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 440, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    job: baseJob,
  },
} satisfies Meta<typeof LandPreparedMergeButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle = {
  args: {
    override: {
      landPending: false,
      discardPending: false,
      onLand: fn(),
      onDiscard: fn(),
    },
  },
} satisfies Story;

export const LandInFlight = {
  args: {
    override: {
      landPending: true,
      discardPending: false,
      onLand: fn(),
      onDiscard: fn(),
    },
  },
} satisfies Story;

export const DiscardInFlight = {
  args: {
    override: {
      landPending: false,
      discardPending: true,
      onLand: fn(),
      onDiscard: fn(),
    },
  },
} satisfies Story;
