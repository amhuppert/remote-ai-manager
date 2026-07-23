import { describe, expect, it } from "vitest";

import {
  buildStructuredOutputRepairPrompt,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS,
  STRUCTURED_OUTPUT_REPAIR_PRIOR_OUTPUT_MAX_CHARS,
} from "./structured-output-repair";

describe("buildStructuredOutputRepairPrompt", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      artifacts: { type: "array", minItems: 1 },
      summary: { type: "string", minLength: 1 },
    },
    required: ["summary", "artifacts"],
  };

  it("renders the schema contract, named issues, prior output, and decoded keys", () => {
    const prompt = buildStructuredOutputRepairPrompt({
      schema,
      priorOutputText: JSON.stringify({
        summary: "artifact content was trapped here",
      }),
      issues: ["$.artifacts is required"],
    });

    expect(prompt).toContain(
      "Your final message must be a single JSON object conforming to this JSON Schema.",
    );
    expect(prompt).toContain('"minItems": 1');
    expect(prompt).toContain("- $.artifacts is required");
    expect(prompt).toContain("artifact content was trapped here");
    expect(prompt).toContain('Decoded top-level keys were ["summary"]');
  });

  it("keeps only a bounded tail of an oversized prior output", () => {
    const prefix = "discard-this-prefix";
    const suffix = "keep-this-suffix";
    const priorOutputText = `${prefix}${"x".repeat(
      STRUCTURED_OUTPUT_REPAIR_PRIOR_OUTPUT_MAX_CHARS,
    )}${suffix}`;

    const prompt = buildStructuredOutputRepairPrompt({
      schema,
      priorOutputText,
      issues: ["$ must be object"],
    });

    expect(prompt).not.toContain(prefix);
    expect(prompt).toContain("[prior output truncated]");
    expect(prompt).toContain(suffix);
  });

  it("does not invent a decoded-keys diagnostic for non-JSON text", () => {
    const prompt = buildStructuredOutputRepairPrompt({
      schema,
      priorOutputText: "not JSON",
      issues: ["no structured output was extractable"],
    });

    expect(prompt).not.toContain("Decoded top-level keys were");
  });

  it("bounds issue count and length while retaining the decoded-keys diagnostic", () => {
    const oversizedIssue = "x".repeat(
      STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS + 1,
    );
    const issues = Array.from(
      { length: STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES + 1 },
      (_, index) => `issue-${index}:${oversizedIssue}`,
    );

    const prompt = buildStructuredOutputRepairPrompt({
      schema,
      priorOutputText: JSON.stringify({ summary: "present" }),
      issues,
    });

    expect(prompt).toContain("issue-0:");
    expect(prompt).not.toContain(
      `issue-${STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES}:`,
    );
    expect(prompt).not.toContain(oversizedIssue);
    expect(prompt).toContain('Decoded top-level keys were ["summary"]');
  });
});
