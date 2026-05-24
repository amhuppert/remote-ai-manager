import { z } from "zod";

export const contentResponseSchema = z.object({
  content: z.string(),
});

export const agentBackendSchema = z.enum(["claude", "codex"]);
export type AgentBackendId = z.infer<typeof agentBackendSchema>;
