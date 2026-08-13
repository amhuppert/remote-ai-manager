import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SpecReviewFeedbackNotice } from "@/lib/specs/review-service";

import {
  createSpecReviewFeedbackNotifier,
  type SpecReviewFeedbackConversation,
} from "./spec-review-feedback";

function notice(
  overrides: Partial<SpecReviewFeedbackNotice> = {},
): SpecReviewFeedbackNotice {
  return {
    specId: "spec-1",
    specSlug: "review-feedback",
    specName: "Review feedback",
    projectPath: "/repos/review-feedback",
    revisionId: "revision-1",
    kind: "commented",
    subject: "fb-r1",
    threadId: "thread-1",
    proposer: { kind: "agent", conversationId: "conversation-1" },
    occurredAt: "2026-08-12T10:00:01.000Z",
    ...overrides,
  };
}

const SESSION_CONVERSATION: SpecReviewFeedbackConversation = {
  projectName: "Review Feedback",
  projectPath: "/repos/review-feedback",
  scope: "session",
  sessionName: "feature-session",
};

interface AppendedTranscriptNotice {
  conversationId: string;
  text: string;
  projectName: string;
  storeSessionName: string;
}

interface AppendedAgentNotice {
  projectPath: string;
  storeSessionName: string;
  conversationId: string;
  text: string;
}

let transcriptNotices: AppendedTranscriptNotice[];
let agentNotices: AppendedAgentNotice[];

function buildNotifier(
  found: SpecReviewFeedbackConversation | null,
  overrides: Partial<{
    appendNotice(input: AppendedTranscriptNotice): Promise<void>;
    appendPendingAgentNotice(input: AppendedAgentNotice): Promise<void>;
  }> = {},
) {
  return createSpecReviewFeedbackNotifier({
    async findConversationById() {
      return found;
    },
    async appendNotice(input) {
      transcriptNotices.push(input);
    },
    async appendPendingAgentNotice(input) {
      agentNotices.push(input);
    },
    ...overrides,
  });
}

beforeEach(() => {
  transcriptNotices = [];
  agentNotices = [];
});

describe("createSpecReviewFeedbackNotifier", () => {
  it("appends both the transcript notice and the pending agent notice with the exact read", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toHaveLength(1);
    expect(transcriptNotices[0]).toMatchObject({
      conversationId: "conversation-1",
      projectName: "Review Feedback",
      storeSessionName: "feature-session",
    });
    expect(transcriptNotices[0]!.text).toContain(
      "cctl spec comments review-feedback --open",
    );
    expect(transcriptNotices[0]!.text).toContain("fb-r1");
    expect(agentNotices).toHaveLength(1);
    expect(agentNotices[0]).toMatchObject({
      projectPath: "/repos/review-feedback",
      storeSessionName: "feature-session",
      conversationId: "conversation-1",
    });
    // The agent reads the same words the human sees in the transcript.
    expect(agentNotices[0]!.text).toBe(transcriptNotices[0]!.text);
  });

  it("tells the reopened-draft story for changes_requested", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(
      notice({ kind: "changes_requested", subject: null, threadId: null }),
    );

    expect(transcriptNotices).toHaveLength(1);
    const text = transcriptNotices[0]!.text;
    expect(text).toContain("Changes requested on spec review-feedback");
    expect(text).toContain("cctl spec comments review-feedback --open");
    expect(text).toContain("propose again");
  });

  it("reports a sign-off without a next read", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(
      notice({ kind: "signed_off", subject: null, threadId: null }),
    );

    expect(transcriptNotices).toHaveLength(1);
    expect(transcriptNotices[0]!.text).toContain("signed off");
    expect(agentNotices).toHaveLength(1);
  });

  it("stores the project sentinel session for a project-scope conversation", async () => {
    const notifier = buildNotifier({
      projectName: "Review Feedback",
      projectPath: "/repos/review-feedback",
      scope: "project",
    });

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toHaveLength(1);
    expect(agentNotices).toHaveLength(1);
    // Both halves address the same store session; a project conversation is
    // stored under the sentinel, never a real session name.
    expect(transcriptNotices[0]!.storeSessionName).toBe(
      agentNotices[0]!.storeSessionName,
    );
    expect(transcriptNotices[0]!.storeSessionName).not.toBe("feature-session");
  });

  it("does nothing when the notice carries no proposer", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(notice({ proposer: null }));

    expect(transcriptNotices).toHaveLength(0);
    expect(agentNotices).toHaveLength(0);
  });

  it("does nothing when the conversation no longer exists", async () => {
    const notifier = buildNotifier(null);

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toHaveLength(0);
    expect(agentNotices).toHaveLength(0);
  });

  it("still appends the agent notice and never throws when the transcript append fails", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION, {
      async appendNotice() {
        throw new Error("transcript unavailable");
      },
    });

    await expect(notifier.reviewFeedback(notice())).resolves.toBeUndefined();

    expect(agentNotices).toHaveLength(1);
  });

  it("never throws when the conversation lookup itself fails", async () => {
    const notifier = createSpecReviewFeedbackNotifier({
      async findConversationById() {
        throw new Error("store offline");
      },
      async appendNotice(input) {
        transcriptNotices.push(input);
      },
      async appendPendingAgentNotice(input) {
        agentNotices.push(input);
      },
    });

    await expect(notifier.reviewFeedback(notice())).resolves.toBeUndefined();

    expect(transcriptNotices).toHaveLength(0);
    expect(agentNotices).toHaveLength(0);
  });
});
