"use client";

import { useMemo } from "react";

import { useSessionMcpConfigQuery } from "@/lib/queries";

import McpServersModal from "./McpServersModal";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";

interface SessionMcpModalProps {
  projectName: string;
  sessionName: string;
  open: boolean;
  onClose(): void;
}

export default function SessionMcpModal({
  projectName,
  sessionName,
  open,
  onClose,
}: SessionMcpModalProps): React.JSX.Element | null {
  const query = useSessionMcpConfigQuery(projectName, sessionName, {
    enabled: open,
  });

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "session");
  }, [query.data]);

  const actions = useMcpActions(
    { level: "session", projectName, sessionName },
    servers,
  );

  return (
    <McpServersModal
      open={open}
      onClose={onClose}
      viewLevel="session"
      servers={servers}
      actions={actions}
      title="Session MCP configuration"
      subtitle={`${projectName} / ${sessionName}`}
      banner={
        <span>
          Session-level overrides apply to every conversation in this session.
          Changes made while a turn is running apply on the next turn.
        </span>
      }
    />
  );
}
