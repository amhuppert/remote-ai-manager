import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ProjectActionsBar from "./ProjectActionsBar";

const meta = {
  title: "Projects/ProjectActionsBar",
  component: ProjectActionsBar,
  args: {
    projectName: "remote-ai-manager",
    archivedCount: 11,
    showArchived: false,
    onToggleArchived: fn(),
    onInstallPreset: fn(),
    onQuickTask: fn(),
    onNewSession: fn(),
  },
} satisfies Meta<typeof ProjectActionsBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const ArchivedActive = {
  args: {
    showArchived: true,
  },
} satisfies Story;

export const NoArchivedSessions = {
  args: {
    archivedCount: 0,
  },
} satisfies Story;

export const Mobile = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;

export const MobileNoArchived = {
  args: {
    archivedCount: 0,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
