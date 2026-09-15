import type { AskQuestionItem, AnswerQuestionRequest } from "./schemas";
import { createLogger } from "@/lib/logging";
import type { InTurnQuestionReply } from "./in-turn-question-schemas";

const logger = createLogger("in-turn-questions");

export interface InTurnQuestionScope {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface InTurnQuestionDeps {
  register(
    scope: InTurnQuestionScope,
    questionId: string,
    questions: AskQuestionItem[],
  ): Promise<boolean>;
  retire(scope: InTurnQuestionScope, questionId: string): Promise<void>;
  recordAnswer(
    scope: InTurnQuestionScope,
    reply: AnswerQuestionRequest,
  ): Promise<void>;
  newId(): string;
  timeoutMs: number;
}

export function isInTurnQuestionId(id: string | null | undefined): boolean {
  return id?.startsWith("cc-in-turn-") ?? false;
}

export function createInTurnQuestionService(deps: InTurnQuestionDeps) {
  const pending = new Map<
    string,
    {
      scope: InTurnQuestionScope;
      answering: boolean;
      signal: AbortSignal;
      registered: Promise<boolean>;
      settle(reply: InTurnQuestionReply): Promise<boolean>;
    }
  >();

  return {
    async request(
      scope: InTurnQuestionScope,
      questions: AskQuestionItem[],
      signal: AbortSignal,
    ): Promise<InTurnQuestionReply> {
      if (signal.aborted)
        return { status: "cancelled", message: "The requesting run stopped" };
      const questionId = `cc-in-turn-${deps.newId()}`;
      const result = Promise.withResolvers<InTurnQuestionReply>();
      const registered = deps.register(scope, questionId, questions);
      const onAbort = () => {
        void settle({
          status: "cancelled",
          message: "The requesting run stopped",
        });
      };
      const timer = setTimeout(() => {
        void settle({
          status: "expired",
          message: "The question expired; continue with best judgment",
        });
      }, deps.timeoutMs);
      const settle = async (reply: InTurnQuestionReply) => {
        if (!pending.delete(questionId)) return false;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        try {
          if (await registered) await deps.retire(scope, questionId);
        } catch {
          logger.error("question.retirement_failed", {
            conversationId: scope.conversationId,
            questionId,
          });
          if (reply.status === "answered") {
            reply = {
              status: "unavailable",
              message: "The question could not be retired",
            };
          }
        } finally {
          logger.info("question.settled", {
            conversationId: scope.conversationId,
            questionId,
            status: reply.status,
          });
          result.resolve(reply);
        }
        return reply.status === "answered";
      };
      pending.set(questionId, {
        scope,
        answering: false,
        signal,
        registered,
        settle,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void registered.then(
        (accepted) => {
          if (accepted) {
            logger.info("question.registered", {
              conversationId: scope.conversationId,
              questionId,
            });
            return;
          }
          return settle({
            status: "unavailable",
            message: "Another question is pending or this run cannot ask",
          });
        },
        () =>
          settle({
            status: "unavailable",
            message: "The question could not be registered",
          }),
      );
      return result.promise;
    },
    async answer(
      scope: InTurnQuestionScope,
      reply: AnswerQuestionRequest,
    ): Promise<boolean> {
      const request = pending.get(reply.questionId);
      if (
        !request ||
        request.answering ||
        request.signal.aborted ||
        request.scope.projectPath !== scope.projectPath ||
        request.scope.sessionName !== scope.sessionName ||
        request.scope.conversationId !== scope.conversationId
      )
        return false;
      request.answering = true;
      try {
        if (
          !(await request.registered) ||
          pending.get(reply.questionId) !== request
        )
          return false;
        await deps.recordAnswer(scope, reply);
        if (request.signal.aborted || pending.get(reply.questionId) !== request)
          return false;
        return await request.settle({
          status: "answered",
          answers: reply.answers,
        });
      } catch {
        await request.settle({
          status: "unavailable",
          message: "The answer could not be persisted",
        });
        return false;
      }
    },
  };
}
