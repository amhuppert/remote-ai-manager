import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";
import SessionActionsMenu from "./SessionActionsMenu";

const meta = {
  title: "Session/SessionActionsMenu",
  component: SessionActionsMenu,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  decorators: [
    (Story) => (
      <div className="flex min-h-screen justify-end bg-bg-void p-lg">
        <div>
          <Story />
        </div>
      </div>
    ),
  ],
  args: {
    targetBranch: "main",
    activeLayout: "split",
    onLayoutChange: fn(),
    onToggleMerged: fn(),
    onDelete: fn(),
    compaction: { kind: "none" },
    checkpointChip: { kind: "none" },
    checkpointAction: { kind: "available" },
    onCompactConversation: fn(),
    onCopyReference: fn(),
    onCompactContextNow: fn(),
    onPrepareHandoff: fn(),
    onViewCheckpoint: fn(),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /actions/i }),
    );
  },
} satisfies Meta<typeof SessionActionsMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = { args: { onPush: fn(), onRebase: fn() } };
export const Unsupported: Story = {
  args: {
    checkpointAction: {
      kind: "unsupported",
      code: "backend_unsupported",
      reason:
        "This conversation’s agent backend declares no checkpoint capability. Generate a compaction artifact instead.",
    },
  },
};
export const StaleArtifact: Story = {
  args: {
    compaction: { kind: "stale", behind: 12 },
    onViewArtifact: fn(),
    onRefreshArtifact: fn(),
  },
};
export const Pending: Story = {
  args: {
    compaction: { kind: "pending" },
    checkpointAction: { kind: "loading" },
  },
};
