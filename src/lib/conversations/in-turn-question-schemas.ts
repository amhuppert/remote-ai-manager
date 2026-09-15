import { z } from "zod";
import { askQuestionItemSchema, answerQuestionRequestSchema } from "./schemas";

export const IN_TURN_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
export const inTurnQuestionBatchSchema = z.object({
  questions: z.array(askQuestionItemSchema).min(1).max(3),
});
export const inTurnQuestionReplySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    answers: answerQuestionRequestSchema.shape.answers,
  }),
  z.object({
    status: z.enum(["cancelled", "expired", "unavailable"]),
    message: z.string(),
  }),
]);
export type InTurnQuestionReply = z.infer<typeof inTurnQuestionReplySchema>;
