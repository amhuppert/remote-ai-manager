import { describe, expect, it } from "vitest";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { ownerChoicesOf } from "./owner-choices";

const idle = makeConversationState({
  id: "c-idle",
  name: "Release review",
  lastActivityAt: "2026-10-12T10:00:00.000Z",
});
const busy = makeConversationState({
  id: "c-busy",
  status: "running",
  agentBackend: "codex",
  lastActivityAt: "2026-10-13T10:00:00.000Z",
});
const seat = makeConversationState({ id: "c-seat", role: "iteration" });
const archived = makeConversationState({ id: "c-archived", archived: true });
const owned = makeConversationState({
  id: "c-owned",
  owner: { kind: "collaboration", workflowId: "collab-1", attemptEpoch: 0 },
});

describe("owner choices", () => {
  it("offers the session's eligible conversations, most recently active first", () => {
    expect(ownerChoicesOf([idle, busy, seat, archived, owned], false)).toEqual([
      {
        conversationId: "c-busy",
        title: "Untitled conversation",
        backend: "codex",
        busy: true,
      },
      {
        conversationId: "c-idle",
        title: "Release review",
        backend: "claude",
        busy: false,
      },
    ]);
  });

  it("offers none in an archived session", () => {
    expect(ownerChoicesOf([idle, busy], true)).toEqual([]);
  });
});
