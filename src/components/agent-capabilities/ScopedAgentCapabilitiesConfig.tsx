"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useOverlayScope } from "@/hooks/useOverlayScope";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

type ScopedCapabilityLevel = "project" | "session" | "conversation";

interface ScopedAgentCapabilitiesConfigProps {
  level: ScopedCapabilityLevel;
  projectName: string;
  sessionName?: string;
  conversationId?: string;
  disabled?: boolean;
  disabledTooltip?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  renderTrigger?: boolean;
}

export default function ScopedAgentCapabilitiesConfig({
  level,
  projectName,
  sessionName,
  conversationId,
  disabled,
  disabledTooltip,
  className,
  open: controlledOpen,
  onOpenChange,
  renderTrigger = true,
}: ScopedAgentCapabilitiesConfigProps): React.JSX.Element {
  const controlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const initialScope = useMemo<AgentCapabilityScope>(
    () =>
      buildInitialScope({
        level,
        projectName,
        sessionName,
        conversationId,
      }),
    [conversationId, level, projectName, sessionName],
  );
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () =>
      buildLayerOptions({
        level,
        projectName,
        sessionName,
        conversationId,
      }),
    [conversationId, level, projectName, sessionName],
  );

  const title = disabled
    ? (disabledTooltip ?? "Agent capability configuration unavailable")
    : "Agent capability configuration";

  return (
    <>
      {renderTrigger && (
        <button
          type="button"
          className={className ?? "mcp-config-trigger agent-capability-trigger"}
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-label={title}
          aria-expanded={open}
          title={title}
        >
          <span className="mcp-config-trigger__label">Capabilities</span>
        </button>
      )}
      <ScopedAgentCapabilitiesDrawer
        open={open}
        onClose={close}
        layerOptions={layerOptions}
        initialScope={initialScope}
      />
    </>
  );
}

function ScopedAgentCapabilitiesDrawer({
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

  return createPortal(
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
    </>,
    document.body,
  );
}

function buildInitialScope({
  level,
  projectName,
  sessionName,
  conversationId,
}: {
  level: ScopedCapabilityLevel;
  projectName: string;
  sessionName?: string;
  conversationId?: string;
}): AgentCapabilityScope {
  if (level === "project") return { level: "project", projectName };
  if (level === "session") {
    if (!sessionName) throw new Error("sessionName is required");
    return { level: "session", projectName, sessionName };
  }
  if (!sessionName || !conversationId) {
    throw new Error("sessionName and conversationId are required");
  }
  return {
    level: "conversation",
    projectName,
    sessionName,
    conversationId,
  };
}

function buildLayerOptions({
  level,
  projectName,
  sessionName,
  conversationId,
}: {
  level: ScopedCapabilityLevel;
  projectName: string;
  sessionName?: string;
  conversationId?: string;
}): readonly AgentCapabilityLayerOption[] {
  const options: AgentCapabilityLayerOption[] = [
    { label: "Global", scope: { level: "global" } },
    { label: "Project", scope: { level: "project", projectName } },
  ];

  if (level === "project") return options;
  if (!sessionName) throw new Error("sessionName is required");

  options.push({
    label: "Session",
    scope: { level: "session", projectName, sessionName },
  });

  if (level === "session") return options;
  if (!conversationId) throw new Error("conversationId is required");

  options.push({
    label: "Conversation",
    scope: { level: "conversation", projectName, sessionName, conversationId },
  });
  return options;
}
