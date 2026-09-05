"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { cn } from "@/lib/ui/cn";

type ConversationStatus = SessionActiveConversation["status"];

// Active beats hover (legacy source order). Expressed order-independently with
// mutually-exclusive `data-[active=true]` vs `data-[active=false]:hover` gating
// (docs/tailwind-conventions.md §1.2), so no reliance on variant emission order.
const tabClass =
  "group flex items-center gap-xs h-[28px] max-768:h-[44px] max-w-[220px] px-sm border border-solid border-border-dim rounded-md bg-transparent text-text-secondary font-mono text-[0.72rem] font-medium cursor-pointer shrink-0 transition-colors duration-150 ease-[ease] " +
  "data-[active=true]:bg-cyan data-[active=true]:border-cyan data-[active=true]:text-text-inverse " +
  "data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:border-border-strong data-[active=false]:hover:text-text-primary";

// Static class maps keyed by the status union (docs/tailwind-conventions.md
// §1.2): a `data-[status=…]` arbitrary variant can't carry the underscore in
// `waiting_for_input` (Tailwind rewrites `_` to a space in the selector value),
// so the per-status appearance is selected in JS instead.
// No base background: every status in the union supplies one (legacy
// `bg-text-tertiary` was only a fallback for unlisted statuses, of which there
// are none). A base bg would tie on specificity with the status bg and win or
// lose by utility emission order rather than intent.
const dotBase = "w-[7px] h-[7px] rounded-full shrink-0";

const dotBgClass: Record<ConversationStatus, string> = {
  new: "bg-blue",
  running: "bg-cyan",
  awaiting: "bg-green",
  waiting_for_input: "bg-amber",
};

// The glow is suppressed on the active tab (legacy
// `.conversation-tab[data-active=true] .conversation-tab__dot { box-shadow: none }`),
// so it is composed in only when the tab is inactive.
const dotGlowClass: Record<ConversationStatus, string> = {
  new: "shadow-[0_0_6px_var(--blue-glow)]",
  running: "shadow-[0_0_6px_var(--cyan-glow-strong)]",
  awaiting: "shadow-[0_0_6px_var(--green-glow)]",
  waiting_for_input: "shadow-[0_0_6px_var(--amber-glow)]",
};

const titleClass = "overflow-hidden text-ellipsis whitespace-nowrap";

const hotkeyClass =
  "max-768:hidden shrink-0 text-text-tertiary text-[0.7rem] group-data-[active=true]:text-text-inverse group-data-[active=true]:opacity-70";

// `--border-accent`/`--bg-secondary` are undefined tokens; the legacy shorthands
// invalidate at computed-value time (no border, transparent background). The
// arbitrary shorthands reproduce that exact computed result for parity.
const renameInputClass =
  "min-w-0 flex-1 px-[4px] py-[1px] rounded-sm text-text-primary font-mono text-[0.72rem] font-medium outline-none [border:1px_solid_var(--border-accent)] [background:var(--bg-secondary)]";

const closeClass =
  "inline-flex items-center justify-center w-[16px] h-[16px] max-768:size-[44px] max-768:visible p-0 border-0 rounded-sm bg-transparent text-inherit cursor-pointer shrink-0 invisible transition-[background] duration-150 ease-[ease] " +
  "group-hover:visible group-data-[active=true]:visible " +
  "group-data-[active=false]:hover:bg-bg-elevated group-data-[active=false]:hover:text-text-primary " +
  "group-data-[active=true]:hover:bg-cyan-dim group-data-[active=true]:hover:text-text-inverse";

export interface ConversationTabProps {
  id: string;
  title: string;
  status: SessionActiveConversation["status"];
  active: boolean;
  hotkeyHint?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Open the tab's context menu at the cursor (viewport coordinates). */
  onContextMenu?: (point: { x: number; y: number }) => void;
  /** When true, the title is replaced with an inline rename input. */
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
}

export default function ConversationTab({
  id,
  title,
  status,
  active,
  hotkeyHint,
  onActivate,
  onClose,
  onContextMenu,
  isEditing = false,
  editValue = "",
  onEditChange,
  onEditCommit,
  onEditCancel,
}: ConversationTabProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(id);
      }
    },
    [id, onActivate],
  );

  const handleClose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Closing must not also activate the tab; stop the click from bubbling
      // to the tab body's onClick.
      event.stopPropagation();
      onClose(id);
    },
    [id, onClose],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );

  return (
    <div
      className={tabClass}
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : "false"}
      tabIndex={0}
      onClick={isEditing ? undefined : () => onActivate(id)}
      onKeyDown={isEditing ? undefined : handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <span
        className={cn(
          dotBase,
          dotBgClass[status],
          !active && dotGlowClass[status],
        )}
        data-status={status}
        aria-hidden="true"
      />
      {isEditing ? (
        <input
          ref={inputRef}
          className={renameInputClass}
          aria-label="Rename conversation"
          value={editValue}
          maxLength={200}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onEditChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onEditCommit?.();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              onEditCancel?.();
            }
          }}
          onBlur={() => onEditCommit?.()}
        />
      ) : (
        <>
          <span className={titleClass}>{title}</span>
          {hotkeyHint !== undefined && (
            <span className={hotkeyClass} aria-hidden="true">
              {hotkeyHint}
            </span>
          )}
          <button
            type="button"
            className={closeClass}
            aria-label="Close tab"
            onClick={handleClose}
          >
            <CloseIcon />
          </button>
        </>
      )}
    </div>
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
