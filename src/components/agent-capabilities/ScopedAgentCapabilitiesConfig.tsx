"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useOverlayScope } from "@/hooks/useOverlayScope";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import { triggerBase, triggerHover } from "@/components/mcp/styles";
import { cn } from "@/lib/ui/cn";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

type ScopedCapabilityLevel = "project" | "session" | "conversation";
type ScopedConversationScope = "session" | "project";

interface ScopedAgentCapabilitiesConfigProps {
  level: ScopedCapabilityLevel;
  projectName: string;
  conversationScope?: ScopedConversationScope;
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
  conversationScope,
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
        conversationScope,
        sessionName,
        conversationId,
      }),
    [conversationId, conversationScope, level, projectName, sessionName],
  );
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () =>
      buildLayerOptions({
        level,
        projectName,
        conversationScope,
        sessionName,
        conversationId,
      }),
    [conversationId, conversationScope, level, projectName, sessionName],
  );

  const title = disabled
    ? (disabledTooltip ?? "Agent capability configuration unavailable")
    : "Agent capability configuration";

  return (
    <>
      {renderTrigger && (
        <button
          type="button"
          className={
            className ?? cn(triggerBase, triggerHover, "min-w-[118px]")
          }
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-label={title}
          aria-expanded={open}
          title={title}
        >
          <span className="whitespace-nowrap">Capabilities</span>
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
        className="fixed inset-0 z-dropdown bg-[var(--cc-bg-void-a60)] [backdrop-filter:blur(4px)_saturate(120%)]"
        data-testid="agent-capabilities-drawer-overlay"
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 bottom-0 z-dropdown flex w-[min(720px,100vw)] flex-col border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base shadow-[-16px_0_48px_var(--cc-black-a55)]"
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
  conversationScope,
  sessionName,
  conversationId,
}: {
  level: ScopedCapabilityLevel;
  projectName: string;
  conversationScope?: ScopedConversationScope;
  sessionName?: string;
  conversationId?: string;
}): AgentCapabilityScope {
  if (level === "project") return { level: "project", projectName };
  if (level === "session") {
    if (!sessionName) throw new Error("sessionName is required");
    return { level: "session", projectName, sessionName };
  }
  if (conversationScope === "project") {
    if (!conversationId) return { level: "project", projectName };
    return {
      level: "conversation",
      projectName,
      conversationScope: "project",
      conversationId,
    };
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
  conversationScope,
  sessionName,
  conversationId,
}: {
  level: ScopedCapabilityLevel;
  projectName: string;
  conversationScope?: ScopedConversationScope;
  sessionName?: string;
  conversationId?: string;
}): readonly AgentCapabilityLayerOption[] {
  const options: AgentCapabilityLayerOption[] = [
    { label: "Global", scope: { level: "global" } },
    { label: "Project", scope: { level: "project", projectName } },
  ];

  if (level === "project") return options;
  if (level === "conversation" && conversationScope === "project") {
    options.push(
      conversationId
        ? {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName,
              conversationScope: "project",
              conversationId,
            },
          }
        : {
            label: "Conversation",
            disabled: true,
            value: `project-conversation:${projectName}:unselected`,
            detail: "No conversation selected",
          },
    );
    return options;
  }
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
