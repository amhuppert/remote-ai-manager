"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useOverlayScope } from "@/hooks/useOverlayScope";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

interface ConversationAgentCapabilitiesConfigProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  disabled?: boolean;
  disabledTooltip?: string;
}

export default function ConversationAgentCapabilitiesConfig({
  projectName,
  sessionName,
  conversationId,
  disabled,
  disabledTooltip,
}: ConversationAgentCapabilitiesConfigProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const initialScope = useMemo<AgentCapabilityScope>(
    () => ({
      level: "conversation",
      projectName,
      sessionName,
      conversationId,
    }),
    [conversationId, projectName, sessionName],
  );
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () => [
      { label: "Global", scope: { level: "global" } },
      { label: "Project", scope: { level: "project", projectName } },
      {
        label: "Session",
        scope: { level: "session", projectName, sessionName },
      },
      { label: "Conversation", scope: initialScope },
    ],
    [initialScope, projectName, sessionName],
  );

  const title = disabled
    ? (disabledTooltip ?? "Agent capability configuration unavailable")
    : "Agent capability configuration";

  return (
    <>
      <button
        type="button"
        className="mcp-config-trigger agent-capability-trigger"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={title}
        aria-expanded={open}
        title={title}
      >
        <span className="mcp-config-trigger__label">Capabilities</span>
      </button>
      <AgentCapabilitiesModal
        open={open}
        onClose={close}
        layerOptions={layerOptions}
        initialScope={initialScope}
      />
    </>
  );
}

function AgentCapabilitiesModal({
  open,
  onClose,
  layerOptions,
  initialScope,
}: {
  open: boolean;
  onClose(): void;
  layerOptions: readonly AgentCapabilityLayerOption[];
  initialScope: AgentCapabilityScope;
}): React.JSX.Element | null {
  useOverlayScope(open, { onEscape: onClose });

  if (!open || typeof document === "undefined") return null;

  const overlay = (
    <>
      <div
        className="agent-capabilities-drawer-overlay"
        data-testid="agent-capabilities-drawer-overlay"
        onClick={onClose}
      />
      <aside
        className="agent-capabilities-drawer"
        role="dialog"
        aria-label="Agent capabilities configuration"
      >
        <AgentCapabilitiesConfigurator
          layerOptions={layerOptions}
          initialScope={initialScope}
          drawer
          onClose={onClose}
        />
      </aside>
    </>
  );

  return createPortal(overlay, document.body);
}
