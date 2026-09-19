import { z } from "zod";

export const laneReminderInputSchema = z.object({
  verb: z.enum([
    "task-complete",
    "task-add",
    "shared-doc-upsert",
    "collab-request",
  ]),
  /** `contextState.iterationCount` — iterations this context has consumed. */
  iterationCount: z.number().int().nonnegative(),
  /** `contextDef.circuitBreaker.consecutiveFailureThreshold` — the halt ceiling. */
  circuitBreakerThreshold: z.number().int().positive(),
  remainingTaskCount: z.number().int().nonnegative(),
  /** Halt reason when the verb hit the 409 halt path; `null` on the success path. */
  halted: z.string().nullable(),
  allowAgentCollaboration: z.boolean(),
});

export type LaneReminderInput = z.infer<typeof laneReminderInputSchema>;
export type LaneVerb = LaneReminderInput["verb"];
