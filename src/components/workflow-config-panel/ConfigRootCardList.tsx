"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import { ChevronRightIcon } from "./icons";
import { ConfigValueParts, type ConfigValuePart } from "./value-parts";
import { navigationTriggerId } from "./navigation-ids";

/**
 * The root screen: one card per configuration group, each summarising what the
 * group currently resolves to and drilling into its screen. The cards are
 * presentational — the summaries and override counts are derived by the
 * cascade adapter and handed in.
 */

export interface ConfigSummaryLine {
  key: string;
  parts: readonly ConfigValuePart[];
}

export interface ConfigRootCard {
  /** The screen this card opens. */
  screenId: string;
  title: string;
  /** `2 blocks · 1 role set here`, or null when the group is all inherited. */
  overrideLabel?: string | null;
  lines: readonly ConfigSummaryLine[];
}

/** `2 blocks · 1 role set here` — the count of overrides at the current tier. */
export function ConfigOverrideBadge({
  label,
}: {
  label: string;
}): React.JSX.Element {
  return (
    <StatusChip tone="cyan" layoutClassName="shrink-0">
      {label}
    </StatusChip>
  );
}

export function ConfigRootCardList({
  cards,
  onOpen,
}: {
  cards: readonly ConfigRootCard[];
  onOpen: (screenId: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[9px] px-lg py-md">
      {cards.map((card) => (
        <div
          key={card.screenId}
          className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base"
        >
          <button
            type="button"
            id={navigationTriggerId(card.screenId)}
            onClick={() => onOpen(card.screenId)}
            className="flex w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-[13px] py-[10px] text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] max-768:min-h-[44px]"
          >
            <span className="font-mono text-[0.74rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
              {card.title}
            </span>
            {card.overrideLabel ? (
              <ConfigOverrideBadge label={card.overrideLabel} />
            ) : null}
            <span className="ml-auto flex text-text-tertiary">
              <ChevronRightIcon />
            </span>
          </button>
          {card.lines.length > 0 ? (
            <div className="flex flex-col gap-xs px-[13px] pb-[11px]">
              {card.lines.map((line) => (
                <div
                  key={line.key}
                  className="flex min-h-[19px] items-center gap-sm"
                >
                  <span className="w-[104px] flex-shrink-0 font-mono text-[0.7rem] font-medium tracking-[0.06em] text-text-tertiary uppercase">
                    {line.key}
                  </span>
                  <ConfigValueParts parts={line.parts} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
