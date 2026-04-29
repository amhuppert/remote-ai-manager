/**
 * Collaboration Mode round-response vocabulary.
 *
 * The structured per-round response shape every participating agent emits is
 * the load-bearing schema for both convergence and the user-input pause gate:
 *
 *  - `decision` is the top-level accept/reject signal that feeds the
 *    convergence gate. Both agents emitting `accept` in the same round is the
 *    canonical convergence condition.
 *  - `openQuestions[].requiresUserInput` is the pause trigger — any open
 *    question in the latest round flagged with `requiresUserInput: true`
 *    parks the workflow on a human-approval gate until the user resolves it.
 *  - `agreements`, `disagreements`, `overallAssessment`, and `designDocument`
 *    feed the transcript and the scribe's final merge pass.
 *
 * The schema is intentionally narrow: this is the contract between the
 * primitive composition (the slice) and the per-round agent prompt. Adding
 * fields the agents do not actually emit would only mask drift between the
 * agent prompt and the schema.
 */

import { z } from "zod";

export const collaborationAgentSchema = z.enum(["claude", "codex"]);
export type CollaborationAgent = z.infer<typeof collaborationAgentSchema>;

export const collaborationDisagreementSeveritySchema = z.enum([
  "minor",
  "major",
  "blocking",
]);
export type CollaborationDisagreementSeverity = z.infer<
  typeof collaborationDisagreementSeveritySchema
>;

export const collaborationDisagreementSchema = z
  .object({
    description: z.string().min(1),
    severity: collaborationDisagreementSeveritySchema,
    proposedResolution: z.string().min(1),
  })
  .strict();
export type CollaborationDisagreement = z.infer<
  typeof collaborationDisagreementSchema
>;

export const collaborationOpenQuestionSchema = z
  .object({
    question: z.string().min(1),
    requiresUserInput: z.boolean(),
  })
  .strict();
export type CollaborationOpenQuestion = z.infer<
  typeof collaborationOpenQuestionSchema
>;

export const collaborationDecisionSchema = z.enum(["accept", "reject"]);
export type CollaborationDecision = z.infer<typeof collaborationDecisionSchema>;

export const collaborationRoundResponseSchema = z
  .object({
    agent: collaborationAgentSchema,
    round: z.number().int().nonnegative(),
    overallAssessment: z.string().min(1),
    agreements: z.array(z.string().min(1)),
    disagreements: z.array(collaborationDisagreementSchema),
    openQuestions: z.array(collaborationOpenQuestionSchema),
    designDocument: z.string().min(1),
    decision: collaborationDecisionSchema,
  })
  .strict();
export type CollaborationRoundResponse = z.infer<
  typeof collaborationRoundResponseSchema
>;

/**
 * JSON-schema projection of `collaborationRoundResponseSchema` that the slice
 * passes as `AgentCallRequest.outputSchema` so the shared structured-output
 * gate enforces the contract at request time, before the local Zod parse runs
 * as a defensive boundary.
 *
 * Kept as a hand-maintained constant (mirrors the `VALIDATOR_OUTPUT_SCHEMA`
 * pattern in `workflow-graph/validator-runner.ts`) so backends that natively
 * enforce JSON Schema receive a stable shape and don't depend on a Zod-to-JSON
 * Schema conversion step.
 */
export const COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "agent",
    "round",
    "overallAssessment",
    "agreements",
    "disagreements",
    "openQuestions",
    "designDocument",
    "decision",
  ],
  properties: {
    agent: { type: "string", enum: ["claude", "codex"] },
    round: { type: "integer", minimum: 0 },
    overallAssessment: { type: "string", minLength: 1 },
    agreements: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    disagreements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "severity", "proposedResolution"],
        properties: {
          description: { type: "string", minLength: 1 },
          severity: { type: "string", enum: ["minor", "major", "blocking"] },
          proposedResolution: { type: "string", minLength: 1 },
        },
      },
    },
    openQuestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "requiresUserInput"],
        properties: {
          question: { type: "string", minLength: 1 },
          requiresUserInput: { type: "boolean" },
        },
      },
    },
    designDocument: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["accept", "reject"] },
  },
} as const;
