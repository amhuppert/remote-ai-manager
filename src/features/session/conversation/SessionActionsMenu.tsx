"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import CheckpointMenuItems from "@/components/conversation/CheckpointMenuItems";
import type {
  CheckpointActionState,
  CheckpointChipState,
} from "@/components/conversation/checkpoint-action-state";
import {
  ArrowUpIcon,
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DocumentIcon,
  LayoutIcon,
  RefreshIcon,
  TrashIcon,
} from "@/components/icons";
import { MenuItemIcon, MenuItemText } from "@/components/ui/MenuItemContent";
import { cn } from "@/lib/ui/cn";
import type { LayoutMode } from "@/lib/sessions/schemas";
import { LAYOUT_OPTIONS } from "./LayoutSwitcher";
import type { CompactionChipState } from "@/components/conversation/compaction-chip-state";

// Trigger appearance preserved from the legacy "Actions" button; open state is
// read off Radix's `data-state` (Radix also injects aria-haspopup/aria-expanded).
const TRIGGER_CLASS = cn(
  "group inline-flex h-[26px] cursor-pointer items-center gap-[5px] rounded-sm border border-solid border-border-default bg-transparent px-[10px] font-mono text-[0.68rem] font-semibold tracking-[0.04em] text-text-secondary uppercase transition-all duration-150 ease-[ease]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
  "data-[state=closed]:hover:border-cyan data-[state=closed]:hover:text-text-primary",
  "data-[state=open]:border-cyan data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary",
);

export interface SessionActionsMenuProps {
  targetBranch: string;
  merged?: boolean;
  onToggleMerged?: () => void;
  mergeStatusPending?: boolean;
  activeLayout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
  onPush?: () => void;
  onRebase?: () => void;
  onDelete: () => void;
  /**
   * Conversation-compaction state (design §12.2). When omitted the compaction
   * section is hidden entirely (hosts without a conversation in scope).
   */
  compaction?: CompactionChipState;
  onCompactConversation?: () => void;
  onViewArtifact?: () => void;
  onRefreshArtifact?: () => void;
  onCopyReference?: () => void;
  /**
   * Context-checkpoint state (design §8). A separate action from the
   * compaction artifact above: it retires the provider context, where the
   * artifact only writes a reading document. Omitted where no conversation is
   * in scope, which hides the checkpoint items entirely.
   */
  checkpointChip?: CheckpointChipState;
  checkpointAction?: CheckpointActionState;
  onCompactContextNow?: () => void;
  onPrepareHandoff?: () => void;
  onViewCheckpoint?: () => void;
}

export default function SessionActionsMenu({
  targetBranch,
  merged,
  onToggleMerged,
  mergeStatusPending,
  activeLayout,
  onLayoutChange,
  onPush,
  onRebase,
  onDelete,
  compaction,
  onCompactConversation,
  onViewArtifact,
  onRefreshArtifact,
  onCopyReference,
  checkpointChip,
  checkpointAction,
  onCompactContextNow,
  onPrepareHandoff,
  onViewCheckpoint,
}: SessionActionsMenuProps): React.JSX.Element {
  const [layoutExpanded, setLayoutExpanded] = useState(false);
  const showCompact =
    compaction?.kind === "none" || compaction?.kind === "failed";
  const showView = compaction !== undefined && compaction.kind !== "none";
  const showRefresh =
    compaction?.kind === "stale" || compaction?.kind === "outdated";
  const handleLayoutChange = (value: string): void => {
    const option = LAYOUT_OPTIONS.find(({ mode }) => mode === value);
    if (!option) return;
    onLayoutChange(option.mode);
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setLayoutExpanded(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS} title="Session actions">
          <span className="leading-none">Actions</span>
          <ChevronDownIcon
            size={14}
            className="transition-transform duration-150 group-data-[state=open]:rotate-180"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" layoutClassName="w-[352px]">
        <DropdownMenuLabel>Session</DropdownMenuLabel>
        {onToggleMerged && (
          <>
            <DropdownMenuItem
              onSelect={onToggleMerged}
              disabled={mergeStatusPending}
            >
              <MenuItemIcon>
                <CheckIcon />
              </MenuItemIcon>
              <MenuItemText>
                {merged ? "Unmark as merged" : "Mark as merged"}
              </MenuItemText>
            </DropdownMenuItem>
          </>
        )}
        <>
          <DropdownMenuItem
            aria-expanded={layoutExpanded}
            onSelect={(event) => {
              event.preventDefault();
              setLayoutExpanded(!layoutExpanded);
            }}
          >
            <MenuItemIcon>
              <LayoutIcon />
            </MenuItemIcon>
            <MenuItemText>Layout</MenuItemText>
            <span className="text-[0.7rem] text-text-secondary">
              {
                LAYOUT_OPTIONS.find(({ mode }) => mode === activeLayout)
                  ?.tooltip
              }
            </span>
            <ChevronDownIcon size={18} />
          </DropdownMenuItem>
          {layoutExpanded && (
            <DropdownMenuRadioGroup
              aria-label="Layout"
              value={activeLayout}
              onValueChange={handleLayoutChange}
            >
              {LAYOUT_OPTIONS.map(({ mode, tooltip }) => (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  {tooltip}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Branch</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={onPush}
          disabled={!onPush}
          title={onPush ? undefined : "Push not available yet"}
        >
          <MenuItemIcon>
            <ArrowUpIcon />
          </MenuItemIcon>
          <MenuItemText description="Push to remote">Push branch</MenuItemText>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onRebase}
          disabled={!onRebase}
          title={onRebase ? undefined : "Rebase not available yet"}
        >
          <MenuItemIcon>
            <BranchIcon />
          </MenuItemIcon>
          <MenuItemText description="Replay commits onto target">
            Rebase on {targetBranch}
          </MenuItemText>
        </DropdownMenuItem>
        {compaction !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Compaction artifact</DropdownMenuLabel>
            {showCompact && (
              <DropdownMenuItem
                onSelect={onCompactConversation}
                disabled={!onCompactConversation}
              >
                <MenuItemIcon>
                  <DocumentIcon />
                </MenuItemIcon>
                <MenuItemText
                  description={
                    compaction.kind === "failed"
                      ? "Previous run failed — run again"
                      : "Write a summary; keep the current context"
                  }
                >
                  Generate compaction artifact
                </MenuItemText>
              </DropdownMenuItem>
            )}
            {compaction.kind === "pending" && (
              <DropdownMenuItem disabled>
                <MenuItemIcon>
                  <DocumentIcon />
                </MenuItemIcon>
                <MenuItemText description="Context artifact is generating">
                  Compacting…
                </MenuItemText>
              </DropdownMenuItem>
            )}
            {showView && (
              <DropdownMenuItem
                onSelect={onViewArtifact}
                disabled={!onViewArtifact}
              >
                <MenuItemIcon>
                  <DocumentIcon />
                </MenuItemIcon>
                <MenuItemText description="Open the artifact panel">
                  View context artifact
                </MenuItemText>
              </DropdownMenuItem>
            )}
            {showRefresh && (
              <DropdownMenuItem
                onSelect={onRefreshArtifact}
                disabled={!onRefreshArtifact}
              >
                <MenuItemIcon>
                  <RefreshIcon />
                </MenuItemIcon>
                <MenuItemText
                  description={
                    compaction.kind === "stale"
                      ? `Behind ${compaction.behind} messages`
                      : "Format outdated — full regeneration"
                  }
                >
                  Refresh context artifact
                </MenuItemText>
              </DropdownMenuItem>
            )}
            {checkpointChip !== undefined && checkpointAction !== undefined && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Context checkpoint</DropdownMenuLabel>
                <CheckpointMenuItems
                  chip={checkpointChip}
                  action={checkpointAction}
                  {...(onCompactContextNow ? { onCompactContextNow } : {})}
                  {...(onViewCheckpoint ? { onViewCheckpoint } : {})}
                  {...(onPrepareHandoff ? { onPrepareHandoff } : {})}
                />
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onSelect={onCopyReference}
              disabled={!onCopyReference}
            >
              <MenuItemIcon>
                <CopyIcon />
              </MenuItemIcon>
              <MenuItemText description="Copy this conversation’s # mention">
                Copy reference
              </MenuItemText>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={onDelete}>
          <MenuItemIcon>
            <TrashIcon />
          </MenuItemIcon>
          <MenuItemText description="Delete worktree and session state">
            Delete session…
          </MenuItemText>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
