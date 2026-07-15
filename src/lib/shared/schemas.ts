import { z } from "zod";

export const contentResponseSchema = z.object({
  content: z.string(),
});

export const agentBackendSchema = z.enum(["claude", "codex"]);
export type AgentBackendId = z.infer<typeof agentBackendSchema>;
export const DEFAULT_AGENT_BACKEND_ID: AgentBackendId =
  agentBackendSchema.options[0]!;

/**
 * Shape-only backend id for parametric runtime envelopes. Registry resolution
 * owns membership validation; durable records use `agentBackendSchema`.
 */
export const agentBackendIdShapeSchema = z.custom<AgentBackendId>(
  (value) => typeof value === "string" && value.length > 0,
  { message: "backend must be a non-empty string" },
);

export const agentSessionRefSchema = z.object({
  backend: agentBackendSchema,
  /** Opaque resume handle. Only the owning adapter interprets it. */
  ref: z.string().min(1),
});
export type AgentSessionRef = z.infer<typeof agentSessionRefSchema>;
