/**
 * JSON Schema definitions for structured debug mode output.
 *
 * These schemas travel through the neutral `outputFormat` contract during
 * structured debug workflow phases. Backend adapters choose their transport,
 * and the shared AgentCall gate validates the completed response.
 *
 * Each shape has a sibling Zod schema (named `*ZodSchema`) used to
 * `safeParse` the agent's `structuredOutput` at trust boundaries inside the
 * conversation machine. The JSON Schemas are the model-facing contracts; the
 * Zod schemas are the authoritative runtime validation contracts.
 */

import { z } from "zod";

/**
 * Schema for the hypothesizing phase.
 * Agent must produce labeled hypotheses (H1, H2, ...) with instrumentation plans
 * and numbered reproduction steps.
 */
export const debugHypothesisOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses", "reproductionSteps"],
  properties: {
    hypotheses: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "instrumentationPlan"],
        properties: {
          id: { type: "string", pattern: "^H\\d+$" },
          description: { type: "string", minLength: 1 },
          instrumentationPlan: { type: "string", minLength: 1 },
        },
      },
    },
    reproductionSteps: {
      type: "array",
      minItems: 2,
      items: { type: "string", minLength: 1 },
    },
  },
} as const satisfies Record<string, unknown>;

export const debugHypothesisOutputZodSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        id: z.string().regex(/^H\d+$/),
        description: z.string().min(1),
        instrumentationPlan: z.string().min(1),
      }),
    )
    .min(3)
    .max(5),
  reproductionSteps: z.array(z.string().min(1)).min(2),
});

/** TypeScript type for the hypothesis output. */
export type DebugHypothesisOutput = z.infer<
  typeof debugHypothesisOutputZodSchema
>;

const debugHypothesisIdSchema = z.string().regex(/^H\d+$/);

const debugHypothesisShapeSchema = z.object({
  id: debugHypothesisIdSchema,
  description: z.string().min(1),
  instrumentationPlan: z.string().min(1),
});

const sharedEvidenceFields = {
  supportedHypotheses: z.array(debugHypothesisIdSchema),
  refutedHypotheses: z.array(debugHypothesisIdSchema),
  inconclusiveHypotheses: z.array(debugHypothesisIdSchema),
  evidenceSummary: z.string(),
};

/**
 * Provider-neutral JSON Schema for the evidence analysis phase.
 *
 * The discriminated union is expressed as a simple flat model-facing object:
 * the `outcome` enum acts as the discriminator, and per-branch fields appear as
 * optional properties. The matching Zod schema (`debugEvidenceAnalysisSchema`)
 * enforces the per-outcome required fields at the trust boundary.
 */
export const debugEvidenceAnalysisOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    "supportedHypotheses",
    "refutedHypotheses",
    "inconclusiveHypotheses",
    "evidenceSummary",
  ],
  properties: {
    outcome: {
      type: "string",
      enum: ["fix_applied", "more_instrumentation"],
    },
    supportedHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H\\d+$" },
    },
    refutedHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H\\d+$" },
    },
    inconclusiveHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H\\d+$" },
    },
    evidenceSummary: { type: "string" },
    fixSummary: { type: "string", minLength: 1 },
    verificationSteps: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "instrumentationPlan"],
        properties: {
          id: { type: "string", pattern: "^H\\d+$" },
          description: { type: "string", minLength: 1 },
          instrumentationPlan: { type: "string", minLength: 1 },
        },
      },
    },
    reproductionSteps: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
} as const satisfies Record<string, unknown>;

/**
 * Zod schema for the evidence analysis phase.
 * Agent classifies hypotheses as supported, refuted, or inconclusive, and
 * commits to one of two outcomes:
 *  - `fix_applied`: agent has already applied a fix; carries fix summary +
 *    verification steps the UI renders deterministically.
 *  - `more_instrumentation`: evidence is inconclusive; agent proposes a fresh
 *    set of hypotheses to investigate next plus reproduction steps.
 */
export const debugEvidenceAnalysisSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("fix_applied"),
    ...sharedEvidenceFields,
    fixSummary: z.string(),
    verificationSteps: z.array(z.string()).min(1),
  }),
  z.object({
    outcome: z.literal("more_instrumentation"),
    ...sharedEvidenceFields,
    hypotheses: z.array(debugHypothesisShapeSchema).min(1).max(5),
    reproductionSteps: z.array(z.string()).min(1),
  }),
]);

/** TypeScript type for the evidence analysis output. */
export type DebugEvidenceAnalysisOutput = z.infer<
  typeof debugEvidenceAnalysisSchema
>;

/**
 * Schema for the cleanup instrumentation phase.
 * Agent confirms whether instrumentation was removed, which files were
 * cleaned, and whether the verification grep found zero remaining probes.
 */
export const debugCleanupResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "removedInstrumentation",
    "filesModified",
    "grepVerificationPassed",
    "acknowledgesManifestDeletionContract",
    "notes",
  ],
  properties: {
    removedInstrumentation: { type: "boolean" },
    filesModified: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Relative file paths that had @debug-probe markers removed.",
    },
    grepVerificationPassed: {
      type: "boolean",
      description:
        'True when `grep -r "@debug-probe" src/` returns zero results after cleanup.',
    },
    acknowledgesManifestDeletionContract: {
      type: "boolean",
      description:
        "True when the agent acknowledges that Command Center is responsible for deleting .debug/instrumentation.json after verification passes (the agent must NOT delete it).",
    },
    notes: { type: "string" },
  },
} as const satisfies Record<string, unknown>;

export const debugCleanupResultZodSchema = z.object({
  removedInstrumentation: z.boolean(),
  filesModified: z.array(z.string()),
  grepVerificationPassed: z.boolean(),
  acknowledgesManifestDeletionContract: z.boolean(),
  notes: z.string(),
});

/** TypeScript type for the cleanup result output. */
export type DebugCleanupResultOutput = z.infer<
  typeof debugCleanupResultZodSchema
>;
