import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { DevServerRuntimeState } from "@/types";

// Inline presentational component for Storybook (avoids hook dependencies)
function StatusDot({ status }: { status: DevServerRuntimeState["status"] }) {
  const colorMap = {
    stopped: "var(--text-tertiary)",
    starting: "var(--amber)",
    running: "var(--green)",
    error: "var(--red)",
  };
  const glowMap: Record<string, string | undefined> = {
    starting: "var(--amber-glow)",
    running: "var(--green-glow)",
    error: "var(--red-glow)",
  };
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        display: "inline-block",
        background: colorMap[status],
        boxShadow: glowMap[status] ? `0 0 6px ${glowMap[status]}` : undefined,
        animation:
          status === "starting"
            ? "pulse-dot 1.5s ease-in-out infinite"
            : undefined,
      }}
    />
  );
}

function DevServerPanelStory({
  servers,
  onStart = fn(),
  onStop = fn(),
  onStartAll = fn(),
  onStopAll = fn(),
}: {
  servers: DevServerRuntimeState[];
  onStart?: (name: string) => void;
  onStop?: (name: string) => void;
  onStartAll?: () => void;
  onStopAll?: () => void;
}) {
  const hasRunning = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStopped = servers.some(
    (s) => s.status === "stopped" || s.status === "error",
  );

  if (servers.length === 0) return null;

  return (
    <div className="dev-server-panel">
      <div className="dev-server-panel-header">
        <span className="dev-server-panel-title">Dev Servers</span>
        <div className="dev-server-panel-actions">
          {hasStopped && (
            <button
              className="btn btn-sm btn-primary"
              onClick={onStartAll}
              type="button"
            >
              Start All
            </button>
          )}
          {hasRunning && (
            <button className="btn btn-sm" onClick={onStopAll} type="button">
              Stop All
            </button>
          )}
        </div>
      </div>
      <div className="dev-server-list">
        {servers.map((server) => {
          const isActive =
            server.status === "running" || server.status === "starting";
          return (
            <div className="dev-server-row" key={server.serverName}>
              <div className="dev-server-info">
                <StatusDot status={server.status} />
                <span className="dev-server-name">{server.serverName}</span>
                <span className="dev-server-status">{server.status}</span>
                {server.remoteUrl && server.status === "running" && (
                  <a
                    href={server.remoteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dev-server-url"
                  >
                    {server.remoteUrl}
                  </a>
                )}
              </div>
              <div className="dev-server-actions">
                {isActive ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => onStop(server.serverName)}
                    type="button"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onStart(server.serverName)}
                    type="button"
                  >
                    Start
                  </button>
                )}
              </div>
              {server.status === "error" && server.errorMessage && (
                <div className="dev-server-error">
                  <pre className="dev-server-error-output">
                    {server.errorMessage.slice(0, 500)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const meta = {
  title: "Session/DevServerPanel",
  component: DevServerPanelStory,
  args: {
    onStart: fn(),
    onStop: fn(),
    onStartAll: fn(),
    onStopAll: fn(),
  },
} satisfies Meta<typeof DevServerPanelStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStopped = {
  args: {
    servers: [
      {
        serverName: "next-dev",
        command: "bun run dev",
        status: "stopped",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        recentOutput: [],
      },
      {
        serverName: "storybook",
        command: "bun run storybook",
        status: "stopped",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        recentOutput: [],
      },
    ],
  },
} satisfies Story;

export const OneRunning = {
  args: {
    servers: [
      {
        serverName: "next-dev",
        command: "bun run dev",
        status: "running",
        pid: 12345,
        port: 3000,
        remoteUrl: "https://my-machine.tailnet.ts.net:3000",
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: [],
      },
      {
        serverName: "storybook",
        command: "bun run storybook",
        status: "stopped",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        recentOutput: [],
      },
    ],
  },
} satisfies Story;

export const AllRunning = {
  args: {
    servers: [
      {
        serverName: "next-dev",
        command: "bun run dev",
        status: "running",
        pid: 12345,
        port: 3000,
        remoteUrl: "https://my-machine.tailnet.ts.net:3000",
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: [],
      },
      {
        serverName: "storybook",
        command: "bun run storybook",
        status: "running",
        pid: 12346,
        port: 6006,
        remoteUrl: "https://my-machine.tailnet.ts.net:6006",
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: [],
      },
    ],
  },
} satisfies Story;

export const Starting = {
  args: {
    servers: [
      {
        serverName: "next-dev",
        command: "bun run dev",
        status: "starting",
        pid: 12345,
        port: null,
        remoteUrl: null,
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: ["Compiling...", "Optimizing modules..."],
      },
    ],
  },
} satisfies Story;

export const WithError = {
  args: {
    servers: [
      {
        serverName: "next-dev",
        command: "bun run dev",
        status: "error",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: new Date().toISOString(),
        errorMessage:
          "Process exited (code=1) before reporting CSM_PORT.\nError: Cannot find module 'next'",
        recentOutput: [],
      },
      {
        serverName: "storybook",
        command: "bun run storybook",
        status: "stopped",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        recentOutput: [],
      },
    ],
  },
} satisfies Story;
