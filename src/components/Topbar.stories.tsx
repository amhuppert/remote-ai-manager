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

const mobileViewport = {
  viewport: { width: 375, height: 667 },
};

export const ProjectsPage = {
  args: {
    breadcrumbs: [],
    page: "projects",
    globalStatus: (
      <span style={{ color: "var(--text-tertiary)" }}>3 projects</span>
    ),
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
      { label: "projects", href: "/projects" },
      { label: "my-app", href: "/projects/my-app" },
      {
        label: "implement-auth",
        href: "/projects/my-app/implement-auth",
        isSession: true,
      },
    ],
    page: "detail",
    sessionControls: (
      <>
        <div className="status-indicator">
          <div className="status-dot cyan" />
          running
        </div>
        <div className="topbar-sep" />
        <button className="btn btn-sm">Commit</button>
        <button className="btn btn-sm btn-primary">Merge</button>
      </>
    ),
  },
} satisfies Story;

export const DeepBreadcrumbs = {
  args: {
    breadcrumbs: [
      { label: "projects", href: "/projects" },
      { label: "remote-ai-manager", href: "/projects/remote-ai-manager" },
      {
        label: "refactor-state-machine",
        href: "/projects/remote-ai-manager/refactor-state-machine",
        isSession: true,
      },
    ],
    page: "detail",
    sessionControls: (
      <>
        <div className="status-indicator">
          <div className="status-dot cyan" />
          running
        </div>
      </>
    ),
  },
} satisfies Story;

/** Mobile: Session detail with status dot and long session name */
export const MobileDetail = {
  args: {
    breadcrumbs: [
      { label: "projects", href: "/projects" },
      { label: "remote-ai-manager", href: "/projects/remote-ai-manager" },
      {
        label: "Fix focus mode",
        href: "/projects/remote-ai-manager/fix-focus-mode",
        isSession: true,
      },
    ],
    page: "detail",
    sessionControls: (
      <>
        <div className="status-indicator">
          <div className="status-dot cyan" />
          running
        </div>
      </>
    ),
  },
  parameters: mobileViewport,
} satisfies Story;

/** Mobile: Long session name that should truncate */
export const MobileDetailLongName = {
  args: {
    breadcrumbs: [
      { label: "projects", href: "/projects" },
      { label: "remote-ai-manager", href: "/projects/remote-ai-manager" },
      {
        label: "implement-comprehensive-authentication-flow",
        href: "/projects/remote-ai-manager/implement-comprehensive-authentication-flow",
        isSession: true,
      },
    ],
    page: "detail",
    sessionControls: (
      <>
        <div className="status-indicator">
          <div className="status-dot" />
          idle
        </div>
      </>
    ),
  },
  parameters: mobileViewport,
} satisfies Story;

/** Mobile: Sessions page with back arrow */
export const MobileSessions = {
  args: {
    breadcrumbs: [
      { label: "remote-ai-manager", href: "/projects/remote-ai-manager" },
    ],
    page: "sessions",
    globalStatus: (
      <span style={{ color: "var(--text-tertiary)" }}>2 active</span>
    ),
  },
  parameters: mobileViewport,
} satisfies Story;

/** Mobile: Projects page (no breadcrumbs, no back arrow) */
export const MobileProjects = {
  args: {
    breadcrumbs: [],
    page: "projects",
    globalStatus: (
      <span style={{ color: "var(--text-tertiary)" }}>3 projects</span>
    ),
  },
  parameters: mobileViewport,
} satisfies Story;
