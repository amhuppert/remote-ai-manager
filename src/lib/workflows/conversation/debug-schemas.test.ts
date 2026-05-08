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
  debugEvidenceAnalysisSchema,
  debugFixResultSchema,
  debugHypothesisOutputSchema,
} from "./debug-schemas";
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

const validEvidenceAnalysis = {
  supportedHypotheses: ["H1"],
  refutedHypotheses: ["H2"],
  inconclusiveHypotheses: ["H3"],
  recommendedNextStep: "fix",
  evidenceSummary: "H1 confirmed by trace.",
};

const validFixResult = {
  fixSummary: "Adjusted index calculation.",
  verificationSteps: ["Run test", "Inspect logs"],
};

const validCleanupResult = {
  removedInstrumentation: true,
  filesModified: ["src/foo.ts"],
  grepVerificationPassed: true,
  acknowledgesManifestDeletionContract: true,
  notes: "All probes removed.",
};

function asSchema(s: unknown): Record<string, unknown> {
  return s as unknown as Record<string, unknown>;
}

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

describe("debug schemas through structured-output gate", () => {
  describe("round-trip on valid payloads", () => {
    it("hypothesis schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugHypothesisOutputSchema),
        validHypothesis,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("evidence-analysis schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugEvidenceAnalysisSchema),
        validEvidenceAnalysis,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("fix-result schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugFixResultSchema),
        validFixResult,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("cleanup-result schema accepts a well-formed payload", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugCleanupResultSchema),
        validCleanupResult,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });
  });

  describe("schema mismatch surfaces consistently", () => {
    it("hypothesis schema rejects too few hypotheses", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugHypothesisOutputSchema),
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
        asSchema(debugHypothesisOutputSchema),
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

    it("evidence-analysis schema rejects an unknown recommendedNextStep", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugEvidenceAnalysisSchema),
        {
          ...validEvidenceAnalysis,
          recommendedNextStep: "abandon",
        },
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
      if (gate.status === "fail") {
        expect(gate.kind).toBe("structured_output");
      }
    });

    it("fix-result schema rejects fewer than 2 verification steps", () => {
      const gate = runStructuredOutputGate(
        asSchema(debugFixResultSchema),
        { fixSummary: "fix", verificationSteps: ["only one"] },
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("fail");
    });

    it("cleanup-result schema rejects a missing required field", () => {
      const incomplete = { ...validCleanupResult } as Record<string, unknown>;
      delete incomplete["grepVerificationPassed"];
      const gate = runStructuredOutputGate(
        asSchema(debugCleanupResultSchema),
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
        asSchema(debugHypothesisOutputSchema),
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
        asSchema(debugCleanupResultSchema),
        parsed.value,
        validateJsonSchemaSubset,
      );
      expect(gate.status).toBe("pass");
    });

    it("surfaces validation errors when the parsed text doesn't match the schema", () => {
      const raw = JSON.stringify({ fixSummary: "ok", verificationSteps: [] });
      const parsed = parseStructuredOutputText(raw);
      expect(parsed.found).toBe(true);
      if (!parsed.found) return;
      const gate = runStructuredOutputGate(
        asSchema(debugFixResultSchema),
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
