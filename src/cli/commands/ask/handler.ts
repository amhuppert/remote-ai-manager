import {
  mutation,
  recoveryFacts,
  writeRunner,
  type MutationHandler,
} from "cli-for-agents";
import { instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import {
  askQuestionsBodySchema,
  type AskQuestionsBody,
} from "@/lib/conversations/schemas";
import { cliRequest, type ConversationTargetContext } from "../../transport";
import {
  resolveCcConversationTarget,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccWriteFailure } from "../../framework/request";
import type { askSpec } from "./definitions";

type Handler = MutationHandler<
  typeof askSpec,
  CcApplication,
  ConversationTargetContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  AskQuestionsBody
>;
const responseSchema = z.object({
  ok: z.literal(true),
  questionBatchId: z.string().min(1),
});
const handoff = instruction(
  "cc-question-handoff",
  "End your turn now with a brief handoff note (what you asked, what you'll do with the answer). The answer will arrive as your next user message.",
);

const handler: Handler = {
  decode: askQuestionsBodySchema,
  prepare: ({ app }) => resolveCcConversationTarget(app),
  commit: writeRunner<
    Parameters<Handler["commit"]>[0],
    { questionBatchId: string },
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const context = prepared.value;
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: `${conversationTargetApiBase(context.target)}/ask`,
        body: payload,
      });
      const targetRecovery = recoveryFacts([
        { kind: "conversation", id: context.target.conversationId },
      ]);
      if (response.kind !== "ok")
        return ccWriteFailure(response, targetRecovery);
      const parsed = responseSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          effect: "unknown",
          recovery: targetRecovery,
          result: {
            ok: false,
            error: ccErrors.error("CC_INVALID_RESPONSE", {
              message:
                "The ask endpoint did not return a question batch receipt.",
            }),
          },
        };
      }
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "question-batch", id: parsed.data.questionBatchId },
        ]),
        result: {
          ok: true,
          data: { questionBatchId: parsed.data.questionBatchId },
          instruction: handoff,
        },
      };
    },
    text: (data) =>
      `Question batch ${data.questionBatchId} registered. The user has been notified.\n`,
  }),
};

export default mutation(handler);
