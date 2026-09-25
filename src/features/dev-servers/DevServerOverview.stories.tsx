import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import type {
  DevServerInstance,
  DevServerOverviewProject,
} from "@/lib/dev-server/schemas";

import {
  DevServerOverview,
  DevServerOverviewHeader,
} from "./DevServerOverview";

const NOW = Date.parse("2026-09-24T18:30:00.000Z");

function server(overrides: Partial<DevServerInstance>): DevServerInstance {
  return {
    owner: { kind: "project" },
    serverName: "web",
    status: "stopped",
    port: null,
    localUrl: null,
    remoteUrl: null,
    startedAt: null,
    errorMessage: null,
    worktreePath: "/Users/alex/github/storefront",
    ...overrides,
  };
}

function running(port: number, overrides: Partial<DevServerInstance>) {
  return server({
    status: "running",
    port,
    localUrl: `http://localhost:${port}`,
    remoteUrl: `https://studio.tailnet.ts.net:${port}`,
    startedAt: "2026-09-24T16:05:00.000Z",
    ...overrides,
  });
}

const projects: DevServerOverviewProject[] = [
  {
    projectName: "command-center",
    projectPath: "/Users/alex/github/command-center",
    configError: null,
    servers: [
      server({ serverName: "nextjs" }),
      server({ serverName: "storybook" }),
      running(3002, {
        owner: { kind: "session", sessionName: "global-dev-servers-view" },
        serverName: "nextjs",
        worktreePath:
          "/Users/alex/github/command-center/.worktrees/global-dev-servers-view-4e1968",
      }),
      running(3004, {
        owner: {
          kind: "workflow-lane",
          sessionName: "spec-delivery",
          worktreeName: "spec-delivery-9c1d2e.api-contracts",
        },
        serverName: "nextjs",
        worktreePath:
          "/Users/alex/github/command-center/.worktrees/spec-delivery-9c1d2e.api-contracts",
      }),
    ],
  },
  {
    projectName: "trellis",
    projectPath: "/Users/alex/github/trellis",
    configError: null,
    servers: [
      running(4321, {
        serverName: "astro",
        worktreePath: "/Users/alex/github/trellis",
      }),
      server({
        serverName: "storybook",
        status: "starting",
        startedAt: "2026-09-24T18:29:40.000Z",
        worktreePath: "/Users/alex/github/trellis",
      }),
    ],
  },
  {
    projectName: "active-recall",
    projectPath: "/Users/alex/github/active-recall",
    configError: null,
    servers: [
      server({
        serverName: "nextjs",
        status: "error",
        errorMessage:
          "Process exited (code=1, signal=null) before port 3000 ever listening.\nError: Cannot find module 'next'",
        worktreePath: "/Users/alex/github/active-recall",
      }),
      server({
        serverName: "expo",
        worktreePath: "/Users/alex/github/active-recall",
      }),
    ],
  },
  {
    projectName: "billing-service",
    projectPath: "/Users/alex/github/billing-service",
    configError:
      "CommandCenter.json is invalid.\n✖ Invalid input: expected object, received undefined\n  → at devServers[0].port",
    servers: [],
  },
  ...["book-ingest", "cli-for-agents", "creative-ai", "skill-sync"].map(
    (name) => ({
      projectName: name,
      projectPath: `/Users/alex/github/${name}`,
      configError: null,
      servers: [],
    }),
  ),
];

const meta = {
  title: "Features/DevServers/DevServerOverview",
  component: DevServerOverview,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => (
      <div className="flex min-h-screen flex-col gap-xl bg-bg-void p-xl max-768:p-md">
        <DevServerOverviewHeader projects={context.args.projects} />
        <Story />
      </div>
    ),
  ],
  args: {
    projects,
    pendingStopIds: new Set<string>(),
    notices: {},
    isStoppingUnmanaged: false,
    now: NOW,
    onStart: fn(),
    onStop: fn(),
    onDismissNotice: fn(),
    onStopUnmanagedAndRetry: fn(),
  },
} satisfies Meta<typeof DevServerOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {};

export const StopPending: Story = {
  args: {
    pendingStopIds: new Set([
      "command-center::global-dev-servers-view::/Users/alex/github/command-center/.worktrees/global-dev-servers-view-4e1968::nextjs",
    ]),
  },
};

export const UnmanagedListener: Story = {
  args: {
    notices: {
      "command-center": {
        kind: "conflict",
        serverName: "nextjs",
        port: 3001,
        pid: 48213,
        cwd: "/Users/alex/github/command-center",
      },
    },
  },
};

export const StartFailed: Story = {
  args: {
    notices: {
      trellis: {
        kind: "error",
        title: "Could not start storybook",
        message: "Port selection exhausted starting at 6006 (range 100).",
      },
    },
  },
};
