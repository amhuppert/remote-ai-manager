import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Topbar from "./Topbar";

const meta = {
  title: "Components/Topbar",
  component: Topbar,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectsPage = {
  args: {
    breadcrumbs: [],
    page: "projects",
    globalStatus: <span style={{ color: "var(--text-tertiary)" }}>3 projects</span>,
  },
} satisfies Story;

export const SessionsPage = {
  args: {
    breadcrumbs: [{ label: "my-app", href: "/projects/my-app" }],
    page: "sessions",
    globalStatus: (
      <span style={{ color: "var(--text-tertiary)" }}>2 active sessions</span>
    ),
  },
} satisfies Story;

export const DetailPage = {
  args: {
    breadcrumbs: [
      { label: "my-app", href: "/projects/my-app" },
      { label: "implement-auth", href: "/projects/my-app/implement-auth", isSession: true },
    ],
    page: "detail",
    sessionControls: (
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button className="btn btn-sm">Commit</button>
        <button className="btn btn-sm btn-primary">Merge</button>
      </div>
    ),
  },
} satisfies Story;

export const DeepBreadcrumbs = {
  args: {
    breadcrumbs: [
      { label: "remote-ai-manager", href: "/projects/remote-ai-manager" },
      {
        label: "refactor-state-machine",
        href: "/projects/remote-ai-manager/refactor-state-machine",
        isSession: true,
      },
    ],
    page: "detail",
  },
} satisfies Story;
