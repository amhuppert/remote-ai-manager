"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentCapabilityCascadeKind } from "@/lib/schemas";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

import { AgentCapabilityPanelContainer } from "./AgentCapabilityPanelContainer";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

interface ConversationAgentCapabilitiesConfigProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  disabled?: boolean;
  disabledTooltip?: string;
}

const CASCADE_KINDS: readonly AgentCapabilityCascadeKind[] = [
  "claude-skills",
  "claude-plugins",
  "claude-agents",
  "codex-skills",
  "codex-plugins",
];

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
        projectName={projectName}
        sessionName={sessionName}
        layerOptions={layerOptions}
        initialScope={initialScope}
      />
    </>
  );
}

function AgentCapabilitiesModal({
  open,
  onClose,
  projectName,
  sessionName,
  layerOptions,
  initialScope,
}: {
  open: boolean;
  onClose(): void;
  projectName: string;
  sessionName: string;
  layerOptions: readonly AgentCapabilityLayerOption[];
  initialScope: AgentCapabilityScope;
}): React.JSX.Element | null {
  if (!open || typeof document === "undefined") return null;

  const overlay = (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal mcp-servers-modal agent-capability-modal"
        role="dialog"
        aria-label="Agent capabilities configuration"
      >
        <header className="mcp-servers-modal__head">
          <div className="mcp-servers-modal__headings">
            <span className="mcp-servers-modal__eyebrow">CONVERSATION</span>
            <h2 className="mcp-servers-modal__title">Agent capabilities</h2>
            <span className="mcp-servers-modal__subtitle">
              {projectName} / {sessionName}
            </span>
          </div>
          <button
            type="button"
            className="mcp-servers-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </header>

        <div className="mcp-servers-modal__body agent-capability-modal__body">
          {CASCADE_KINDS.map((cascadeKind) => (
            <AgentCapabilityPanelContainer
              key={cascadeKind}
              cascadeKind={cascadeKind}
              layerOptions={layerOptions}
              initialScope={initialScope}
            />
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
