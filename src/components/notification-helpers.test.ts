import { describe, it, expect } from "vitest";
import type { ConversationNotification } from "./NotificationsPanel";
import { getItemLabel } from "./notification-helpers";

function makeConversation(
  status: ConversationNotification["status"],
): ConversationNotification {
  return {
    type: "conversation",
    id: "conv-001",
    name: "Test conversation",
    status,
    timestamp: new Date().toISOString(),
    projectName: "my-app",
    sessionName: "test-session",
  };
}

describe("getItemLabel", () => {
  describe("conversation items", () => {
    it('returns "New" for new conversations', () => {
      expect(getItemLabel(makeConversation("new"))).toBe("New");
    });

    it('returns "Running" for running conversations', () => {
      expect(getItemLabel(makeConversation("running"))).toBe("Running");
    });

    it('returns "Awaiting" for awaiting conversations', () => {
      expect(getItemLabel(makeConversation("awaiting"))).toBe("Awaiting");
    });

    it('returns "Needs input" for waiting_for_input conversations', () => {
      expect(getItemLabel(makeConversation("waiting_for_input"))).toBe(
        "Needs input",
      );
    });
  });
});
