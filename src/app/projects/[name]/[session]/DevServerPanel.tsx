"use client";

import { useDevServers } from "@/hooks/use-dev-servers";
import type { DevServerRuntimeState } from "@/types";

interface Props {
  projectName: string;
  sessionName: string;
}

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
      className="dev-server-dot"
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

function ServerRow({
  server,
  onStart,
  onStop,
}: {
  server: DevServerRuntimeState;
  onStart: () => void;
  onStop: () => void;
}) {
  const isActive = server.status === "running" || server.status === "starting";

  return (
    <div className="dev-server-row">
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
            onClick={(e) => e.stopPropagation()}
          >
            {server.remoteUrl}
          </a>
        )}
      </div>
      <div className="dev-server-actions">
        {isActive ? (
          <button className="btn btn-sm" onClick={onStop} type="button">
            Stop
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            onClick={onStart}
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
}

export default function DevServerPanel({
  projectName,
  sessionName,
}: Props): React.JSX.Element | null {
  const {
    servers,
    isLoading,
    hasRunning,
    hasStopped,
    startServer,
    stopServer,
    startAll,
    stopAll,
  } = useDevServers(projectName, sessionName);

  // Hide panel when no servers configured or still loading
  if (isLoading || servers.length === 0) return null;

  return (
    <div className="dev-server-panel">
      <div className="dev-server-panel-header">
        <span className="dev-server-panel-title">Dev Servers</span>
        <div className="dev-server-panel-actions">
          {hasStopped && (
            <button
              className="btn btn-sm btn-primary"
              onClick={startAll}
              type="button"
            >
              Start All
            </button>
          )}
          {hasRunning && (
            <button className="btn btn-sm" onClick={stopAll} type="button">
              Stop All
            </button>
          )}
        </div>
      </div>
      <div className="dev-server-list">
        {servers.map((server) => (
          <ServerRow
            key={server.serverName}
            server={server}
            onStart={() => startServer(server.serverName)}
            onStop={() => stopServer(server.serverName)}
          />
        ))}
      </div>
    </div>
  );
}
