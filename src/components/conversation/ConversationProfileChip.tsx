"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import {
  conversationProfileChipDetail,
  conversationProfileChipLabel,
  conversationProfileChipTier,
  type ConversationProfileChipState,
} from "./conversation-profile-chip-state";

interface ConversationProfileChipProps {
  state: ConversationProfileChipState;
  /** External-geometry utilities only; appended after appearance. */
  className?: string;
}

/**
 * Which agent profile this conversation is running under, and where it came
 * from.
 *
 * A profiled conversation reads as a filled violet chip naming the profile and
 * its source tier; a legacy one reads as an inert ghost chip saying
 * `No profile` — the same treatment `CompactionStatusChip` gives its `none`
 * state, so "nothing here" looks deliberate rather than broken.
 *
 * The tier is rendered rather than left to the tooltip because tiers are
 * sibling scopes: the same name can exist in two of them, so the name alone
 * does not identify the profile a turn is running under (R8.2).
 *
 * The chip only ever receives the REDACTED snapshot, so there is no path from
 * this component to the profile's instruction text (R6.3).
 */
export default function ConversationProfileChip({
  state,
  className,
}: ConversationProfileChipProps): React.JSX.Element {
  const label = conversationProfileChipLabel(state);
  const tier = conversationProfileChipTier(state);
  return (
    <StatusChip
      tone={state.kind === "legacy" ? "neutral" : "violet"}
      appearance={state.kind === "legacy" ? "ghost" : "flat"}
      data-state={state.kind}
      {...(state.kind === "legacy" ? {} : { "data-tier": state.tier })}
      layoutClassName={className}
      title={conversationProfileChipDetail(state)}
      aria-label={
        tier === null
          ? `Agent profile: ${label}`
          : `Agent profile: ${label} (${tier.label})`
      }
    >
      {label}
      {tier !== null && (
        <span className="text-[0.92em] opacity-70">· {tier.label}</span>
      )}
    </StatusChip>
  );
}
