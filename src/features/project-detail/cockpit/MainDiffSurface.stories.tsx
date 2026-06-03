import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MainDiffSurface from "./MainDiffSurface";
import { gitKeys } from "@/lib/git/query-keys";
import type { SessionDiff } from "@/lib/git/schemas";
import { withSeededQueryClient } from "./story-support";

const PROJECT = "command-center";

const diffWithChanges: SessionDiff = {
  files: [
    {
      filePath: "src/lib/auth.ts",
      additions: 4,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,3 +1,6 @@",
          lines: [
            { type: "context", content: "export function login() {" },
            { type: "add", content: "  validateSession();" },
            { type: "remove", content: "  // TODO validate" },
            { type: "context", content: "}" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 4,
  totalDeletions: 1,
};

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: 480, width: 640, display: "flex" }}>{children}</div>
  );
}

const meta: Meta<typeof MainDiffSurface> = {
  title: "Project Cockpit/MainDiffSurface",
  component: MainDiffSurface,
  decorators: [(Story) => <Frame>{<Story />}</Frame>],
};
export default meta;

type Story = StoryObj<typeof MainDiffSurface>;

export const WithChanges: Story = {
  decorators: [
    withSeededQueryClient([[gitKeys.mainDiff(PROJECT), diffWithChanges]]),
  ],
  args: { projectName: PROJECT },
};

export const NoChanges: Story = {
  decorators: [withSeededQueryClient([[gitKeys.mainDiff(PROJECT), emptyDiff]])],
  args: { projectName: PROJECT },
};

/** Upstream diff endpoint absent (hook resolves null) → no-changes state. */
export const EndpointUnavailable: Story = {
  decorators: [withSeededQueryClient([[gitKeys.mainDiff(PROJECT), null]])],
  args: { projectName: PROJECT },
};
