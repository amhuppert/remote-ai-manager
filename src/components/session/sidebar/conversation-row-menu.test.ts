import { describe, expect, it, vi } from "vitest";
import {
  buildConversationRowMenuItems,
  type ConversationRowMenuItem,
} from "./conversation-row-menu";

function action(
  items: readonly ConversationRowMenuItem[],
  label: string,
): Extract<ConversationRowMenuItem, { kind: "item" }> {
  const item = items.find(
    (candidate) => candidate.kind === "item" && candidate.label === label,
  );
  if (!item || item.kind !== "item") {
    throw new Error(`Missing menu action: ${label}`);
  }
  return item;
}

describe("buildConversationRowMenuItems", () => {
  it("does not advertise an unregistered Copy context shortcut", () => {
    const items = buildConversationRowMenuItems(
      {
        scope: "project",
        worktreePath: "/tmp/worktree",
        archived: false,
        approvalGatePending: false,
      },
      {
        onOpenConversation: vi.fn(),
        onOpenProjectPage: vi.fn(),
        onCopyContext: vi.fn(),
        onRename: vi.fn(),
        onToggleArchived: vi.fn(),
      },
    );

    expect(action(items, "Copy context").hotkey).toBeUndefined();
  });
});
