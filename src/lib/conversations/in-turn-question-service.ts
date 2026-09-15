import { randomUUID } from "node:crypto";
import { createInTurnQuestionService } from "./in-turn-questions";
import { IN_TURN_QUESTION_TIMEOUT_MS } from "./in-turn-question-schemas";
import { formatQuestionAnswersBlock } from "./question-answers-block";
import { appendTranscriptEntryOnce } from "@/lib/prompt/transcript";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

export const inTurnQuestionService = getGlobalSingleton(
  "__ccInTurnQuestionService",
  () =>
    createInTurnQuestionService({
      newId: randomUUID,
      timeoutMs: IN_TURN_QUESTION_TIMEOUT_MS,
      async register(scope, questionId, questions) {
        const { registerConversationQuestion } =
          await import("@/lib/workflows/conversation/manager");
        return registerConversationQuestion(
          scope.projectPath,
          scope.sessionName,
          scope.conversationId,
          {
            questionId,
            questions: questions.map((question, index) => ({
              ...question,
              id: question.id ?? String(index),
            })),
          },
        );
      },
      async retire(scope, questionId) {
        const { clearConversationQuestion } =
          await import("@/lib/workflows/conversation/manager");
        if (
          await clearConversationQuestion(
            scope.projectPath,
            scope.sessionName,
            scope.conversationId,
            { questionId },
          )
        )
          return;
        const { mutateConversation } = await import("@/lib/state-store");
        await mutateConversation(
          scope.projectPath,
          scope.sessionName,
          scope.conversationId,
          "question.retire_in_turn",
          (conversation) => {
            if (conversation.pendingQuestionId !== questionId) return;
            conversation.pendingQuestionId = null;
            conversation.pendingQuestions = null;
          },
        );
      },
      async recordAnswer(scope, reply) {
        await appendTranscriptEntryOnce(
          scope.conversationId,
          {
            id: `answer:${reply.questionId}`,
            timestamp: new Date().toISOString(),
            type: "user",
            role: "user",
            content: [
              {
                type: "text",
                text: formatQuestionAnswersBlock(
                  reply.questionId,
                  reply.answers,
                ),
              },
            ],
          },
          undefined,
          {
            projectName: getProjectDisplayName(scope.projectPath),
            storeSessionName: scope.sessionName,
          },
        );
      },
    }),
);
