"use client";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/ui/cn";

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
  "data-[state=closed]:hover:border-cyan data-[state=closed]:hover:text-text-primary",
  "data-[state=open]:border-cyan data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary",
);

export interface SessionActionsMenuProps {
  targetBranch: string;
  onPush?: () => void;
  onRebase?: () => void;
  onDelete: () => void;
}

export default function SessionActionsMenu({
  targetBranch,
  onPush,
  onRebase,
  onDelete,
}: SessionActionsMenuProps): React.JSX.Element {
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
