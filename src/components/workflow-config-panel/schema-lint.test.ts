/**
 * The four states the schema editor reports, and the save refusal they earn.
 *
 * The verdict is NOT this module's to invent — it comes from
 * `validateOutputSchemaDeclaration`, the walker the definition accept path
 * refuses with. These tests pin the translation: that an engine-acceptable
 * declaration reads as accepted, that an engine refusal names the author's own
 * offending keyword, and that only a refusal blocks a save.
 */
import { describe, expect, it } from "vitest";
import { OUTPUT_SCHEMA_TEMPLATE } from "@/components/workflow-config/OutputSchemaField";
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";
import {
  outputSchemaLintCard,
  outputSchemaRowParts,
  outputSchemaSaveBlockReason,
  OUTPUT_SCHEMA_DISABLED_HINT,
} from "./schema-lint";

const VALID = JSON.stringify(
  {
    type: "object",
    properties: {
      verdict: { type: "string" },
      confidence: { type: "number" },
      blockers: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "confidence"],
  },
  null,
  2,
);

// `format` is refused by the engine because the runtime validator silently
// ignores it — the exact drift the subset walker exists to catch.
const UNSUPPORTED = JSON.stringify({
  type: "object",
  properties: { email: { type: "string", format: "email" } },
  required: ["email"],
});

describe("outputSchemaLintCard — valid", () => {
  it("reports the engine's acceptance with the design's headline", () => {
    const card = outputSchemaLintCard(VALID);
    expect(card.state).toBe("valid");
    expect(card.title).toBe("Accepted by the engine");
    expect(card.tone).toBe("green");
    expect(card.blocked).toBe(false);
  });

  it("agrees with the engine's own walker on what is acceptable", () => {
    // The point of the module: no second opinion about the subset.
    expect(validateOutputSchemaDeclaration(JSON.parse(VALID))).toEqual([]);
    expect(outputSchemaLintCard(VALID).blocked).toBe(false);
  });

  it("derives field and required counts from the parsed text", () => {
    const card = outputSchemaLintCard(VALID);
    expect(card.fields).toBe(3);
    expect(card.required).toBe(2);
    expect(card.detail).toContain("3 fields");
    expect(card.detail).toContain("2 required");
  });

  it("recounts as the text changes rather than holding the first parse", () => {
    const narrowed = JSON.stringify({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: [],
    });
    expect(outputSchemaLintCard(narrowed).fields).toBe(1);
    expect(outputSchemaLintCard(narrowed).required).toBe(0);
    expect(outputSchemaLintCard(narrowed).detail).toContain("1 field");
  });

  it("accepts the template the app seeds an author with", () => {
    expect(outputSchemaLintCard(OUTPUT_SCHEMA_TEMPLATE).state).toBe("valid");
  });
});

describe("outputSchemaLintCard — invalid JSON", () => {
  const card = outputSchemaLintCard('{\n  "type": "object",\n  oops\n}');

  it("names the parse failure and says the save is blocked", () => {
    expect(card.state).toBe("invalid-json");
    expect(card.title).toBe("Invalid JSON");
    expect(card.detail).toContain(
      "Save is blocked while the text cannot be parsed.",
    );
    expect(card.blocked).toBe(true);
  });

  it("carries the syntax error's position", () => {
    expect(card.detail).toMatch(/line \d+ · col \d+/);
  });

  it("reports no counts — there is nothing parsed to count", () => {
    expect(card.fields).toBeNull();
    expect(card.required).toBeNull();
  });
});

describe("outputSchemaLintCard — unsupported", () => {
  const card = outputSchemaLintCard(UNSUPPORTED);

  it("names the offending keyword and says the save is blocked", () => {
    expect(card.state).toBe("unsupported");
    expect(card.title).toBe("Outside the supported subset");
    expect(card.detail).toContain("format");
    expect(card.detail).toContain("Save is blocked.");
    expect(card.blocked).toBe(true);
  });

  it("is the same refusal the engine's accept path would make", () => {
    expect(
      validateOutputSchemaDeclaration(JSON.parse(UNSUPPORTED)).length,
    ).toBeGreaterThan(0);
  });

  it("still counts the fields — the text parsed, so the counts are real", () => {
    expect(card.fields).toBe(1);
    expect(card.required).toBe(1);
  });
});

describe("outputSchemaLintCard — empty", () => {
  it("states the consequence without blocking a save", () => {
    for (const blank of ["", "   \n  "]) {
      const card = outputSchemaLintCard(blank);
      expect(card.state).toBe("empty");
      expect(card.title).toBe("No output contract");
      expect(card.detail).toContain("Read-only contexts require one.");
      expect(card.blocked).toBe(false);
    }
  });
});

describe("outputSchemaSaveBlockReason", () => {
  it("is null for the two persistable states", () => {
    expect(outputSchemaSaveBlockReason(VALID)).toBeNull();
    expect(outputSchemaSaveBlockReason("")).toBeNull();
  });

  it("names the schema in each refusal", () => {
    expect(outputSchemaSaveBlockReason("{ not json")).toContain(
      "output schema",
    );
    expect(outputSchemaSaveBlockReason(UNSUPPORTED)).toContain("output schema");
  });
});

describe("outputSchemaRowParts", () => {
  it("summarises an accepted schema with its derived counts", () => {
    expect(outputSchemaRowParts(VALID)).toEqual([
      { kind: "value", text: "3" },
      { kind: "text", text: "fields", tone: "dim" },
      { kind: "value", text: "2" },
      { kind: "text", text: "required", tone: "dim" },
    ]);
  });

  it("summarises each refusal as a red chip naming it", () => {
    expect(outputSchemaRowParts("{ not json")).toEqual([
      { kind: "chip", text: "invalid JSON", tone: "red" },
    ]);
    expect(outputSchemaRowParts(UNSUPPORTED)).toEqual([
      { kind: "chip", text: "unsupported", tone: "red" },
    ]);
  });
});

describe("the save-block contract the host reads", () => {
  const CASES = [
    VALID,
    "",
    "   ",
    "{ not json",
    UNSUPPORTED,
    JSON.stringify({ type: "string" }),
    JSON.stringify({ type: "object", properties: { a: { $ref: "#/x" } } }),
  ];

  it("agrees with what the screen shows the author, case for case", () => {
    // AC schema-save-block: the red text an author is looking at and the
    // refusal their Save gets are one verdict, so a schema that parsed a
    // keystroke ago cannot be persisted under fresh red text.
    for (const text of CASES) {
      const card = outputSchemaLintCard(text);
      expect(outputSchemaSaveBlockReason(text) !== null).toBe(card.blocked);
    }
  });

  it("blocks exactly when the engine's own walker would refuse the parse", () => {
    for (const text of CASES) {
      let parsed: unknown;
      let parses = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        parses = false;
      }
      const engineRefuses =
        text.trim().length > 0 &&
        (!parses || validateOutputSchemaDeclaration(parsed).length > 0);
      expect(outputSchemaLintCard(text).blocked).toBe(engineRefuses);
    }
  });
});

describe("OUTPUT_SCHEMA_DISABLED_HINT", () => {
  it("carries README §8.1's per-mode copy", () => {
    expect(OUTPUT_SCHEMA_DISABLED_HINT.frozen).toBe(
      "The output was already captured against this schema — editing it now would not re-validate anything.",
    );
    expect(OUTPUT_SCHEMA_DISABLED_HINT["pause-to-edit"]).toBe(
      "Pause the execution to change the contract before the next iteration runs.",
    );
    expect(OUTPUT_SCHEMA_DISABLED_HINT["read-only"]).toBe(
      "This execution is no longer running; its working definition is immutable.",
    );
  });
});
