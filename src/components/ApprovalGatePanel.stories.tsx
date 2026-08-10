import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ApprovalGatePanel from "./ApprovalGatePanel";

const meta = {
  title: "Components/ApprovalGatePanel",
  component: ApprovalGatePanel,
  args: {
    contextTitle: "Implement auth flow",
    workflowName: "release-hardening",
    requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    isSubmitting: false,
    conversationBusy: false,
    executionSuspended: false,
    onApprove: fn(),
    onReject: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 700, background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalGatePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const WithoutTitles = {
  args: {
    contextTitle: null,
    workflowName: null,
  },
} satisfies Story;

export const ConversationBusy = {
  args: {
    conversationBusy: true,
  },
} satisfies Story;

export const Submitting = {
  args: {
    isSubmitting: true,
  },
} satisfies Story;

export const ExecutionSuspended = {
  args: {
    executionSuspended: true,
  },
} satisfies Story;

// An enveloped context reviews exactly the paths it owns: the change set its
// gate froze, not the shared lane worktree's whole-tree delta (R15.2).
export const ScopedChanges = {
  args: {
    scopedChanges: {
      status: "ready",
      ownedPaths: ["src/api", "docs/api.md"],
      diff: {
        files: [
          {
            filePath: "src/api/handler.ts",
            additions: 2,
            deletions: 1,
            hunks: [
              {
                header: "@@ -1,3 +1,4 @@",
                lines: [
                  { type: "hunk-header", content: "@@ -1,3 +1,4 @@" },
                  { type: "context", content: "import { db } from './db';" },
                  { type: "remove", content: "export const handler = 1;" },
                  { type: "add", content: "export const handler = 2;" },
                ],
              },
            ],
          },
        ],
        totalAdditions: 2,
        totalDeletions: 1,
      },
    },
  },
} satisfies Story;

export const ScopedChangesEmpty = {
  args: {
    scopedChanges: {
      status: "ready",
      ownedPaths: ["src/api"],
      diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
    },
  },
} satisfies Story;

export const ScopedChangesDrifted = {
  args: {
    scopedChanges: { status: "drifted" },
  },
} satisfies Story;

export const ScopedChangesUnavailable = {
  args: {
    scopedChanges: {
      status: "unavailable",
      reason: "the candidate tree could not be read",
    },
  },
} satisfies Story;
