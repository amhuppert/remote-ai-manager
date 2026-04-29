import { describe, expect, it } from "vitest";
import { gateResultSchema } from "./gate-vocabulary";
import {
  runStructuredOutputGate,
  validateJsonSchemaSubset,
} from "./structured-output-gate";

describe("runStructuredOutputGate (shared GateResult)", () => {
  it("returns a normalized pass result that satisfies the shared gate schema", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: true },
      () => ({ valid: true }),
    );
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("structured_output");
  });

  it("returns a normalized fail result with reason and details when validation fails", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: false },
      () => ({ valid: false, errors: ["expected ok=true"] }),
    );
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.kind).toBe("structured_output");
      expect(gate.reason).toContain("expected ok=true");
      expect(gate.details).toMatchObject({ errors: ["expected ok=true"] });
    }
  });

  it("treats a thrown validator error as a normalized fail result", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: true },
      () => {
        throw new Error("validator crashed");
      },
    );
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.kind).toBe("structured_output");
      expect(gate.reason).toContain("validator crashed");
    }
  });

  it("includes an empty errors array in details when the validator rejects without details", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: false },
      () => ({ valid: false }),
    );
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.details).toMatchObject({ errors: [] });
    }
  });
});

describe("validateJsonSchemaSubset", () => {
  it("accepts nested object and array outputs that satisfy the schema", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        additionalProperties: false,
        required: ["summary", "items"],
        properties: {
          summary: { type: "string", minLength: 1 },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "done"],
              properties: {
                id: { type: "string", pattern: "^T-[0-9]+$" },
                done: { type: "boolean" },
              },
            },
          },
        },
      },
      {
        summary: "ok",
        items: [{ id: "T-1", done: true }],
      },
    );

    expect(result).toEqual({ valid: true });
  });

  it("reports concrete validation errors for missing and extra fields", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: { type: "string" },
        },
      },
      { extra: true },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "$.summary is required",
        "$.extra is not allowed",
      ]),
    );
  });
});
