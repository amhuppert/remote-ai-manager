/**
 * JSON Schema definitions for structured debug mode output.
 *
 * These schemas are passed to the Claude Agent SDK via the `outputFormat`
 * option to enforce structured JSON responses during debug workflow phases.
 *
 * Each shape has a sibling Zod schema (named `*ZodSchema`) used to
 * `safeParse` the agent's `structuredOutput` at trust boundaries inside
 * the conversation machine. The JSON Schemas are the SDK enforcement
 * contract; the Zod schemas are the runtime validation contract.
 */

import { z } from "zod";

/**
 * Schema for the hypothesizing phase.
 * Agent must produce labeled hypotheses (H1–H5) with instrumentation plans
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
          id: { type: "string", pattern: "^H[1-5]$" },
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
} as const;

export const debugHypothesisOutputZodSchema = z.object({
  hypotheses: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      instrumentationPlan: z.string().optional(),
    }),
  ),
  reproductionSteps: z.array(z.string()),
});

/** TypeScript type for the hypothesis output. */
export type DebugHypothesisOutput = z.infer<
  typeof debugHypothesisOutputZodSchema
>;

/**
 * Schema for the evidence analysis phase.
 * Agent classifies hypotheses as supported, refuted, or inconclusive,
 * and recommends whether to fix or gather more instrumentation.
 */
export const debugEvidenceAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "supportedHypotheses",
    "refutedHypotheses",
    "inconclusiveHypotheses",
    "recommendedNextStep",
    "evidenceSummary",
  ],
  properties: {
    supportedHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H[1-5]$" },
    },
    refutedHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H[1-5]$" },
    },
    inconclusiveHypotheses: {
      type: "array",
      items: { type: "string", pattern: "^H[1-5]$" },
    },
    recommendedNextStep: {
      type: "string",
      enum: ["fix", "more_instrumentation"],
    },
    evidenceSummary: { type: "string" },
  },
} as const;

export const debugEvidenceAnalysisZodSchema = z.object({
  supportedHypotheses: z.array(z.string()),
  refutedHypotheses: z.array(z.string()),
  inconclusiveHypotheses: z.array(z.string()),
  recommendedNextStep: z.enum(["fix", "more_instrumentation"]),
  evidenceSummary: z.string(),
});

/** TypeScript type for the evidence analysis output. */
export type DebugEvidenceAnalysisOutput = z.infer<
  typeof debugEvidenceAnalysisZodSchema
>;

/**
 * Schema for the fixing phase.
 * Agent returns a summary of the fix and structured verification steps
 * so the UI can render them deterministically.
 */
export const debugFixResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fixSummary", "verificationSteps"],
  properties: {
    fixSummary: { type: "string", minLength: 1 },
    verificationSteps: {
      type: "array",
      minItems: 2,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export const debugFixResultZodSchema = z.object({
  fixSummary: z.string(),
  verificationSteps: z.array(z.string()),
});

/** TypeScript type for the fix result output. */
export type DebugFixResultOutput = z.infer<typeof debugFixResultZodSchema>;

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
} as const;

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
