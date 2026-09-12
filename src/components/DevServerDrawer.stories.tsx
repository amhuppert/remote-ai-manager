import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import DevServerDrawer, { DevServerPanel } from "./DevServerDrawer";

// ── Test data ──────────────────────────────────────────────────

const stoppedNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "stopped",
  port: null,
  remoteUrl: null,
  startedAt: null,
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: false,
  worktreePath: null,
  ownerPid: null,
  logFilePath: null,
};

const stoppedStorybook: DevServerRuntimeState = {
  serverName: "storybook",
  command: "bun run storybook",
  status: "stopped",
  port: null,
  remoteUrl: null,
  startedAt: null,
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: false,
  worktreePath: null,
  ownerPid: null,
  logFilePath: null,
};

const runningNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "running",
  port: 3000,
  remoteUrl: "http://my-machine.tailnet.ts.net:3000",
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: true,
  worktreePath: "/home/alex/projects/app/.worktrees/feature",
  ownerPid: 12345,
  logFilePath:
    "/home/alex/projects/app/.worktrees/feature/.cc/dev-server-logs/nextjs.log",
};

const runningStorybook: DevServerRuntimeState = {
  serverName: "storybook",
  command: "bun run storybook",
  status: "running",
  port: 6006,
  remoteUrl: "http://my-machine.tailnet.ts.net:6006",
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: true,
  worktreePath: "/home/alex/projects/app/.worktrees/feature",
  ownerPid: 12346,
  logFilePath:
    "/home/alex/projects/app/.worktrees/feature/.cc/dev-server-logs/storybook.log",
};

const startingNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "starting",
  port: null,
  remoteUrl: null,
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: ["Compiling...", "Optimizing modules..."],
  ownedByThisSession: false,
  worktreePath: "/home/alex/projects/app/.worktrees/feature",
  ownerPid: null,
  logFilePath:
    "/home/alex/projects/app/.worktrees/feature/.cc/dev-server-logs/nextjs.log",
};

const errorNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "error",
  port: null,
  remoteUrl: null,
  startedAt: new Date().toISOString(),
  errorMessage:
    "Process exited (code=1) before reporting CC_PORT.\nError: Cannot find module 'next'",
  recentOutput: [],
  ownedByThisSession: false,
  worktreePath: "/home/alex/projects/app/.worktrees/feature",
  ownerPid: null,
  logFilePath:
    "/home/alex/projects/app/.worktrees/feature/.cc/dev-server-logs/nextjs.log",
};

// ── Toolbar decorator (simulates topbar session controls) ────

/**
 * Simulates the topbar session controls area where the
 * trigger button lives in production. The panel opens
 * downward via portal so it renders outside this wrapper.
 */
function ToolbarDecorator(Story: React.ComponentType) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 16px",
        background: "var(--bg-surface, #111825)",
        borderBottom: "1px solid var(--border-subtle, #1a2338)",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "0.72rem",
        color: "var(--text-secondary, #7b899f)",
        minHeight: 56,
      }}
    >
      <span style={{ fontWeight: 800, color: "var(--cyan, #00e5ff)" }}>CC</span>
      <span style={{ opacity: 0.3 }}>|</span>
      <span>projects / my-app / feature-branch</span>
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--cyan, #00e5ff)",
            }}
          />
          running
        </span>
        <span
          style={{
            width: 1,
            height: 16,
            background: "var(--border-subtle, #1a2338)",
          }}
        />
        <Story />
      </div>
    </div>
  );
}

/**
 * Simulates the mobile bottom bar where the trigger
 * will live on small screens.
 */
function MobileBarDecorator(Story: React.ComponentType) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "8px 16px 20px",
        background: "rgba(11, 16, 25, 0.92)",
        backdropFilter: "blur(16px)",
        borderTop: "1px solid var(--border-subtle, #1a2338)",
        maxWidth: 420,
      }}
    >
      {/* Panel tabs row */}
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: 3,
          background: "var(--bg-surface, #111825)",
          border: "1px solid var(--border-subtle, #1a2338)",
          borderRadius: 6,
        }}
      >
        {["CHAT", "DIFF", "FOCUS", "SPECS"].map((tab) => (
          <span
            key={tab}
            style={{
              flex: 1,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.72rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              color:
                tab === "CHAT"
                  ? "var(--text-inverse, #06090f)"
                  : "var(--text-tertiary, #4d5a72)",
              background:
                tab === "CHAT" ? "var(--cyan, #00e5ff)" : "transparent",
            }}
          >
            {tab}
          </span>
        ))}
      </div>
      {/* Actions row */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <Story />
        <div
          style={{
            width: 1,
            height: 20,
            background: "var(--border-subtle, #1a2338)",
          }}
        />
        <button className="btn btn-sm" style={{ opacity: 0.5 }}>
          Commit
        </button>
        <button className="btn btn-sm btn-primary" style={{ opacity: 0.5 }}>
          Merge
        </button>
      </div>
    </div>
  );
}

// ── Meta ───────────────────────────────────────────────────────

const meta = {
  title: "Components/DevServerDrawer",
  component: DevServerDrawer,
  args: {
    onClose: fn(),
    onToggle: fn(),
    onStart: fn(),
    onStop: fn(),
    onStartAll: fn(),
    onStopAll: fn(),
  },
} satisfies Meta<typeof DevServerDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionDialog: Story = {
  args: { open: true, servers: [runningNextDev, stoppedStorybook] },
  render: (args) => (
    <DevServerPanel
      {...args}
      presentation="dialog"
      anchorRef={{ current: null }}
    />
  ),
};

// ── Stories: Trigger states (in topbar context) ────────────────

export const AllStopped = {
  args: {
    open: false,
    servers: [stoppedNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OneRunning = {
  args: {
    open: false,
    servers: [runningNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const AllRunning = {
  args: {
    open: false,
    servers: [runningNextDev, runningStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const Starting = {
  args: {
    open: false,
    servers: [startingNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const WithError = {
  args: {
    open: false,
    servers: [errorNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

// ── Stories: Panel open (in topbar context) ─────────────────

export const OpenAllStopped = {
  args: {
    open: true,
    servers: [stoppedNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OpenOneRunning = {
  args: {
    open: true,
    servers: [runningNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OpenAllRunning = {
  args: {
    open: true,
    servers: [runningNextDev, runningStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OpenStarting = {
  args: {
    open: true,
    servers: [startingNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OpenWithError = {
  args: {
    open: true,
    servers: [errorNextDev, stoppedStorybook],
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

export const OpenWithUnmanagedConflict = {
  args: {
    open: true,
    servers: [stoppedNextDev, stoppedStorybook],
    unmanagedConflict: {
      serverName: "nextjs",
      port: 3007,
      pid: 5001,
      cwd: "/home/alex/projects/app/.worktrees/feature",
    },
    isStoppingUnmanaged: false,
  },
  decorators: [ToolbarDecorator],
} satisfies Story;

// ── Stories: Mobile bottom bar context ─────────────────────

export const MobileAllStopped = {
  args: {
    open: false,
    servers: [stoppedNextDev, stoppedStorybook],
  },
  decorators: [MobileBarDecorator],
} satisfies Story;

export const MobileOneRunning = {
  args: {
    open: false,
    servers: [runningNextDev, stoppedStorybook],
  },
  decorators: [MobileBarDecorator],
} satisfies Story;

export const MobileWithError = {
  args: {
    open: false,
    servers: [errorNextDev, stoppedStorybook],
  },
  decorators: [MobileBarDecorator],
} satisfies Story;
