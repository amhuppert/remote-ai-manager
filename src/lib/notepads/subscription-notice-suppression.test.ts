import { describe, expect, it } from "vitest";
import { createNotepadDeliveryTracker } from "./change-notices";
import { subscriptionOwnedNotepadIds } from "@/lib/workflows/conversation/pre-turn/passive-subscription-context";

function tracker() {
  return createNotepadDeliveryTracker({
    now: () => "2026-09-30T10:00:00Z",
    watermarks: {
      record: async (input) => input,
      listForConversation: async () => [
        {
          conversationId: "c",
          notepadId: "owned",
          revision: 1,
          openComments: { count: 0, latestCreatedAt: null },
          updatedAt: "2026-09-29T10:00:00Z",
        },
      ],
    },
    readDeliveryState: async () => ({
      id: "owned",
      name: "Owned notes",
      revision: 2,
      authorKind: "user",
      openComments: { count: 1, latestCreatedAt: "2026-09-30T09:00:00Z" },
    }),
  });
}

describe("subscription ownership of legacy notepad notices", () => {
  it("keeps independent comment notices when subscriptions own content revisions", async () => {
    const notice = await tracker().prepare("c", [], ["owned"]);
    expect(notice.block).toContain("changed: comments");
    expect(notice.block).not.toContain("changed: content");
    expect(notice.advances).toHaveLength(1);
  });

  it("keeps both content and comments for notepads outside subscription ownership", async () => {
    const notice = await tracker().prepare("c");
    expect(notice.block).toContain("changed: content, comments");
  });

  it("never resumes legacy content notices after explicit unfollow or expiry", async () => {
    for (const record of [
      {
        source: { kind: "notepad" as const, id: "owned" },
        status: "unfollowed",
        expiresAt: null,
      },
      {
        source: { kind: "notepad" as const, id: "owned" },
        status: "following",
        expiresAt: "2026-09-29T00:00:00Z",
      },
    ]) {
      const notice = await tracker().prepare(
        "c",
        [],
        subscriptionOwnedNotepadIds([record]),
      );
      expect(notice.block).toContain("changed: comments");
      expect(notice.block).not.toContain("changed: content");
    }
  });
});
