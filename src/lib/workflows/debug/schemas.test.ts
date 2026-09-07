/**
 * Round-trip tests for debug-mode JSON schemas through the shared
 * structured-output gate.
 *
 * The conversation machine wires `outputFormat: { type: "json_schema", schema }`
 * onto every executePrompt invocation while in a structured debug phase. The
 * shared gate (`runStructuredOutputGate`) is what actually enforces the schema
 * after dispatch, regardless of whether the backend natively enforced it. These
 * tests verify three things end-to-end for each debug schema:
 *
 *  1. **Round-trip:** a well-formed output payload passes the gate.
 *  2. **Schema mismatch surfaces consistently:** malformed payloads surface as
 *     `gate.status === "fail"` with `gate.kind === "structured_output"` and a
 *     non-empty errors detail — same shape every other gate consumer sees.
 *  3. **Parseable-text fallback still works:** when a backend returns a JSON
 *     blob inside a fenced ```json``` text block instead of a structured
 *     payload, the facade's `parseStructuredOutputText` extracts it and the
 *     gate validates the parsed value, not the raw text.
 */
import { describe, expect, it } from "vitest";
import {
  debugCleanupResultSchema,
  debugEvidenceAnalysisOutputSchema,
  debugEvidenceAnalysisSchema,
  debugHypothesisOutputSchema,
} from "@/lib/workflows/debug/schemas";
import {
  runStructuredOutputGate,
  validateJsonSchemaSubset,
} from "@/lib/workflows/primitives/structured-output-gate";

const validHypothesis = {
  hypotheses: [
    { id: "H1", description: "off-by-one", instrumentationPlan: "Log index" },
    { id: "H2", description: "race", instrumentationPlan: "Log timing" },
    { id: "H3", description: "stale cache", instrumentationPlan: "Log key" },
  ],
  reproductionSteps: ["Open page", "Click button"],
};

const validCleanupResult = {
  removedInstrumentation: true,
  filesModified: ["src/foo.ts"],
  grepVerificationPassed: true,
  acknowledgesManifestDeletionContract: true,
  notes: "All probes removed.",
};

/**
 * Mirrors the relevant slice of `parseStructuredOutputText` from
 * `agent-call-facade.ts`: when a backend returns plain text, the facade
 * tries `JSON.parse(text)` first, then a fenced ```json``` block. We verify
 * the same fallback path here against the debug schemas without depending on
 * the entire facade test harness.
 */
function parseStructuredOutputText(
  text: string,
): { found: true; value: unknown } | { found: false } {
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    const matches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
    const last = matches.at(-1);
    const inner = last?.[1]?.trim();
    if (!inner) return { found: false };
    try {
      return { found: true, value: JSON.parse(inner) };
    } catch {
      return { found: false };
    }
  }
}

describe("Anthropic tool input_schema contract", () => {
  // Anthropic's API rejects tool input_schemas that lack a top-level
  // `type: "object"`. A raw `{ oneOf: [...] }` at the root produces:
  //   400 invalid_request_error: tools.N.custom.input_schema.type: Field required
  // Every exported *OutputSchema is sent verbatim as a tool input_schema, so
  // each one must declare `type: "object"` at root.
  it.each([
    ["debugHypothesisOutputSchema", debugHypothesisOutputSchema],
    ["debugEvidenceAnalysisOutputSchema", debugEvidenceAnalysisOutputSchema],
    ["debugCleanupResultSchema", debugCleanupResultSchema],
  ])("%s declares type:object at root", (_name, schema) => {
    expect(schema.type).toBe("object");
  });

  // Anthropic also rejects `oneOf`/`allOf`/`anyOf` at the top level of a
  // tool input_schema:
  //   400 invalid_request_error: tools.N.custom.input_schema:
  //     input_schema does not support oneOf, allOf, or anyOf at the top level
  // Discriminated unions must be expressed as a single flat object whose
  // discriminator is an enum field; per-branch required fields are enforced
  // downstream by the matching Zod schema.
  it.each([
    ["debugHypothesisOutputSchema", debugHypothesisOutputSchema],
    ["debugEvidenceAnalysisOutputSchema", debugEvidenceAnalysisOutputSchema],
    ["debugCleanupResultSchema", debugCleanupResultSchema],
  ])("%s does not use oneOf/allOf/anyOf at the root", (_name, schema) => {
    const root: Record<string, unknown> = schema;
    expect(root["oneOf"]).toBeUndefined();
    expect(root["allOf"]).toBeUndefined();
    expect(root["anyOf"]).toBeUndefined();
  });
});

describe("debug schemas through structured-output gate", () => {
  describe("round-trip on valid payloads", () => {
    it("hypothesis schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        debugHypothesisOutputSchema,
        validHypothesis,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("cleanup-result schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        debugCleanupResultSchema,
        validCleanupResult,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });
  });

  describe("schema mismatch surfaces consistently", () => {
    it("hypothesis schema rejects too few hypotheses", () => {
      const gate = runStructuredOutputGate(
        debugHypothesisOutputSchema,
        {
          ...validHypothesis,
          hypotheses: validHypothesis.hypotheses.slice(0, 2),
        },
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
      if (gate.status === "fail") {
        expect(gate.kind).toBe("structured_output");
        expect(gate.details?.errors).toBeDefined();
        expect((gate.details?.errors as string[]).length).toBeGreaterThan(0);
      }
    });

    it("hypothesis schema rejects an out-of-pattern id", () => {
      const gate = runStructuredOutputGate(
        debugHypothesisOutputSchema,
        {
          ...validHypothesis,
          hypotheses: [
            { id: "X1", description: "bad id", instrumentationPlan: "x" },
            ...validHypothesis.hypotheses.slice(1),
          ],
        },
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
    });

    it("cleanup-result schema rejects a missing required field", () => {
      const incomplete = { ...validCleanupResult } as Record<string, unknown>;
      delete incomplete["grepVerificationPassed"];
      const gate = runStructuredOutputGate(
        debugCleanupResultSchema,
        incomplete,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
    });
  });

  describe("parseable-text fallback (fenced JSON block)", () => {
    it("extracts and validates a hypothesis payload from a fenced ```json``` text block", () => {
      const fenced = [
        "Here is my output:",
        "",
        "```json",
        JSON.stringify(validHypothesis, null, 2),
        "```",
      ].join("\n");
      const parsed = parseStructuredOutputText(fenced);
      expect(parsed.found).toBe(true);
      if (!parsed.found) return;
      const gate = runStructuredOutputGate(
        debugHypothesisOutputSchema,
        parsed.value,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("extracts and validates a cleanup payload from raw JSON text", () => {
      const raw = JSON.stringify(validCleanupResult);
      const parsed = parseStructuredOutputText(raw);
      expect(parsed.found).toBe(true);
      if (!parsed.found) return;
      const gate = runStructuredOutputGate(
        debugCleanupResultSchema,
        parsed.value,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("surfaces validation errors when the parsed text doesn't match the schema", () => {
      const raw = JSON.stringify({
        outcome: "fix_applied",
        supportedHypotheses: [],
        refutedHypotheses: [],
        inconclusiveHypotheses: [],
        evidenceSummary: "ok",
        fixSummary: "ok",
        verificationSteps: [],
      });
      const parsed = parseStructuredOutputText(raw);
      expect(parsed.found).toBe(true);
      if (!parsed.found) return;
      const gate = runStructuredOutputGate(
        debugEvidenceAnalysisOutputSchema,
        parsed.value,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
      if (gate.status === "fail") {
        expect(gate.kind).toBe("structured_output");
      }
    });
  });
});

describe("debugEvidenceAnalysisSchema (Zod discriminated union)", () => {
  const sharedEvidence = {
    supportedHypotheses: ["H1"],
    refutedHypotheses: ["H2"],
    inconclusiveHypotheses: ["H3"],
    evidenceSummary: "H1 confirmed by trace.",
  };

  const validFixApplied = {
    outcome: "fix_applied",
    ...sharedEvidence,
    fixSummary: "Adjusted index calculation.",
    verificationSteps: ["Run failing test", "Inspect logs"],
  };

  const validMoreInstrumentation = {
    outcome: "more_instrumentation",
    ...sharedEvidence,
    hypotheses: [
      {
        id: "H4",
        description: "Possible cache invalidation race",
        instrumentationPlan: "Log cache key writes",
      },
    ],
    reproductionSteps: ["Open page", "Click button"],
  };

  it("parses a valid fix_applied payload", () => {
    const parsed = debugEvidenceAnalysisSchema.safeParse(validFixApplied);
    expect(parsed.success).toBe(true);
  });

  it("parses a valid more_instrumentation payload", () => {
    const parsed = debugEvidenceAnalysisSchema.safeParse(
      validMoreInstrumentation,
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid outcome value", () => {
    const parsed = debugEvidenceAnalysisSchema.safeParse({
      ...validFixApplied,
      outcome: "abandon",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a fix_applied payload missing fixSummary", () => {
    const incomplete: Record<string, unknown> = { ...validFixApplied };
    delete incomplete["fixSummary"];
    const parsed = debugEvidenceAnalysisSchema.safeParse(incomplete);
    expect(parsed.success).toBe(false);
  });

  it("rejects a more_instrumentation payload missing reproductionSteps", () => {
    const incomplete: Record<string, unknown> = { ...validMoreInstrumentation };
    delete incomplete["reproductionSteps"];
    const parsed = debugEvidenceAnalysisSchema.safeParse(incomplete);
    expect(parsed.success).toBe(false);
  });

  it("accepts hypothesis ids beyond H5 (loosened pattern)", () => {
    const parsed = debugEvidenceAnalysisSchema.safeParse({
      ...validMoreInstrumentation,
      hypotheses: [
        {
          id: "H10",
          description: "Tenth hypothesis",
          instrumentationPlan: "Log it",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
