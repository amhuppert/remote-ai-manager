"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { triggerBase, triggerHover } from "@/components/mcp/styles";
import { cn } from "@/lib/ui/cn";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";
import {
  conversationCapabilityLayers,
  conversationCapabilityScope,
} from "./conversation-capability-scope";
import {
  capabilitiesDrawerContent,
  capabilitiesDrawerScrim,
} from "./drawer-recipe";

interface ConversationAgentCapabilitiesConfigProps {
  projectName: string;
  /**
   * The conversation's explicit scope (D1). A project conversation has no
   * session layer to configure, and reading that off an absent or
   * sentinel-valued session name is what made its cascade session-shaped.
   */
  scope: ConversationScopeRef;
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
  scope,
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
  const initialScope = useMemo<AgentCapabilityScope>(
    () => conversationCapabilityScope({ scope, projectName, conversationId }),
    [scope, conversationId, projectName],
  );
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () => conversationCapabilityLayers({ scope, projectName, conversationId }),
    [scope, conversationId, projectName],
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
