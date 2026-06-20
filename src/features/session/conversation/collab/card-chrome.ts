import type { CollaborationResolutionDecisionNextAction } from "@/lib/workflows/collaboration/types";

/**
 * Shared Tailwind class recipes for the collab artifact-card chrome — the
 * header (agent / eyebrow / round / primary-flag / verdict / summary) and body
 * (section / section-title / list / narrative) pieces that the cards composing
 * `CollabCollapsibleCard` render. Centralized so every card emits identical
 * migrated chrome. Migrated 1:1 from the `.collab-artifact-card-*` family that
 * formerly lived in `conversation.css`.
 *
 * `cardAgent` colors by the `data-agent` attribute (claude/codex carry no
 * underscore, so the `data-[agent=…]` variant is selector-safe). `cardVerdict`
 * cannot: its `next-action` values include underscores (`continue_negotiation`,
 * `ask_user`), which Tailwind rewrites to spaces inside `data-[…]`, so the color
 * is a static map keyed by the union instead (`cardVerdictColor`).
 */

export const cardAgent =
  "font-mono text-[0.78rem] font-semibold uppercase tracking-[0.04em] data-[agent=claude]:text-cyan data-[agent=codex]:text-violet";

export const cardEyebrow =
  "font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-text-secondary";

export const cardPrimaryFlag =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.08em] uppercase px-[6px] py-[1px] rounded-sm bg-cyan-glow text-cyan";

export const cardRound =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.08em] uppercase px-[6px] py-[1px] rounded-sm bg-bg-base text-text-secondary";

export const cardVerdict =
  "font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase px-[8px] py-[1px] rounded-sm";

export const cardVerdictColor: Record<
  CollaborationResolutionDecisionNextAction,
  string
> = {
  final: "bg-green-glow text-green",
  continue_negotiation: "bg-cyan-glow text-cyan",
  ask_user: "bg-amber-glow text-amber",
  fail: "bg-red-glow text-red",
};

export const cardSummary =
  "font-mono text-[0.7rem] text-text-tertiary ml-auto overflow-hidden text-ellipsis whitespace-nowrap max-768:ml-0 max-768:basis-full max-768:text-left";

export const cardSection = "flex flex-col gap-[6px]";

export const cardSectionTitle =
  "m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-text-secondary";

export const cardList =
  "m-0 flex flex-col gap-[4px] pl-md text-[0.82rem] leading-[1.5] text-text-primary";

export const cardNarrative =
  "m-0 text-[0.85rem] leading-[1.55] text-text-primary";

// id pill list (CounterProposal accepted/rejected ids, OpenConflicts disagreement
// ids). The legacy `[data-tone=accepted|rejected]` recolor rules were dead (no
// call site set data-tone), so only the neutral item recipe survives.
export const idList = "m-0 flex list-none flex-wrap gap-[4px] p-0";
export const idListItem =
  "rounded-sm border border-solid border-border-subtle bg-bg-base px-[6px] py-[1px] font-mono text-[length:var(--font-size-floor)] text-text-secondary";

// change list (Proposed / Counter-proposal change items).
export const changeList = "m-0 flex list-none flex-col gap-[6px] p-0";
export const changeListItem =
  "flex flex-col gap-[2px] rounded-sm border border-solid border-border-subtle bg-bg-base px-sm py-[6px]";
export const changeListId =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.06em] text-text-tertiary";
export const changeListChange = "text-[0.82rem] font-medium text-text-primary";
export const changeListRationale = "text-[0.78rem] italic text-text-secondary";
export const changeListAddresses =
  "flex flex-wrap gap-[4px] font-mono text-[length:var(--font-size-floor)] text-text-tertiary";
export const changeListAddressesLabel = "uppercase tracking-[0.06em]";
export const changeListAddressesId =
  "rounded-sm bg-bg-raised px-[5px] py-[1px] text-cyan-dim";
