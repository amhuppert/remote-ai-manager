"use client";

import { useId, useMemo } from "react";

import { StatusChip } from "@/components/ui/StatusChip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  type SelectContentLayer,
} from "@/components/ui/Select";
import { useAgentProfileLibrary } from "@/lib/agent-profiles/queries";
import type {
  AgentProfileAudience,
  AgentProfileRef,
  AgentProfileTier,
} from "@/lib/agent-profiles/schemas";

import { agentProfileTierPresentation } from "./agent-profile-tier";
import {
  agentProfileAdvisoryWarning,
  buildAgentProfilePickerGroups,
  findAgentProfilePickerOption,
  parseAgentProfilePickerValue,
  STANDARD_AGENT_PROFILE_VALUE,
} from "./agent-profile-picker-state";

export interface AgentProfileSelection {
  /** The compact `tier:id` spelling — what a caller stores in local state. */
  value: string;
  ref: AgentProfileRef;
}

export interface AgentProfilePickerProps {
  /**
   * Scopes the listing: builtin + global + this project's own profiles. Absent
   * for a surface that belongs to no project (the global workflow defaults),
   * which lists the tiers that exist outside any project.
   */
  projectName?: string | null;
  value: string;
  onChange: (selection: AgentProfileSelection) => void;
  /**
   * Who the picked profile will run as. Only drives the advisory warning —
   * every profile stays selectable for every audience (R10.2).
   */
  audience?: AgentProfileAudience;
  disabled?: boolean;
  /** Test/story affordance: Radix cannot open a listbox in jsdom on its own. */
  open?: boolean;
  /** External-geometry utilities only. */
  layoutClassName?: string;
  /** Elevates the portaled listbox when the picker sits inside a popover. */
  contentLayer?: SelectContentLayer;
}

function TierBadge({ tier }: { tier: AgentProfileTier }): React.JSX.Element {
  const { label, tone } = agentProfileTierPresentation(tier);
  return (
    <StatusChip tone={tone} appearance="flat">
      {label}
    </StatusChip>
  );
}

/**
 * The single profile picker every new-conversation surface renders (D23).
 *
 * One component rather than one per creation path, because per-path coverage is
 * a requirement: sharing it makes the claim about wiring — which a test can
 * check at each call site — instead of about four implementations agreeing.
 *
 * It never blocks a choice. `recommendedFor` is advisory metadata, so a
 * mismatched audience produces a sentence beside the control and the option
 * stays exactly as selectable as any other. Runtime selection (backend, model,
 * reasoning effort) is a separate cascade and is deliberately absent here.
 */
export default function AgentProfilePicker({
  projectName,
  value,
  onChange,
  audience = "conversation",
  disabled,
  open,
  layoutClassName,
  contentLayer,
}: AgentProfilePickerProps): React.JSX.Element {
  const library = useAgentProfileLibrary(projectName);
  const descriptionId = useId();

  const groups = useMemo(
    () => buildAgentProfilePickerGroups(library.data?.profiles ?? []),
    [library.data],
  );

  const selected = findAgentProfilePickerOption(groups, value);
  const warning = agentProfileAdvisoryWarning(selected, audience);

  return (
    <div className="flex min-w-0 flex-col gap-2xs">
      <Select
        value={value}
        disabled={disabled}
        {...(open === undefined ? {} : { open })}
        onValueChange={(next) => {
          const ref = parseAgentProfilePickerValue(next);
          // The values are ours, so an unparseable one is not a user error to
          // report — it is a selection that never happened.
          if (ref !== null) onChange({ value: next, ref });
        }}
      >
        <SelectTrigger
          aria-label="Agent profile"
          aria-describedby={warning === null ? undefined : descriptionId}
          layoutClassName={layoutClassName}
        >
          <SelectValue>
            <span className="truncate">
              {selected?.name ?? "Standard Agent"}
            </span>
          </SelectValue>
          <TierBadge tier={selected?.tier ?? "builtin"} />
        </SelectTrigger>
        <SelectContent
          contentLayer={contentLayer}
          layoutClassName="max-w-[420px]"
        >
          {groups.map((group) => (
            <SelectGroup key={group.tier}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  // The listing carries no instruction text (R6.3); the
                  // description is the profile's own summary of itself.
                  title={option.description}
                  description={<TierBadge tier={option.tier} />}
                >
                  {option.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {selected !== undefined && (
        <span className="max-w-[340px] font-mono text-[0.68rem] leading-[1.4] text-text-tertiary">
          {selected.description}
        </span>
      )}
      {warning !== null && (
        <span
          id={descriptionId}
          role="status"
          className="max-w-[340px] font-mono text-[0.68rem] leading-[1.4] text-amber"
        >
          {warning}
        </span>
      )}
    </div>
  );
}

export { STANDARD_AGENT_PROFILE_VALUE };
