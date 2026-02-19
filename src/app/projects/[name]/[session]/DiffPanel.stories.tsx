import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { SessionDiff, CommitLogEntry } from "@/types";
import DiffPanel from "./DiffPanel";

const emptyDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
} satisfies SessionDiff;

const singleFileDiff = {
  files: [
    {
      filePath: "src/lib/sessions.ts",
      additions: 12,
      deletions: 3,
      hunks: [
        {
          header: "@@ -45,8 +45,17 @@",
          lines: [
            { type: "context", content: "  const session = getSession(id);" },
            { type: "remove", content: "  return session.status;" },
            { type: "add", content: "  if (!session) {" },
            { type: "add", content: '    throw new Error("Session not found");' },
            { type: "add", content: "  }" },
            { type: "add", content: "  return session.status;" },
            { type: "context", content: "}" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 12,
  totalDeletions: 3,
} satisfies SessionDiff;

const multiFileDiff = {
  files: [
    {
      filePath: "src/lib/sessions.ts",
      additions: 25,
      deletions: 8,
      hunks: [
        {
          header: "@@ -10,6 +10,12 @@",
          lines: [
            { type: "context", content: "import { readState } from './state';" },
            { type: "add", content: "import { validateSession } from './validation';" },
            { type: "context", content: "" },
          ],
        },
        {
          header: "@@ -45,8 +51,20 @@",
          lines: [
            { type: "remove", content: "  // TODO: validate input" },
            { type: "add", content: "  const validated = validateSession(input);" },
            { type: "add", content: "  if (!validated.success) {" },
            {
              type: "add",
              content: '    throw new Error("Invalid session data");',
            },
            { type: "add", content: "  }" },
            { type: "context", content: "  return createWorktree(validated.data);" },
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
            { type: "add", content: "" },
            { type: "add", content: "export const sessionSchema = z.object({" },
            { type: "add", content: "  name: z.string().min(1)," },
            { type: "add", content: "  branch: z.string().min(1)," },
            { type: "add", content: "});" },
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
            { type: "remove", content: "  const session = await createSession(body);" },
            { type: "add", content: "  const session = await createSession(body);" },
            { type: "add", content: "  // Log creation for audit trail" },
            {
              type: "add",
              content: '  logger.info("session.created", { name: session.sessionName });',
            },
            { type: "context", content: "  return NextResponse.json(session);" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 48,
  totalDeletions: 10,
} satisfies SessionDiff;

const sampleCommits = [
  {
    hash: "a1b2c3d",
    fullHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    message: "Add session validation",
    date: new Date(Date.now() - 3600_000).toISOString(),
    filesChanged: 3,
  },
  {
    hash: "e5f6g7h",
    fullHash: "e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6",
    message: "Refactor state management",
    date: new Date(Date.now() - 86400_000).toISOString(),
    filesChanged: 5,
  },
] satisfies CommitLogEntry[];

const meta = {
  title: "Session/DiffPanel",
  component: DiffPanel,
  decorators: [
    (Story) => (
      <div style={{ width: 420, height: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiffPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: {
    diff: emptyDiff,
  },
} satisfies Story;

export const SingleFile = {
  args: {
    diff: singleFileDiff,
  },
} satisfies Story;

export const MultipleFiles = {
  args: {
    diff: multiFileDiff,
  },
} satisfies Story;

export const WithCommits = {
  args: {
    diff: multiFileDiff,
    commits: sampleCommits,
    projectName: "my-app",
    sessionName: "implement-auth",
  },
} satisfies Story;

export const CommitsOnly = {
  args: {
    diff: emptyDiff,
    commits: sampleCommits,
    projectName: "my-app",
    sessionName: "implement-auth",
  },
} satisfies Story;
