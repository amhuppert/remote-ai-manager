"use client";

import { cn } from "@/lib/ui/cn";
import { CONFIG_ICON_BUTTON_BOX } from "./ConfigControls";
import { ChevronRightIcon, ResetInheritIcon } from "./icons";
import { navigationTriggerId } from "./navigation-ids";
import {
  inheritedTierChip,
  inheritedTierTitle,
  isSetHere,
  resetToInheritTitle,
  type ConfigRowProvenance,
} from "./row-provenance";
import { ConfigValueParts, type ConfigValuePart } from "./value-parts";

/**
 * The two rows every config screen is built from, and the provenance chrome
 * they share. A screen decides what a row means; this module decides how a row
 * states where its value came from and how the reader takes it back.
 *
 * Section structure is composition rather than a marker row: a screen wraps its
 * rows in a `ConfigRowGroup` and the group draws the header and the dividers.
 */

/** `border-l-2` needs the other three sides zeroed — CC ships no Preflight. */
const ROW_BOX =
  "flex flex-col gap-[7px] border-t-0 border-r-0 border-b border-l-2 border-solid border-b-border-dim px-[12px] pt-[9px] pb-[11px] last:border-b-0";

const ROW_LABEL = "font-mono text-[0.76rem] font-medium";

function TierChip({ label, title }: { label: string; title: string }) {
  return (
    <span
      data-testid="config-tier-chip"
      title={title}
      className="flex-shrink-0 rounded-sm border border-solid border-border-default px-[5px] font-mono text-[0.7rem] text-text-tertiary"
    >
      {label}
      {/* The chip is not focusable, so the `title` alone would never reach a
          screen reader; the sentence rides along in the accessibility tree. */}
      <span className="sr-only"> — {title}</span>
    </span>
  );
}

function ResetToInheritButton({
  granularity,
  onReset,
}: {
  granularity: ConfigRowProvenance["granularity"];
  onReset: () => void;
}) {
  const title = resetToInheritTitle(granularity);
  return (
    <button
      type="button"
      onClick={onReset}
      title={title}
      aria-label={title}
      className={cn(CONFIG_ICON_BUTTON_BOX, "text-cyan")}
    >
      <ResetInheritIcon size={12} />
    </button>
  );
}

export function ConfigRowGroup({
  label,
  tier,
  children,
}: {
  label?: string;
  /** The tier the whole section inherits from, when it is uniform. */
  tier?: "G" | "W";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base">
      {label ? (
        <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-surface px-[12px] py-[9px]">
          <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
            {label}
          </span>
          {tier ? (
            <span className="ml-auto font-mono text-[0.7rem] font-medium tracking-[0.06em] text-text-tertiary uppercase">
              {tier}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export interface ConfigDrillRowProps {
  /** The screen this row opens; also the id focus returns to. */
  screenId: string;
  label: string;
  parts: readonly ConfigValuePart[];
  /**
   * Provenance for the group behind the row: `setHere` is true when any path it
   * summarises is overridden, and `sourceTier` names where the block resolves
   * from otherwise.
   */
  provenance: ConfigRowProvenance;
  onOpen: () => void;
}

export function ConfigDrillRow({
  screenId,
  label,
  parts,
  provenance,
  onOpen,
}: ConfigDrillRowProps): React.JSX.Element {
  const setHere = isSetHere(provenance);
  const tier = inheritedTierChip(provenance);
  const tierTitle = inheritedTierTitle(provenance);

  return (
    <div
      data-testid={`config-row-${screenId}`}
      data-set-here={setHere ? "true" : undefined}
      className={cn(
        ROW_BOX,
        setHere ? "border-l-cyan" : "border-l-transparent",
      )}
    >
      <button
        type="button"
        id={navigationTriggerId(screenId)}
        onClick={onOpen}
        className="flex min-h-[24px] w-full cursor-pointer items-center gap-sm border-0 bg-transparent p-0 text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] max-768:min-h-[44px]"
      >
        <span
          className={cn(
            ROW_LABEL,
            setHere ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {label}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-sm">
          <ConfigValueParts parts={parts} />
          {tier && tierTitle ? (
            <TierChip label={tier} title={tierTitle} />
          ) : null}
          <span className="flex flex-shrink-0 text-text-tertiary">
            <ChevronRightIcon />
          </span>
        </div>
      </button>
    </div>
  );
}

export interface ConfigControlRowProps {
  /** Stable id for the row element; screens keep it unique within a screen. */
  rowId: string;
  label: string;
  hint?: React.ReactNode;
  /** Omitted for a row that authors nothing — a static or read-only line. */
  provenance?: ConfigRowProvenance;
  /** Read-only summary shown to the left of the control. */
  parts?: readonly ConfigValuePart[];
  /** The inline control: Switch, inline SegmentedControl, input, Select. */
  control?: React.ReactNode;
  /** Present only when the value is set at the current tier and editable. */
  onReset?: () => void;
  disabled?: boolean;
  /** Full-width content below the hint: textarea, checklist, chips, item list. */
  children?: React.ReactNode;
}

export function ConfigControlRow({
  rowId,
  label,
  hint,
  provenance,
  parts,
  control,
  onReset,
  disabled = false,
  children,
}: ConfigControlRowProps): React.JSX.Element {
  const setHere = provenance ? isSetHere(provenance) : false;
  const tier = provenance ? inheritedTierChip(provenance) : null;
  const tierTitle = provenance ? inheritedTierTitle(provenance) : null;
  const showReset = provenance !== undefined && setHere && !disabled && onReset;

  return (
    <div
      data-testid={`config-row-${rowId}`}
      data-set-here={setHere ? "true" : undefined}
      className={cn(
        ROW_BOX,
        setHere ? "border-l-cyan" : "border-l-transparent",
      )}
    >
      <div className="flex min-h-[24px] items-center gap-sm">
        <span
          className={cn(
            ROW_LABEL,
            setHere ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {label}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-sm">
          {parts && parts.length > 0 ? (
            <ConfigValueParts parts={parts} />
          ) : null}
          {control}
          {tier && tierTitle ? (
            <TierChip label={tier} title={tierTitle} />
          ) : null}
          {showReset && provenance ? (
            <ResetToInheritButton
              granularity={provenance.granularity}
              onReset={onReset}
            />
          ) : null}
        </div>
      </div>
      {hint ? (
        <div className="font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
          {hint}
        </div>
      ) : null}
      {children}
    </div>
  );
}
