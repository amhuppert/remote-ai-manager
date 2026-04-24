"use client";

import { useMemo } from "react";

import { useConversationMcpConfigQuery } from "@/lib/queries";

import McpConfigButton from "./McpConfigButton";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";

interface ConversationMcpConfigProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
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
  turnRunning,
  disabled,
  disabledTooltip,
}: ConversationMcpConfigProps): React.JSX.Element {
  const query = useConversationMcpConfigQuery(
    projectName,
    sessionName,
    conversationId,
  );

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "conversation");
  }, [query.data]);

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
      hasPending={hasPending}
      pendingServerIds={pendingServerIds}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
    />
  );
}
