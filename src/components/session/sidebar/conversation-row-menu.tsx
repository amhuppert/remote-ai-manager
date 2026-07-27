"use client";

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/ContextMenu";

// The item model shared by the sidebar-row and tab right-click menus. Decoupled
// from the Radix primitive so call sites build a plain data array; the
// `ConversationRowMenuItems` component maps it onto the `ContextMenu` parts.
interface ConversationRowMenuActionItem {
  kind: "item";
  label: string;
  onSelect: () => void;
  hotkey?: string;
  disabled?: boolean;
  danger?: boolean;
}

interface ConversationRowMenuDivider {
  kind: "divider";
}

export type ConversationRowMenuItem =
  | ConversationRowMenuActionItem
  | ConversationRowMenuDivider;

/** The row facts the shared menu structure is derived from. */
export interface ConversationRowMenuTarget {
  scope: "session" | "project";
  /** Owning session; required for session scope. */
  sessionName?: string;
  branchName?: string | null;
  worktreePath: string;
  archived: boolean;
  /**
   * True while a human-approval gate is pending — the row must stay visible
   * and actionable in Needs Input, so the archive affordance is withheld.
   */
  approvalGatePending: boolean;
}

/**
 * Surface-specific capabilities. Optional handlers hide their item when
 * absent, so each surface (sidebar row, conversation tab) exposes exactly
 * the operations it supports while the structure stays in one place.
 */
export interface ConversationRowMenuHandlers {
  onOpenConversation: () => void;
  onOpenInTab?: () => void;
  onOpenInPane?: () => void;
  onOpenProjectPage: () => void;
  /** Sidebar session-filter toggle; `active` renders the applied state. */
  sessionFilter?: { active: boolean; onSelect: () => void };
  onCopyContext?: () => void;
  onCopyReference?: () => void;
  onRename: () => void;
  onToggleArchived: () => void;
  onArchiveOthers?: () => void;
  onArchiveSession?: () => void;
}

/**
 * Single source of the conversation context-menu structure — order, labels,
 * dividers, and scope gating — shared by the Active Conversations sidebar
 * and the conversation tab strip so the two menus cannot drift apart.
 */
export function buildConversationRowMenuItems(
  target: ConversationRowMenuTarget,
  handlers: ConversationRowMenuHandlers,
): ConversationRowMenuItem[] {
  const isSession = target.scope === "session";
  const branchName = target.branchName ?? null;
  return [
    {
      kind: "item" as const,
      label: "Open conversation",
      hotkey: "Enter",
      onSelect: handlers.onOpenConversation,
    },
    ...(isSession && handlers.onOpenInTab
      ? [
          {
            kind: "item" as const,
            label: "Open in New Tab",
            onSelect: handlers.onOpenInTab,
          },
        ]
      : []),
    ...(isSession && handlers.onOpenInPane
      ? [
          {
            kind: "item" as const,
            label: "Open in New Pane",
            onSelect: handlers.onOpenInPane,
          },
        ]
      : []),
    { kind: "divider" as const },
    {
      kind: "item" as const,
      label: "Open project page",
      onSelect: handlers.onOpenProjectPage,
    },
    ...(isSession && handlers.sessionFilter
      ? [
          {
            kind: "item" as const,
            label: handlers.sessionFilter.active
              ? `Filtered to ${target.sessionName}`
              : `Filter sidebar to session: ${target.sessionName}`,
            disabled: handlers.sessionFilter.active,
            onSelect: handlers.sessionFilter.onSelect,
          },
        ]
      : []),
    ...(isSession
      ? [
          {
            kind: "item" as const,
            label: "Copy branch name",
            disabled: branchName === null,
            onSelect: () => {
              if (branchName === null) return;
              void navigator.clipboard.writeText(branchName);
            },
          },
        ]
      : []),
    {
      kind: "item" as const,
      label: "Copy worktree path",
      onSelect: () => {
        void navigator.clipboard.writeText(target.worktreePath);
      },
    },
    ...(handlers.onCopyContext
      ? [
          {
            kind: "item" as const,
            label: "Copy context",
            onSelect: handlers.onCopyContext,
          },
        ]
      : []),
    ...(handlers.onCopyReference
      ? [
          {
            kind: "item" as const,
            label: "Copy Conversation Reference",
            onSelect: handlers.onCopyReference,
          },
        ]
      : []),
    { kind: "divider" as const },
    {
      kind: "item" as const,
      label: "Rename…",
      onSelect: handlers.onRename,
    },
    ...(target.approvalGatePending
      ? []
      : [
          {
            kind: "item" as const,
            label: target.archived
              ? "Unarchive conversation"
              : "Archive conversation",
            onSelect: handlers.onToggleArchived,
          },
        ]),
    ...(isSession && handlers.onArchiveOthers
      ? [
          {
            kind: "item" as const,
            label: "Archive Other Conversations",
            onSelect: handlers.onArchiveOthers,
          },
        ]
      : []),
    ...(isSession && handlers.onArchiveSession
      ? [
          {
            kind: "item" as const,
            label: "Archive session",
            onSelect: handlers.onArchiveSession,
          },
        ]
      : []),
  ];
}

/** Renders a row's menu-item data array as `ContextMenu` parts. */
export function ConversationRowMenuItems({
  items,
}: {
  items: ConversationRowMenuItem[];
}): React.JSX.Element {
  return (
    <>
      {items.map((item, index) =>
        item.kind === "divider" ? (
          <ContextMenuSeparator key={`divider-${index}`} />
        ) : (
          <ContextMenuItem
            key={`item-${index}-${item.label}`}
            danger={item.danger}
            disabled={item.disabled === true}
            onSelect={item.onSelect}
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {item.label}
            </span>
            {item.hotkey !== undefined && (
              <ContextMenuShortcut>{item.hotkey}</ContextMenuShortcut>
            )}
          </ContextMenuItem>
        ),
      )}
    </>
  );
}
