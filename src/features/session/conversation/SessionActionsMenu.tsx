"use client";

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
import { cn } from "@/lib/ui/cn";
import type { LayoutMode } from "@/lib/sessions/schemas";
import { LAYOUT_OPTIONS } from "./LayoutSwitcher";
import type { CompactionChipState } from "@/components/conversation/compaction-chip-state";

// Rich item content (colored glyph square + label + description) rendered inside
// the canonical DropdownMenu items; the menu behaviour/appearance is the
// primitive's. The glyphs are spans (not svg), so the item recipe's `[&_svg]`
// rules don't touch them.
const GLYPH_CLASS =
  "inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm font-mono text-[0.8rem]";
const BODY_CLASS = "flex min-w-0 flex-1 flex-col gap-px";
const LABEL_CLASS = "text-[0.82rem] font-medium";
const DESC_CLASS = "font-mono text-[0.64rem] text-text-tertiary";

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
  onViewCheckpoint?: () => void;
}

export default function SessionActionsMenu({
  targetBranch,
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
  onViewCheckpoint,
}: SessionActionsMenuProps): React.JSX.Element {
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS} title="Session actions">
          <span className="leading-none">Actions</span>
          <span
            className="text-[8px] text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180 group-data-[state=open]:text-cyan"
            aria-hidden="true"
          >
            {"▼"}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" layoutClassName="w-[280px]">
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onPush}
          disabled={!onPush}
          title={onPush ? undefined : "Push not available yet"}
        >
          <span
            className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
            aria-hidden="true"
          >
            {"↑"}
          </span>
          <span className={BODY_CLASS}>
            <span className={LABEL_CLASS}>Push branch</span>
            <span className={DESC_CLASS}>Push to remote</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onRebase}
          disabled={!onRebase}
          title={onRebase ? undefined : "Rebase not available yet"}
        >
          <span
            className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
            aria-hidden="true"
          >
            {"⤴"}
          </span>
          <span className={BODY_CLASS}>
            <span className={LABEL_CLASS}>Rebase on {targetBranch}</span>
            <span className={DESC_CLASS}>Replay commits onto target</span>
          </span>
        </DropdownMenuItem>
        {compaction !== undefined && (
          <>
            <DropdownMenuSeparator />
            {showCompact && (
              <DropdownMenuItem
                onSelect={onCompactConversation}
                disabled={!onCompactConversation}
              >
                <span
                  className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
                  aria-hidden="true"
                >
                  {"⇊"}
                </span>
                <span className={BODY_CLASS}>
                  <span className={LABEL_CLASS}>
                    Generate compaction artifact
                  </span>
                  <span className={DESC_CLASS}>
                    {compaction.kind === "failed"
                      ? "Previous run failed — run again"
                      : "Write a reading artifact; continuity is unchanged"}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            {compaction.kind === "pending" && (
              <DropdownMenuItem disabled>
                <span
                  className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
                  aria-hidden="true"
                >
                  {"⇊"}
                </span>
                <span className={BODY_CLASS}>
                  <span className={LABEL_CLASS}>Compacting…</span>
                  <span className={DESC_CLASS}>
                    Context artifact is generating
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            {showView && (
              <DropdownMenuItem
                onSelect={onViewArtifact}
                disabled={!onViewArtifact}
              >
                <span
                  className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
                  aria-hidden="true"
                >
                  {"▤"}
                </span>
                <span className={BODY_CLASS}>
                  <span className={LABEL_CLASS}>View context artifact</span>
                  <span className={DESC_CLASS}>Open the artifact panel</span>
                </span>
              </DropdownMenuItem>
            )}
            {showRefresh && (
              <DropdownMenuItem
                onSelect={onRefreshArtifact}
                disabled={!onRefreshArtifact}
              >
                <span
                  className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
                  aria-hidden="true"
                >
                  {"↻"}
                </span>
                <span className={BODY_CLASS}>
                  <span className={LABEL_CLASS}>Refresh context artifact</span>
                  <span className={DESC_CLASS}>
                    {compaction.kind === "stale"
                      ? `Behind ${compaction.behind} messages`
                      : "Format outdated — full regeneration"}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            {checkpointChip !== undefined && checkpointAction !== undefined && (
              <>
                <DropdownMenuSeparator />
                <CheckpointMenuItems
                  chip={checkpointChip}
                  action={checkpointAction}
                  {...(onCompactContextNow ? { onCompactContextNow } : {})}
                  {...(onViewCheckpoint ? { onViewCheckpoint } : {})}
                />
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onSelect={onCopyReference}
              disabled={!onCopyReference}
            >
              <span
                className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
                aria-hidden="true"
              >
                {"#"}
              </span>
              <span className={BODY_CLASS}>
                <span className={LABEL_CLASS}>Copy reference</span>
                <span className={DESC_CLASS}>
                  Copy the # mention for this conversation
                </span>
              </span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={onDelete}>
          <span
            className={cn(GLYPH_CLASS, "bg-[var(--cc-red-soft-a08)] text-red")}
            aria-hidden="true"
          >
            {"✕"}
          </span>
          <span className={BODY_CLASS}>
            <span className={LABEL_CLASS}>Delete session…</span>
            <span className={DESC_CLASS}>
              Delete worktree and session state
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
