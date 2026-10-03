import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef } from "@/lib/intents/schemas";
import type { ConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import type { CoreQuestionRecord } from "./schemas";

const answerWaitRequestSchema = z
  .object({ kind: z.literal("answer"), questionId: z.string().min(1) })
  .passthrough();

export interface ConversationRequestsDeps {
  transaction<T>(fn: () => T): T;
  repo: ConversationCoreRepo;
  touchRequester(owner: OwnerRef): void;
  now(): string;
}

/**
 * Questions seat conversations ask their owner. The question record is the
 * only answer store: a wait is an observation registration keyed by the
 * waiting requester's cause, and one answer consumes its exact question once.
 */
export interface ConversationRequests extends Executor {
  open(input: {
    conversationId: string;
    attemptId: string;
    questionText: string;
    questions: unknown;
  }): string;
  /** Returns false when the question is unknown or no longer open. */
  answer(questionId: string, answer: string): boolean;
  withdrawQuestion(questionId: string): void;
  /** The question a conversation opened during one attempt, if any is still open. */
  openedDuring(conversationId: string, attemptId: string): string | null;
  question(questionId: string): CoreQuestionRecord | null;
}

export function createConversationRequests(deps: ConversationRequestsDeps): ConversationRequests {
  function resolve(questionId: string, state: "answered" | "withdrawn", answer: string | null): boolean {
    const resolved = deps.transaction(() => {
      const question = deps.repo.getQuestion(questionId);
      if (question === null || question.state !== "open") return false;
      deps.repo.resolveQuestion(questionId, { state, answer, answeredAt: deps.now() });
      return true;
    });
    if (resolved) {
      for (const waiter of deps.repo.waitersFor(questionId)) deps.touchRequester(waiter);
    }
    return resolved;
  }

  return {
    open(input) {
      const questionId = randomUUID();
      deps.transaction(() =>
        deps.repo.insertQuestion({
          questionId,
          conversationId: input.conversationId,
          attemptId: input.attemptId,
          questionText: input.questionText,
          questions: input.questions,
          state: "open",
          answer: null,
          createdAt: deps.now(),
          answeredAt: null,
        }),
      );
      return questionId;
    },
    answer(questionId, answer) {
      return resolve(questionId, "answered", answer);
    },
    withdrawQuestion(questionId) {
      resolve(questionId, "withdrawn", null);
    },
    question(questionId) {
      return deps.repo.getQuestion(questionId);
    },
    openedDuring(conversationId, attemptId) {
      const question = deps.repo.questionForAttempt(conversationId, attemptId);
      return question !== null && question.state === "open" ? question.questionId : null;
    },
    submit(intent) {
      const request = answerWaitRequestSchema.parse(intent.request);
      deps.transaction(() =>
        deps.repo.insertWaitIfAbsent({
          cause: intent.cause,
          questionId: request.questionId,
          requester: intent.requester,
          createdAt: deps.now(),
        }),
      );
    },
    outcome(cause): OperationState {
      const wait = deps.repo.getWait(cause);
      if (wait === null) return { kind: "unknown" };
      const question = deps.repo.getQuestion(wait.questionId);
      if (question === null) return { kind: "settled", outcome: { kind: "withdrawn" } };
      switch (question.state) {
        case "open":
          return { kind: "running" };
        case "answered":
          return {
            kind: "settled",
            outcome: { kind: "answered", question: question.questionText, answer: question.answer ?? "" },
          };
        case "withdrawn":
          return { kind: "settled", outcome: { kind: "withdrawn" } };
      }
    },
    withdraw() {
      // A wait is a passive registration; withdrawing it changes nothing durable.
    },
  };
}
