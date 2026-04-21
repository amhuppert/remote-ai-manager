"use client";

import { useMemo } from "react";

import { useSessionMcpConfigQuery } from "@/lib/queries";

import McpInfoChip from "./McpInfoChip";
import { adaptServerViewsForLevel } from "./view-adapter";

interface SessionMcpChipProps {
  projectName: string;
  sessionName: string;
  onClick(): void;
}

/**
 * Small pill summarising MCP state at the session level. Clicking delegates
 * to the parent so modal state can be shared with the info-details popover.
 */
export default function SessionMcpChip({
  projectName,
  sessionName,
  onClick,
}: SessionMcpChipProps): React.JSX.Element {
  const query = useSessionMcpConfigQuery(projectName, sessionName);

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "session");
  }, [query.data]);

  return <McpInfoChip servers={servers} onClick={onClick} compact />;
}
