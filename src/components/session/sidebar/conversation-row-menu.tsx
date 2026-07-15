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
