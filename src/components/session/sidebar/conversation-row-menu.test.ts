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

  it("places Regenerate Name immediately after Rename when registered", () => {
    const onRegenerateName = vi.fn();
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
        onRename: vi.fn(),
        onRegenerateName,
        onToggleArchived: vi.fn(),
      },
    );
    const labels = items.flatMap((item) =>
      item.kind === "item" ? [item.label] : [],
    );

    const renameIndex = labels.indexOf("Rename…");
    expect(labels[renameIndex + 1]).toBe("Regenerate Name");

    action(items, "Regenerate Name").onSelect();
    expect(onRegenerateName).toHaveBeenCalledOnce();
  });

  it("hides Regenerate Name when no handler is registered", () => {
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
        onRename: vi.fn(),
        onToggleArchived: vi.fn(),
      },
    );

    expect(
      items.some(
        (item) => item.kind === "item" && item.label === "Regenerate Name",
      ),
    ).toBe(false);
  });
});
