import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { DevServerRuntimeState } from "@/types";
import DevServerDrawer from "./DevServerDrawer";

// ── Test data ──────────────────────────────────────────────────

const stoppedNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "stopped",
  pid: null,
  port: null,
  remoteUrl: null,
  startedAt: null,
  errorMessage: null,
  recentOutput: [],
  adopted: false,
};

const stoppedStorybook: DevServerRuntimeState = {
  serverName: "storybook",
  command: "bun run storybook",
  status: "stopped",
  pid: null,
  port: null,
  remoteUrl: null,
  startedAt: null,
  errorMessage: null,
  recentOutput: [],
  adopted: false,
};

const runningNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "running",
  pid: 12345,
  port: 3000,
  remoteUrl: "http://my-machine.tailnet.ts.net:3000",
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: [],
  adopted: false,
};

const runningStorybook: DevServerRuntimeState = {
  serverName: "storybook",
  command: "bun run storybook",
  status: "running",
  pid: 12346,
  port: 6006,
  remoteUrl: "http://my-machine.tailnet.ts.net:6006",
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: [],
  adopted: false,
};

const startingNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "starting",
  pid: 12345,
  port: null,
  remoteUrl: null,
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: ["Compiling...", "Optimizing modules..."],
  adopted: false,
};

const errorNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: "bun run dev",
  status: "error",
  pid: null,
  port: null,
  remoteUrl: null,
  startedAt: new Date().toISOString(),
  errorMessage:
    "Process exited (code=1) before reporting CC_PORT.\nError: Cannot find module 'next'",
  recentOutput: [],
  adopted: false,
};

const adoptedNextDev: DevServerRuntimeState = {
  serverName: "nextjs",
  command: ".csm/dev-servers/nextjs.sh",
  status: "running",
  pid: 54321,
  port: 3000,
  remoteUrl: "http://my-machine.tailnet.ts.net:3000",
  startedAt: new Date().toISOString(),
  errorMessage: null,
  recentOutput: [],
  adopted: true,
};

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
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: 500,
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          padding: 24,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DevServerDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories: Collapsed (trigger pill only) ─────────────────────

export const AllStopped = {
  args: {
    open: false,
    servers: [stoppedNextDev, stoppedStorybook],
  },
} satisfies Story;

export const OneRunning = {
  args: {
    open: false,
    servers: [runningNextDev, stoppedStorybook],
  },
} satisfies Story;

export const AllRunning = {
  args: {
    open: false,
    servers: [runningNextDev, runningStorybook],
  },
} satisfies Story;

export const Starting = {
  args: {
    open: false,
    servers: [startingNextDev, stoppedStorybook],
  },
} satisfies Story;

export const WithError = {
  args: {
    open: false,
    servers: [errorNextDev, stoppedStorybook],
  },
} satisfies Story;

// ── Stories: Expanded (panel open) ────────────────────────────

export const OpenAllStopped = {
  args: {
    open: true,
    servers: [stoppedNextDev, stoppedStorybook],
  },
} satisfies Story;

export const OpenOneRunning = {
  args: {
    open: true,
    servers: [runningNextDev, stoppedStorybook],
  },
} satisfies Story;

export const OpenAllRunning = {
  args: {
    open: true,
    servers: [runningNextDev, runningStorybook],
  },
} satisfies Story;

export const OpenStarting = {
  args: {
    open: true,
    servers: [startingNextDev, stoppedStorybook],
  },
} satisfies Story;

export const OpenWithError = {
  args: {
    open: true,
    servers: [errorNextDev, stoppedStorybook],
  },
} satisfies Story;

export const OpenAdopted = {
  args: {
    open: true,
    servers: [adoptedNextDev, stoppedStorybook],
  },
} satisfies Story;
