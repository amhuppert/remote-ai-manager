import { describe, it, expect } from "vitest";
import type {
  ConversationNotification,
  CommitNotification,
} from "./NotificationsPanel";
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

const commitBase: Omit<CommitNotification, "status" | "phase"> = {
  type: "commit",
  id: "job-001",
  timestamp: new Date().toISOString(),
  projectName: "my-app",
  sessionName: "test-session",
  branchName: "csm/test-session",
};

function makeCommit(
  status: CommitNotification["status"],
  phase?: string,
): CommitNotification {
  return { ...commitBase, status, phase };
}

describe("getItemLabel", () => {
  describe("commit items", () => {
    it('returns "Committing..." for running with no phase', () => {
      expect(getItemLabel(makeCommit("running"))).toBe("Committing...");
    });

    it('returns "Committing..." for committing phase', () => {
      expect(getItemLabel(makeCommit("running", "committing"))).toBe(
        "Committing...",
      );
    });

    it('returns "Validating..." for validating phase', () => {
      expect(getItemLabel(makeCommit("running", "validating"))).toBe(
        "Validating...",
      );
    });

    it('returns "Validating..." for re-validating phase', () => {
      expect(getItemLabel(makeCommit("running", "re-validating"))).toBe(
        "Validating...",
      );
    });

    it('returns "Fixing errors..." for fixing-validation phase', () => {
      expect(getItemLabel(makeCommit("running", "fixing-validation"))).toBe(
        "Fixing errors...",
      );
    });

    it('returns "Committed" for success', () => {
      expect(getItemLabel(makeCommit("success"))).toBe("Committed");
    });

    it('returns "Commit failed" for error', () => {
      expect(getItemLabel(makeCommit("error"))).toBe("Commit failed");
    });
  });

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
