"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { triggerBase, triggerHover } from "@/components/mcp/styles";
import { cn } from "@/lib/ui/cn";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";
import {
  capabilitiesDrawerContent,
  capabilitiesDrawerScrim,
} from "./drawer-recipe";

interface ConversationAgentCapabilitiesConfigProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  disabled?: boolean;
  disabledTooltip?: string;
  /**
   * Reports the drawer's open-state. The composer-focus hook uses it to hold
   * `composerFocused` true while this portaled drawer (rendered outside the
   * composer region) steals focus from the editor.
   */
  onOpenChange?: (open: boolean) => void;
}

export default function ConversationAgentCapabilitiesConfig({
  projectName,
  sessionName,
  conversationId,
  disabled,
  disabledTooltip,
  onOpenChange,
}: ConversationAgentCapabilitiesConfigProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  // Project-level conversations (the `__project__` sentinel) cascade
  // global → project → conversation; there is no session layer to configure.
  const projectScoped = isProjectSentinel(sessionName);
  const initialScope = useMemo<AgentCapabilityScope>(
    () =>
      projectScoped
        ? {
            level: "conversation",
            projectName,
            conversationScope: "project",
            conversationId,
          }
        : {
            level: "conversation",
            projectName,
            sessionName,
            conversationId,
          },
    [projectScoped, conversationId, projectName, sessionName],
  );
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () => [
      { label: "Global", scope: { level: "global" } },
      { label: "Project", scope: { level: "project", projectName } },
      ...(projectScoped
        ? []
        : [
            {
              label: "Session",
              scope: { level: "session", projectName, sessionName } as const,
            },
          ]),
      { label: "Conversation", scope: initialScope },
    ],
    [initialScope, projectScoped, projectName, sessionName],
  );

  const title = disabled
    ? (disabledTooltip ?? "Agent capability configuration unavailable")
    : "Agent capability configuration";

  return (
    <>
      <button
        type="button"
        className={cn(triggerBase, triggerHover, "min-w-[118px]")}
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={title}
        aria-expanded={open}
        title={title}
      >
        <span className="whitespace-nowrap">Capabilities</span>
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
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        unstyled
        anchor="stretch"
        scrimClassName={capabilitiesDrawerScrim}
        contentClassName={capabilitiesDrawerContent}
        aria-label="Agent capabilities configuration"
      >
        <AgentCapabilitiesConfigurator
          layerOptions={layerOptions}
          initialScope={initialScope}
          drawer
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
