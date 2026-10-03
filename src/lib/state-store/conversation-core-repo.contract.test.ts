import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  attemptRecordSchema,
  coreQuestionRecordSchema,
  mailboxItemRecordSchema,
  seatBindingRecordSchema,
} from "@/lib/conversation-core/schemas";
import { createConversationCoreRepo } from "./conversation-core-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const at = "2026-10-03T10:00:00.000Z";
const later = "2026-10-03T10:05:00.000Z";

describe("conversation core repository", () => {
  it("round-trips a seat binding with its continuity handle", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    await assertRoundTripDurability({
      label: "seat binding",
      schema: seatBindingRecordSchema,
      buildMaximalFixture: () => ({
        conversationId: "conv-1",
        contextId: "ctx-1",
        assignmentId: "reviewer-a",
        replacement: 2,
        role: "reviewer" as const,
        projectPath: "/repo",
        sessionName: "session",
        backend: "codex" as const,
        backendRef: "thread-9",
        createdAt: at,
        updatedAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertSeat(value);
        return value;
      },
      reload: (value) => createConversationCoreRepo(db).getSeat(value.conversationId),
    });
  });

  it("round-trips a consumed mailbox item with its permit", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    await assertRoundTripDurability({
      label: "mailbox item",
      schema: mailboxItemRecordSchema,
      buildMaximalFixture: () => ({
        cause: "ctx-1:work:3",
        conversationId: "conv-1",
        requester: { kind: "context" as const, id: "ctx-1" },
        request: { kind: "work", message: "Do it" },
        permit: { controllerId: "context:ctx-1", generation: 2 },
        state: "consumed" as const,
        attemptId: "att-1",
        createdAt: at,
        updatedAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertMailboxIfAbsent(value);
        return value;
      },
      reload: (value) => createConversationCoreRepo(db).getMailbox(value.cause),
    });
  });

  it("round-trips a settled attempt with its report", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    await assertRoundTripDurability({
      label: "attempt",
      schema: attemptRecordSchema,
      buildMaximalFixture: () => ({
        attemptId: "att-1",
        conversationId: "conv-1",
        cause: "ctx-1:work:3",
        state: "settled" as const,
        outcome: {
          status: "failed" as const,
          conversationId: "conv-1",
          finalText: "partial",
          structuredOutput: { a: 1 },
          outputIssue: "missing field",
          openQuestionId: "q-1",
          failure: "provider error",
        },
        openedAt: at,
        settledAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertAttempt(value);
        return value;
      },
      reload: (value) => createConversationCoreRepo(db).getAttempt(value.attemptId),
    });
  });

  it("round-trips an answered question", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    await assertRoundTripDurability({
      label: "core question",
      schema: coreQuestionRecordSchema,
      buildMaximalFixture: () => ({
        questionId: "q-1",
        conversationId: "conv-1",
        attemptId: "att-1",
        questionText: "Which file?",
        questions: [{ question: "Which file?", options: ["a", "b"] }],
        state: "answered" as const,
        answer: "a",
        createdAt: at,
        answeredAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertQuestion(value);
        return value;
      },
      reload: (value) => createConversationCoreRepo(db).getQuestion(value.questionId),
    });
  });
});
