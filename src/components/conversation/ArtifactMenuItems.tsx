"use client";

import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import { DocumentIcon } from "@/components/icons";
import { MenuItemIcon, MenuItemText } from "@/components/ui/MenuItemContent";

import {
  compactionChipLabel,
  type CompactionChipState,
} from "./compaction-chip-state";

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
        <MenuItemIcon>
          <DocumentIcon />
        </MenuItemIcon>
        <MenuItemText
          description={
            running
              ? "A compaction run is already in flight"
              : compaction.kind === "failed"
                ? "Previous run failed — run again"
                : "Write a summary; keep the current context"
          }
        >
          {exists
            ? "Refresh compaction artifact"
            : "Generate compaction artifact"}
        </MenuItemText>
      </DropdownMenuItem>
      {onViewArtifact !== undefined && exists && (
        <DropdownMenuItem onSelect={onViewArtifact} data-artifact-view="">
          <MenuItemIcon>
            <DocumentIcon />
          </MenuItemIcon>
          <MenuItemText
            description={`${compactionChipLabel(compaction)} — the rolling reading document`}
          >
            View compaction artifact
          </MenuItemText>
        </DropdownMenuItem>
      )}
    </>
  );
}
