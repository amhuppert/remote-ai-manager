import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";
import SessionGitPanel from "@/features/session/git/SessionGitPanel";

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

const multiFileDiff: SessionDiff = {
  files: [
    {
      filePath: "src/lib/sessions.ts",
      additions: 25,
      deletions: 8,
      hunks: [
        {
          header: "@@ -10,6 +10,12 @@",
          lines: [
            {
              type: "context",
              content: "import { readState } from './state';",
            },
            {
              type: "add",
              content: "import { validateSession } from './validation';",
            },
            { type: "context", content: "" },
          ],
        },
      ],
    },
    {
      filePath: "src/lib/validation.ts",
      additions: 18,
      deletions: 0,
      hunks: [
        {
          header: "@@ -0,0 +1,18 @@",
          lines: [
            { type: "add", content: 'import { z } from "zod";' },
            { type: "add", content: "export const sessionSchema = z.object({" },
          ],
        },
      ],
    },
    {
      filePath: "src/app/api/sessions/route.ts",
      additions: 5,
      deletions: 2,
      hunks: [
        {
          header: "@@ -12,4 +12,7 @@",
          lines: [
            {
              type: "remove",
              content: "  const session = await createSession(body);",
            },
            {
              type: "add",
              content: "  const session = await createSession(body);",
            },
          ],
        },
      ],
    },
    {
      filePath: "src/components/Topbar.tsx",
      additions: 12,
      deletions: 4,
      hunks: [],
    },
    {
      filePath: "src/app/globals.css",
      additions: 45,
      deletions: 0,
      hunks: [],
    },
  ],
  totalAdditions: 105,
  totalDeletions: 14,
};

const sampleCommits: CommitLogEntry[] = [
  {
    hash: "a1b2c3d",
    fullHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    message: "Add session validation and error handling",
    date: new Date(Date.now() - 1_800_000).toISOString(),
    filesChanged: 3,
  },
  {
    hash: "e5f6g7h",
    fullHash: "e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6",
    message: "Refactor state management to use Zustand",
    date: new Date(Date.now() - 7_200_000).toISOString(),
    filesChanged: 5,
  },
  {
    hash: "k9l0m1n",
    fullHash: "k9l0m1n2o3p4k9l0m1n2o3p4k9l0m1n2o3p4k9l0",
    message: "Initial session creation with worktree setup",
    date: new Date(Date.now() - 86_400_000).toISOString(),
    filesChanged: 8,
  },
];

const meta = {
  title: "Session/SessionGitPanel",
  component: SessionGitPanel,
  args: {
    diff: multiFileDiff,
    commits: sampleCommits,
    projectName: "my-project",
    sessionName: "my-session",
    onRefresh: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionGitPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithChangesAndCommits: Story = {
  args: {},
};

export const ChangesOnly: Story = {
  args: {
    commits: [],
  },
};

export const CommitsOnly: Story = {
  args: {
    diff: emptyDiff,
  },
};

export const Empty: Story = {
  args: {
    diff: emptyDiff,
    commits: [],
  },
};
