import { afterEach, describe, expect, it } from "vitest";
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
        createdAt: at,
        updatedAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertSeat(value);
        return value;
      },
      reload: (value) =>
        createConversationCoreRepo(db).getSeat(value.conversationId),
    });
  });

  it("lists every seat a context's assignments held, replaced incarnations included, in order", () => {
    fixture = createPersistenceFixture();
    const repo = createConversationCoreRepo(fixture.db);
    const seat = (
      conversationId: string,
      contextId: string,
      assignmentId: string,
      replacement: number,
    ) => ({
      conversationId,
      contextId,
      assignmentId,
      replacement,
      role:
        assignmentId === "implementer"
          ? ("implementer" as const)
          : ("reviewer" as const),
      projectPath: "/repo",
      sessionName: "session",
      backend: "claude" as const,
      createdAt: at,
      updatedAt: later,
    });
    repo.insertSeat(seat("conv-r", "ctx-1", "reviewer-a", 0));
    repo.insertSeat(seat("conv-i2", "ctx-1", "implementer", 1));
    repo.insertSeat(seat("conv-other", "ctx-2", "implementer", 0));
    repo.insertSeat(seat("conv-i1", "ctx-1", "implementer", 0));

    expect(repo.seatsOfContext("ctx-1").map((s) => s.conversationId)).toEqual([
      "conv-i1",
      "conv-i2",
      "conv-r",
    ]);
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

  it("persists a user message, which has no supervising requester or permit", () => {
    fixture = createPersistenceFixture();
    const item = {
      cause: "user:conv-9:1",
      conversationId: "conv-9",
      requester: null,
      request: { kind: "user_message", text: "Hello" },
      permit: null,
      state: "queued" as const,
      attemptId: null,
      createdAt: at,
      updatedAt: later,
    };
    createConversationCoreRepo(fixture.db).insertMailboxIfAbsent(item);
    expect(
      createConversationCoreRepo(fixture.db).getMailbox(item.cause),
    ).toEqual(item);
  });

  it("lists a conversation's queued items in arrival order, and refuses a malformed one rather than dropping it", () => {
    const persistence = createPersistenceFixture();
    fixture = persistence;
    const repo = createConversationCoreRepo(persistence.db);
    const item = (cause: string, createdAt: string) => ({
      cause,
      conversationId: "conv-9",
      requester: null,
      request: { kind: "user_message", text: cause },
      permit: null,
      state: "queued" as const,
      attemptId: null,
      createdAt,
      updatedAt: createdAt,
    });
    repo.insertMailboxIfAbsent(item("second", later));
    repo.insertMailboxIfAbsent(item("first", at));
    repo.insertMailboxIfAbsent(item("first", at));
    expect(
      createConversationCoreRepo(persistence.db)
        .queuedFor("conv-9")
        .map((queued) => queued.cause),
    ).toEqual(["first", "second"]);

    // Only a duplicate cause is ignored: a row the table refuses (here, a table
    // still requiring a requester) must not pass as accepted.
    persistence.db.exec(`DROP TABLE core_mailbox;
      CREATE TABLE core_mailbox (cause TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        requester_kind TEXT NOT NULL, requester_id TEXT NOT NULL, request_json TEXT NOT NULL,
        permit_controller_id TEXT, permit_generation INTEGER, state TEXT NOT NULL, attempt_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    expect(() =>
      createConversationCoreRepo(persistence.db).insertMailboxIfAbsent(
        item("third", later),
      ),
    ).toThrow(/NOT NULL/);
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
      reload: (value) =>
        createConversationCoreRepo(db).getAttempt(value.attemptId),
    });
  });

  it("round-trips a custody attempt settled with how its custody ended", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    await assertRoundTripDurability({
      label: "custody attempt",
      schema: attemptRecordSchema,
      buildMaximalFixture: () => ({
        attemptId: "att-custody",
        conversationId: "conv-1",
        cause: "custody:att-1",
        state: "settled" as const,
        outcome: { kind: "custody" as const, end: "timed_out" as const },
        openedAt: at,
        settledAt: later,
      }),
      persist: (value) => {
        createConversationCoreRepo(db).insertAttempt(value);
        return value;
      },
      reload: (value) =>
        createConversationCoreRepo(db).getAttempt(value.attemptId),
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
      reload: (value) =>
        createConversationCoreRepo(db).getQuestion(value.questionId),
    });
  });
});
