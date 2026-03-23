/**
 * JSON Schema definitions for structured debug mode output.
 *
 * These schemas are passed to the Claude Agent SDK via the `outputFormat`
 * option to enforce structured JSON responses during debug workflow phases.
 */

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

/** TypeScript type for the hypothesis output. */
export interface DebugHypothesisOutput {
  hypotheses: Array<{
    id: string;
    description: string;
    instrumentationPlan: string;
  }>;
  reproductionSteps: string[];
}

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

/** TypeScript type for the evidence analysis output. */
export interface DebugEvidenceAnalysisOutput {
  supportedHypotheses: string[];
  refutedHypotheses: string[];
  inconclusiveHypotheses: string[];
  recommendedNextStep: "fix" | "more_instrumentation";
  evidenceSummary: string;
}

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

/** TypeScript type for the fix result output. */
export interface DebugFixResultOutput {
  fixSummary: string;
  verificationSteps: string[];
}

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
    "manifestDeleted",
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
    manifestDeleted: {
      type: "boolean",
      description:
        "True when .debug/instrumentation.json was deleted after cleanup.",
    },
    notes: { type: "string" },
  },
} as const;

/** TypeScript type for the cleanup result output. */
export interface DebugCleanupResultOutput {
  removedInstrumentation: boolean;
  filesModified: string[];
  grepVerificationPassed: boolean;
  manifestDeleted: boolean;
  notes: string;
}
