"use client";

import { useMemo, useState } from "react";

import { useConversationMcpConfigQuery } from "@/lib/queries";
import type { AgentBackendId } from "@/types";

import McpConfigButton from "./McpConfigButton";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";
import type { McpBackendId } from "./types";

interface ConversationMcpConfigProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  /** Currently selected backend — drives per-server compatibility hints. */
  activeBackend: AgentBackendId;
  /**
   * Whether the conversation is currently mid-turn. When true, any override
   * toggled through the popover is persisted but the popover surfaces a
   * "pending — applies on next turn" indicator.
   */
  turnRunning: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
}

export default function ConversationMcpConfig({
  projectName,
  sessionName,
  conversationId,
  activeBackend,
  turnRunning,
  disabled,
  disabledTooltip,
}: ConversationMcpConfigProps): React.JSX.Element {
  const [backendFilter, setBackendFilter] = useState<McpBackendId | "all">(
    "all",
  );

  const query = useConversationMcpConfigQuery(
    projectName,
    sessionName,
    conversationId,
  );

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "conversation", {
      activeBackend,
    });
  }, [query.data, activeBackend]);

  const actions = useMcpActions(
    {
      level: "conversation",
      projectName,
      sessionName,
      conversationId,
    },
    servers,
  );

  const pendingServerIds = useMemo(() => {
    if (!query.data) return [];
    return [...query.data.pendingServerKeys];
  }, [query.data]);

  const hasPending =
    (turnRunning && servers.some((s) => s.pending)) ||
    pendingServerIds.length > 0;

  return (
    <McpConfigButton
      servers={servers}
      actions={actions}
      backendFilter={backendFilter}
      onBackendFilterChange={setBackendFilter}
      hasPending={hasPending}
      pendingServerIds={pendingServerIds}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
    />
  );
}
