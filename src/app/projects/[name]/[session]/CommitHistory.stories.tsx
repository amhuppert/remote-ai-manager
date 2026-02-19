import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { CommitLogEntry } from "@/types";
import CommitHistory from "./CommitHistory";

const sampleCommits = [
  {
    hash: "a1b2c3d",
    fullHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    message: "Add session validation layer",
    date: new Date(Date.now() - 300_000).toISOString(),
    filesChanged: 3,
  },
  {
    hash: "e5f6g7h",
    fullHash: "e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6",
    message: "Refactor state management to use atomic writes",
    date: new Date(Date.now() - 3600_000).toISOString(),
    filesChanged: 5,
  },
  {
    hash: "i9j0k1l",
    fullHash: "i9j0k1l2m3n4i9j0k1l2m3n4i9j0k1l2m3n4i9j0",
    message: "Fix race condition in prompt execution",
    date: new Date(Date.now() - 86400_000).toISOString(),
    filesChanged: 2,
  },
  {
    hash: "m3n4o5p",
    fullHash: "m3n4o5p6q7r8m3n4o5p6q7r8m3n4o5p6q7r8m3n4",
    message: "Initial session scaffolding",
    date: new Date(Date.now() - 172800_000).toISOString(),
    filesChanged: 8,
  },
] satisfies CommitLogEntry[];

const meta = {
  title: "Session/CommitHistory",
  component: CommitHistory,
  args: {
    projectName: "my-app",
    sessionName: "implement-auth",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommitHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: {
    commits: [],
  },
} satisfies Story;

export const SingleCommit = {
  args: {
    commits: sampleCommits.slice(0, 1),
  },
} satisfies Story;

export const MultipleCommits = {
  args: {
    commits: sampleCommits,
  },
} satisfies Story;
