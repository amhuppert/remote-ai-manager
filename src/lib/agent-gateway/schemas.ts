import { z } from "zod";

export const conversationIdentitySchema = z.object({
  sessionName: z.string().min(1),
  conversationId: z.string().min(1),
});

export const laneIdentitySchema = z.object({
  laneKind: z.literal("implementer"),
  executionId: z.string().min(1),
  contextId: z.string().min(1),
  conversationId: z.string().min(1),
});
