import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { runPromptRequestSchema } from "@/lib/prompt/schemas";
import { conversationProfileSelectionSchema } from "@/lib/conversations/schemas";

export const createProjectConversationRequestSchema = z.object({
  // Defaults via config when omitted.
  agentBackend: agentBackendSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  // Runtime (backend) and identity (profile) are separate selections, and the
  // Standard Agent default applies when the picker sends nothing (R7).
  profile: conversationProfileSelectionSchema.optional(),
});

/**
 * Create-and-send body: a prompt request plus the token identifying the
 * submission. The conversation created for it records the token, which is how
 * the posting client recognises its own conversation in the project conversation
 * list — the list reports which conversations exist, never which submission
 * created one. Optional: a client with no unnamed turn to correlate (a script,
 * `cctl`) simply omits it.
 */
export const projectFirstPromptRequestSchema = runPromptRequestSchema.and(
  z.object({
    creationRequestId: z.string().trim().min(1).optional(),
    // This entry is a creation path, so it carries the same optional selection
    // the explicit create route does.
    profile: conversationProfileSelectionSchema.optional(),
  }),
);

export const projectConversationOpenRequestSchema = z.object({
  open: z.boolean(),
});
