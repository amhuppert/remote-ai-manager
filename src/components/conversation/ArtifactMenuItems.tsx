"use client";

import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/ui/cn";

import {
  compactionChipLabel,
  type CompactionChipState,
} from "./compaction-chip-state";

const GLYPH_CLASS =
  "inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm font-mono text-[0.8rem]";
const BODY_CLASS = "flex min-w-0 flex-1 flex-col gap-px";
const LABEL_CLASS = "text-[0.82rem] font-medium";
const DESC_CLASS = "font-mono text-[0.64rem] text-text-tertiary";

export interface ArtifactMenuItemsProps {
  compaction: CompactionChipState;
  /** Generates or refreshes the rolling reading artifact. */
  onGenerateArtifact?: () => void;
  /** Opens the artifact reader, when the host has one. */
  onViewArtifact?: () => void;
}

/**
 * The compaction-artifact items for a host whose conversation actions are not
 * the session page's menu — currently the project cockpit.
 *
 * This is the OTHER half of the pair a conversation offers. Generating an
 * artifact writes a reading document over the recorded history and changes
 * continuity not at all; a checkpoint retires the provider context. Presenting
 * them as one control would let a reader believe that refreshing their notes
 * had thrown away the conversation's memory, so the two stay separate wherever
 * either appears.
 */
export default function ArtifactMenuItems({
  compaction,
  onGenerateArtifact,
  onViewArtifact,
}: ArtifactMenuItemsProps): React.JSX.Element {
  const running = compaction.kind === "pending";
  const exists = compaction.kind !== "none";
  return (
    <>
      <DropdownMenuItem
        onSelect={running ? undefined : onGenerateArtifact}
        disabled={running || onGenerateArtifact === undefined}
        data-artifact-action={compaction.kind}
      >
        <span
          className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
          aria-hidden="true"
        >
          {"⇊"}
        </span>
        <span className={BODY_CLASS}>
          <span className={LABEL_CLASS}>
            {exists
              ? "Refresh compaction artifact"
              : "Generate compaction artifact"}
          </span>
          <span className={DESC_CLASS}>
            {running
              ? "A compaction run is already in flight"
              : compaction.kind === "failed"
                ? "Previous run failed — run again"
                : "Write a reading artifact; continuity is unchanged"}
          </span>
        </span>
      </DropdownMenuItem>
      {onViewArtifact !== undefined && exists && (
        <DropdownMenuItem onSelect={onViewArtifact} data-artifact-view="">
          <span
            className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
            aria-hidden="true"
          >
            {"▤"}
          </span>
          <span className={BODY_CLASS}>
            <span className={LABEL_CLASS}>View compaction artifact</span>
            <span className={DESC_CLASS}>
              {`${compactionChipLabel(compaction)} — the rolling reading document`}
            </span>
          </span>
        </DropdownMenuItem>
      )}
    </>
  );
}
