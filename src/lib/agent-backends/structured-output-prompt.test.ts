import { describe, expect, it } from "vitest";

import { renderStructuredOutputInstruction } from "./structured-output-prompt";

const CONTRACT_PREAMBLE =
  "Your final message must be a single JSON object conforming to this JSON Schema. Output only the JSON object — no prose before or after it, no markdown fence required.";

describe("renderStructuredOutputInstruction", () => {
  it("renders a deterministic, recursively key-sorted JSON Schema contract", () => {
    const schema = {
      type: "object",
      required: ["summary", "items"],
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description: "Non-empty summary",
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "integer", minimum: 0 },
        },
      },
      additionalProperties: false,
    };

    expect(renderStructuredOutputInstruction(schema)).toBe(
      `${CONTRACT_PREAMBLE}

\`\`\`json
{
  "additionalProperties": false,
  "properties": {
    "items": {
      "items": {
        "minimum": 0,
        "type": "integer"
      },
      "maxItems": 3,
      "minItems": 1,
      "type": "array"
    },
    "summary": {
      "description": "Non-empty summary",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "summary",
    "items"
  ],
  "type": "object"
}
\`\`\``,
    );
  });

  it("renders insertion-order variants byte-identically while preserving array order", () => {
    const first = {
      required: ["zeta", "alpha"],
      properties: {
        zeta: { maxLength: 8, type: "string" },
        alpha: { type: "number", maximum: 10 },
      },
      type: "object",
    };
    const second = {
      type: "object",
      properties: {
        alpha: { maximum: 10, type: "number" },
        zeta: { type: "string", maxLength: 8 },
      },
      required: ["zeta", "alpha"],
    };

    const rendered = renderStructuredOutputInstruction(first);

    expect(renderStructuredOutputInstruction(second)).toBe(rendered);
    expect(rendered.indexOf('"alpha"')).toBeLessThan(
      rendered.indexOf('"zeta"'),
    );
    expect(rendered.indexOf('"zeta",')).toBeLessThan(
      rendered.lastIndexOf('"alpha"'),
    );
  });

  it("has no final newline or trailing whitespace", () => {
    const rendered = renderStructuredOutputInstruction({ type: "object" });

    expect(rendered.endsWith("```")).toBe(true);
    expect(rendered.split("\n").every((line) => line === line.trimEnd())).toBe(
      true,
    );
  });
});
