import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SpecReviewFeedbackNotice } from "@/lib/specs/review-service";
import type { RecordSubscriptionNoticeInput } from "@/lib/subscriptions/service";
import { projectSpecSourceFact } from "@/lib/subscriptions/source-adapters";
import { createSubscriptionRuntime } from "@/lib/subscriptions/service-factory";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createSpecReviewFeedbackNotifier,
  type SpecReviewFeedbackConversation,
} from "./spec-review-feedback";

function notice(
  overrides: Partial<SpecReviewFeedbackNotice> = {},
): SpecReviewFeedbackNotice {
  const kind = overrides.kind ?? "commented";
  return {
    specId: "spec-1",
    specSlug: "review-feedback",
    specName: "Review feedback",
    projectPath: "/repos/review-feedback",
    revisionId: "revision-1",
    kind,
    subject: "fb-r1",
    threadId: "thread-1",
    proposer: { kind: "agent", conversationId: "conversation-1" },
    occurredAt: "2026-08-12T10:00:01.000Z",
    durableEvent: {
      id: 12,
      spec_id: "spec-1",
      event_type:
        kind === "commented"
          ? "spec-review-commented"
          : "spec-review-revision-signed-off",
      actor_json: JSON.stringify({ kind: "human" }),
      payload_json: JSON.stringify({
        kind: kind === "commented" ? "commented" : "signed-off",
        revisionId: "revision-1",
        subjectId: "thread-1",
      }),
      occurred_at: "2026-08-12T10:00:01.000Z",
    },
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

let transcriptNotices: AppendedTranscriptNotice[];
let agentNotices: RecordSubscriptionNoticeInput[];

function buildNotifier(
  found: SpecReviewFeedbackConversation | null,
  overrides: Partial<{
    appendNotice(input: AppendedTranscriptNotice): Promise<void>;
    recordNotice(input: RecordSubscriptionNoticeInput): Promise<boolean>;
  }> = {},
) {
  return createSpecReviewFeedbackNotifier({
    async findConversationById() {
      return found;
    },
    async appendNotice(input) {
      transcriptNotices.push(input);
    },
    async recordNotice(input) {
      agentNotices.push(input);
      return true;
    },
    ...overrides,
  });
}

beforeEach(() => {
  transcriptNotices = [];
  agentNotices = [];
});

describe("createSpecReviewFeedbackNotifier", () => {
  it("records the canonical spec occurrence used by passive follows", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);
    await notifier.reviewFeedback(notice());

    expect(agentNotices).toEqual([
      expect.objectContaining({
        recipient: {
          projectPath: "/repos/review-feedback",
          conversationId: "conversation-1",
        },
        source: { kind: "spec", id: "spec-1" },
        fact: expect.objectContaining({
          occurrenceId: "12",
          eventKind: "spec-review-commented",
          revision: "revision-1",
        }),
      }),
    ]);
  });

  it("keeps the transcript notice and canonical source fact independently available", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toHaveLength(1);
    expect(transcriptNotices[0]).toMatchObject({
      conversationId: "conversation-1",
      projectName: "Review Feedback",
      storeSessionName: "feature-session",
    });
    expect(transcriptNotices[0]?.text).toContain(
      "cctl spec comments review-feedback --open",
    );
    expect(transcriptNotices[0]?.text).toContain("fb-r1");
    expect(agentNotices).toHaveLength(1);
    expect(agentNotices[0]).toMatchObject({
      recipient: {
        projectPath: "/repos/review-feedback",
        conversationId: "conversation-1",
      },
      source: { kind: "spec", id: "spec-1" },
    });
    const feedback = notice();
    expect(agentNotices[0]?.fact).toEqual(
      projectSpecSourceFact({
        event: feedback.durableEvent,
        spec: {
          name: feedback.specName,
          slug: feedback.specSlug,
          projectPath: feedback.projectPath,
        },
      }),
    );
    expect(agentNotices[0]?.fact.retrievalHandle).toContain(
      "cctl spec comments",
    );
    expect(agentNotices[0]?.fact.retrievalHandle).toContain("--open");
  });

  it("reports a sign-off without a next read", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION);

    await notifier.reviewFeedback(
      notice({ kind: "signed_off", subject: null, threadId: null }),
    );

    expect(transcriptNotices).toHaveLength(1);
    expect(transcriptNotices[0]?.text).toContain("signed off");
    expect(agentNotices).toHaveLength(1);
    expect(agentNotices[0]?.fact.eventKind).toBe(
      "spec-review-revision-signed-off",
    );
  });

  it("uses the same source and recipient contract for a project conversation", async () => {
    const notifier = buildNotifier({
      projectName: "Review Feedback",
      projectPath: "/repos/review-feedback",
      scope: "project",
    });

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toHaveLength(1);
    expect(agentNotices).toHaveLength(1);
    expect(agentNotices[0]?.recipient).toEqual({
      projectPath: "/repos/review-feedback",
      conversationId: "conversation-1",
    });
    expect(agentNotices[0]?.source).toEqual({ kind: "spec", id: "spec-1" });
    expect(transcriptNotices[0]?.storeSessionName).not.toBe("feature-session");
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

  it("refuses feedback whose author conversation belongs to another project", async () => {
    const notifier = buildNotifier({
      ...SESSION_CONVERSATION,
      projectPath: "/repos/other-project",
    });

    await notifier.reviewFeedback(notice());

    expect(transcriptNotices).toEqual([]);
    expect(agentNotices).toEqual([]);
  });

  it("still records the agent notice when the transcript append fails", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION, {
      async appendNotice() {
        throw new Error("transcript unavailable");
      },
    });

    await expect(notifier.reviewFeedback(notice())).resolves.toBeUndefined();

    expect(agentNotices).toHaveLength(1);
  });

  it("keeps the human transcript notice when durable fact recording fails", async () => {
    const notifier = buildNotifier(SESSION_CONVERSATION, {
      async recordNotice() {
        throw new Error("inbox temporarily unavailable");
      },
    });

    await expect(notifier.reviewFeedback(notice())).resolves.toBeUndefined();
    expect(transcriptNotices).toHaveLength(1);
  });

  it("never throws when the conversation lookup itself fails", async () => {
    const notifier = createSpecReviewFeedbackNotifier({
      async findConversationById() {
        throw new Error("store offline");
      },
      async appendNotice(input) {
        transcriptNotices.push(input);
      },
      async recordNotice(input) {
        agentNotices.push(input);
        return true;
      },
    });

    await expect(notifier.reviewFeedback(notice())).resolves.toBeUndefined();

    expect(transcriptNotices).toHaveLength(0);
    expect(agentNotices).toHaveLength(0);
  });
});

let persistence: PersistenceFixture | undefined;
afterEach(() => persistence?.close());

async function durableNotifierFixture(scope: "session" | "project") {
  const fixture = createPersistenceFixture();
  persistence = fixture;
  const feedback = notice();
  const recipient = {
    projectPath: feedback.projectPath,
    conversationId: "conversation-1",
  };
  fixture.seedProject(recipient.projectPath);
  const conversation = makeConversationState({ id: recipient.conversationId });
  if (scope === "session") {
    fixture.seedSession(recipient.projectPath, "feature-session");
    await fixture.seedConversation(
      recipient.projectPath,
      "feature-session",
      conversation,
    );
  } else {
    await fixture.seedProjectConversation(recipient.projectPath, conversation);
  }
  await fixture.specs.create({
    spec: {
      id: feedback.specId,
      projectPath: feedback.projectPath,
      slug: feedback.specSlug,
      name: feedback.specName,
      gatePolicy: { preset: "contract-bearing" },
      createdAt: feedback.occurredAt,
      updatedAt: feedback.occurredAt,
    },
    initialRevision: {
      id: feedback.revisionId,
      authoringStage: "requirements",
      createdAt: feedback.occurredAt,
    },
  });
  const events = createSpecEventsRepo(fixture.db);
  const { id: _eventId, ...eventInput } = feedback.durableEvent;
  const baseline = events.append({
    ...eventInput,
    payload_json: JSON.stringify({ kind: "older-comment" }),
  });
  feedback.durableEvent = events.append(eventInput);
  const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
  const found: SpecReviewFeedbackConversation =
    scope === "session"
      ? SESSION_CONVERSATION
      : {
          scope,
          projectName: "Review Feedback",
          projectPath: recipient.projectPath,
        };
  const notifier = createSpecReviewFeedbackNotifier({
    async findConversationById() {
      return found;
    },
    async appendNotice(input) {
      transcriptNotices.push(input);
    },
    recordNotice: runtime.service.recordNotice,
  });
  return { fixture, feedback, recipient, runtime, notifier, baseline };
}

describe.each(["session", "project"] as const)(
  "durable spec feedback (%s)",
  (scope) => {
    it.each(["notice", "follow"] as const)(
      "deduplicates the canonical event when %s records first and settles on acceptance",
      async (first) => {
        const h = await durableNotifierFixture(scope);
        if (first === "follow") {
          await h.runtime.service.autoFollow({
            recipient: h.recipient,
            source: { kind: "spec", id: h.feedback.specId },
            reason: "Spec authored by this conversation",
            initialCursor: String(h.baseline.id),
          });
          await h.runtime.service.reconcile(h.recipient);
        }
        await h.notifier.reviewFeedback(h.feedback);
        await h.notifier.reviewFeedback(h.feedback);
        await h.runtime.service.reconcile(h.recipient);

        const reloaded = createSubscriptionRuntime(
          h.fixture.db,
          createWriteQueue(),
        );
        const inbox = await reloaded.repo.readInbox(h.recipient, {});
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0]).toMatchObject({
          state: "pending",
          fact: {
            occurrenceId: String(h.feedback.durableEvent.id),
            eventKind: "spec-review-commented",
          },
        });
        const briefing = await reloaded.service.prepareBriefing({
          recipient: h.recipient,
          attemptId: "user-message-1",
        });
        expect(briefing.block).toContain("spec-review-commented");
        expect(briefing.block).not.toContain("older-comment");
        expect(
          (await reloaded.repo.readInbox(h.recipient, {})).items[0]?.state,
        ).toBe("queued");
        await briefing.onInputAccepted();
        await briefing.finish();
        await h.notifier.reviewFeedback(h.feedback);
        expect(
          (
            await reloaded.repo.readInbox(h.recipient, {
              includeSettled: true,
            })
          ).items,
        ).toEqual([expect.objectContaining({ state: "accepted" })]);
        expect(
          (
            await reloaded.service.prepareBriefing({
              recipient: h.recipient,
              attemptId: "user-message-2",
            })
          ).block,
        ).toBeNull();
      },
    );

    it("recovers a failed immediate recording from an existing follow without replaying its baseline", async () => {
      const h = await durableNotifierFixture(scope);
      await h.runtime.service.autoFollow({
        recipient: h.recipient,
        source: { kind: "spec", id: h.feedback.specId },
        reason: "Spec authored by this conversation",
        initialCursor: String(h.baseline.id),
      });
      h.fixture.db.exec(`CREATE TEMP TRIGGER reject_notice
        BEFORE INSERT ON conversation_subscription_deliveries
        BEGIN SELECT RAISE(ABORT, 'inbox temporarily unavailable'); END`);
      await h.notifier.reviewFeedback(h.feedback);
      expect(transcriptNotices).toHaveLength(1);
      expect((await h.runtime.repo.readInbox(h.recipient, {})).total).toBe(0);
      h.fixture.db.exec("DROP TRIGGER reject_notice");

      const recovered = createSubscriptionRuntime(
        h.fixture.db,
        createWriteQueue(),
      );
      const briefing = await recovered.service.prepareBriefing({
        recipient: h.recipient,
        attemptId: "recovered-user-message",
      });
      expect(briefing.block).toContain("spec-review-commented");
      expect(briefing.block).not.toContain("older-comment");
      expect((await recovered.repo.readInbox(h.recipient, {})).items).toEqual([
        expect.objectContaining({
          fact: expect.objectContaining({
            occurrenceId: String(h.feedback.durableEvent.id),
          }),
        }),
      ]);
      await briefing.onInputAccepted();
      await briefing.finish();
    });
  },
);
