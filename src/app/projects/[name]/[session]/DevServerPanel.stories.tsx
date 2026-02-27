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
  const hasStoppable = servers.some(
    (s) => (s.status === "running" || s.status === "starting") && !s.adopted,
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
          {hasStoppable && (
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
          const nameElement =
            server.remoteUrl && server.status === "running" ? (
              <a
                href={server.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="dev-server-name dev-server-name-link"
              >
                {server.serverName}
              </a>
            ) : (
              <span className="dev-server-name">{server.serverName}</span>
            );
          return (
            <div className="dev-server-row" key={server.serverName}>
              <div className="dev-server-info">
                <StatusDot status={server.status} />
                {nameElement}
                <span className="dev-server-status">{server.status}</span>
                {server.port != null && (
                  <span className="dev-server-port">:{server.port}</span>
                )}
                {server.adopted && (
                  <span className="dev-server-adopted-badge">adopted</span>
                )}
              </div>
              <div className="dev-server-actions">
                {isActive && !server.adopted ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => onStop(server.serverName)}
                    type="button"
                  >
                    Stop
                  </button>
                ) : !isActive ? (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onStart(server.serverName)}
                    type="button"
                  >
                    Start
                  </button>
                ) : null}
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
        adopted: false,
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
        adopted: false,
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
        remoteUrl: "http://my-machine.tailnet.ts.net:3000",
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: [],
        adopted: false,
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
        adopted: false,
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
        remoteUrl: "http://my-machine.tailnet.ts.net:3000",
        startedAt: new Date().toISOString(),
        errorMessage: null,
        recentOutput: [],
        adopted: false,
      },
      {
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
        adopted: false,
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
        adopted: false,
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
        adopted: false,
      },
    ],
  },
} satisfies Story;

/** Adopted server: running externally, CSM monitors but cannot stop it */
export const AdoptedServer = {
  args: {
    servers: [
      {
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
      },
      {
        serverName: "storybook",
        command: ".csm/dev-servers/storybook.sh",
        status: "stopped",
        pid: null,
        port: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        recentOutput: [],
        adopted: false,
      },
    ],
  },
} satisfies Story;
