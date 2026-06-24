import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import ProjectCard from "./ProjectCard";

const baseProject = {
  name: "my-app",
  path: "/home/user/projects/my-app",
  activeSessions: 2,
  hasRunningSession: false,
} satisfies DiscoveredProject;

const meta = {
  title: "Projects/ProjectCard",
  component: ProjectCard,
  args: {
    menuOpen: false,
    onMenuOpenChange: fn(),
    onArchive: fn(),
    onPin: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProjectCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle = {
  args: {
    project: { ...baseProject, activeSessions: 0, hasRunningSession: false },
    archived: false,
    pinned: false,
  },
} satisfies Story;

export const WithSessions = {
  args: {
    project: baseProject,
    archived: false,
    pinned: false,
  },
} satisfies Story;

export const Active = {
  args: {
    project: { ...baseProject, hasRunningSession: true },
    archived: false,
    pinned: false,
  },
} satisfies Story;

export const Pinned = {
  args: {
    project: baseProject,
    archived: false,
    pinned: true,
  },
} satisfies Story;

export const PinnedActive = {
  args: {
    project: { ...baseProject, hasRunningSession: true },
    archived: false,
    pinned: true,
  },
} satisfies Story;

export const Archived = {
  args: {
    project: baseProject,
    archived: true,
    pinned: false,
  },
} satisfies Story;

export const MenuOpen = {
  args: {
    project: baseProject,
    archived: false,
    pinned: false,
    menuOpen: true,
  },
} satisfies Story;

export const Missing = {
  args: {
    project: { ...baseProject, missing: true, activeSessions: 1 },
    archived: false,
    pinned: false,
  },
} satisfies Story;
