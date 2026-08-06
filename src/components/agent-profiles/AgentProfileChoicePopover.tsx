"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { WithTooltip } from "@/components/ui/WithTooltip";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

import AgentProfilePicker from "./AgentProfilePicker";
import {
  STANDARD_AGENT_PROFILE_REF,
  STANDARD_AGENT_PROFILE_VALUE,
  parseAgentProfilePickerValue,
} from "./agent-profile-picker-state";

export interface AgentProfileChoicePopoverProps {
  /** Scopes the listing: builtin + global + this project's own profiles. */
  projectName: string;
  /** The control that opens the panel — one element, rendered as the trigger. */
  trigger: React.ReactNode;
  /** Tooltip and accessible purpose of the trigger. */
  triggerLabel: string;
  /** Kicker above the picker: what this choice is for. */
  title: string;
  confirmLabel: string;
  onConfirm: (profile: AgentProfileRef) => void;
  disabled?: boolean;
}

/**
 * A profile choice offered beside a control that already does the thing.
 *
 * The surfaces that create a conversation in one click — the session sidebar,
 * the cockpit tab strip, the fork action — are hot paths, some of them
 * hotkeyed. Putting a picker in front of them would tax every default creation
 * to serve the occasional specialized one, so the picker lives beside the fast
 * control in a panel instead, and the fast control keeps meaning the Standard
 * Agent.
 *
 * The selection resets each time the panel opens: choosing a specialist for one
 * conversation is not a preference, and a sticky picker would silently apply it
 * to the next one. That rule lives here so no call site can forget it.
 */
export default function AgentProfileChoicePopover({
  projectName,
  trigger,
  triggerLabel,
  title,
  confirmLabel,
  onConfirm,
  disabled,
}: AgentProfileChoicePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(STANDARD_AGENT_PROFILE_VALUE);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(STANDARD_AGENT_PROFILE_VALUE);
      }}
    >
      <WithTooltip label={triggerLabel}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </WithTooltip>
      <PopoverContent align="end" layoutClassName="w-[320px]">
        <div className="flex flex-col gap-sm">
          <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            {title}
          </span>
          <AgentProfilePicker
            projectName={projectName}
            value={value}
            onChange={(selection) => setValue(selection.value)}
            disabled={disabled}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={disabled}
            onClick={() => {
              // The picker only ever emits values it produced, so the fallback
              // is the default rather than a guess at a malformed one.
              onConfirm(
                parseAgentProfilePickerValue(value) ??
                  STANDARD_AGENT_PROFILE_REF,
              );
              setOpen(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
