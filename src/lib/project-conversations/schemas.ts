import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";

export const createProjectConversationRequestSchema = z.object({
  // Defaults via config when omitted.
  agentBackend: agentBackendSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
});
export type CreateProjectConversationRequest = z.infer<
  typeof createProjectConversationRequestSchema
>;

export const projectConversationOpenRequestSchema = z.object({
  open: z.boolean(),
});
export type ProjectConversationOpenRequest = z.infer<
  typeof projectConversationOpenRequestSchema
>;
