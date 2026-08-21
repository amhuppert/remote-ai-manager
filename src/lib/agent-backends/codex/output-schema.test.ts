import { describe, expect, it } from "vitest";
import {
  projectSchemaForCodex,
  restoreCodexOptionalOmissions,
} from "./output-schema";

/**
 * The rule the provider stated when it refused a dispatch with HTTP 400:
 * "'required' is required to be supplied and to be an array including every key
 * in properties". Walked over the whole projected schema, since the provider
 * reports only the first offending node.
 */
function objectNodesMissingRequiredKeys(
  schema: unknown,
  path = "$",
): { path: string; missing: string[] }[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      objectNodesMissingRequiredKeys(entry, `${path}[${index}]`),
    );
  }
  if (typeof schema !== "object" || schema === null) return [];

  const node = schema as Record<string, unknown>;
  const violations: { path: string; missing: string[] }[] = [];

  const properties = node.properties;
  if (typeof properties === "object" && properties !== null) {
    const declared = Object.keys(properties as Record<string, unknown>);
    const required = Array.isArray(node.required) ? node.required : [];
    const missing = declared.filter((key) => !required.includes(key));
    if (missing.length > 0) violations.push({ path, missing });
  }

  for (const [key, child] of Object.entries(node)) {
    violations.push(...objectNodesMissingRequiredKeys(child, `${path}.${key}`));
  }
  return violations;
}

/**
 * The shape that halted execution 81d48065: a blocking validator verdict, whose
 * root `planDefects` and per-issue `criterionId` are authored as optional.
 */
function blockingVerdictSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            taskId: { type: "string", enum: ["t1", "t2"] },
            criterionId: { type: "string", enum: ["c1"] },
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["taskId", "title", "description"],
          additionalProperties: false,
        },
      },
      planDefects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            whyNotLocallyRemediable: { type: "string" },
          },
          required: ["title", "whyNotLocallyRemediable"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "issues"],
    additionalProperties: false,
  };
}

describe("projectSchemaForCodex", () => {
  it("names every declared property in required so a schema with an optional key is not refused", () => {
    const schema = blockingVerdictSchema();

    expect(objectNodesMissingRequiredKeys(schema)).not.toEqual([]);
    expect(
      objectNodesMissingRequiredKeys(projectSchemaForCodex(schema)),
    ).toEqual([]);
  });

  it("widens an authored-optional property to admit null and leaves required ones alone", () => {
    const projected = projectSchemaForCodex({
      type: "object",
      properties: {
        summary: { type: "string" },
        planDefects: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
      additionalProperties: false,
    });

    expect(projected).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        planDefects: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
        },
      },
      required: ["summary", "planDefects"],
      additionalProperties: false,
    });
  });

  it("does not re-wrap a property the author already made nullable", () => {
    const projected = projectSchemaForCodex({
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      additionalProperties: false,
    });

    expect(projected).toEqual({
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      required: ["note"],
      additionalProperties: false,
    });
  });

  it("infers primitive const types through every supported schema child without mutating the source", () => {
    const schema = {
      type: "object",
      properties: {
        text: { const: "fixed" },
        count: { const: 3 },
        flag: { const: true },
        empty: { const: null },
        list: {
          type: "array",
          items: { const: "entry" },
        },
        choice: {
          oneOf: [{ const: "first" }, { const: 2 }],
        },
      },
      required: ["text", "count", "flag", "empty", "list", "choice"],
    };

    const projected = projectSchemaForCodex(schema);

    expect(projected).toEqual({
      type: "object",
      properties: {
        text: { const: "fixed", type: "string" },
        count: { const: 3, type: "number" },
        flag: { const: true, type: "boolean" },
        empty: { const: null, type: "null" },
        list: {
          type: "array",
          items: { const: "entry", type: "string" },
        },
        choice: {
          oneOf: [
            { const: "first", type: "string" },
            { const: 2, type: "number" },
          ],
        },
      },
      required: ["text", "count", "flag", "empty", "list", "choice"],
    });
    expect(schema.properties.text).toEqual({ const: "fixed" });
    expect(schema.properties.list.items).toEqual({ const: "entry" });
    expect(schema.properties.choice.oneOf).toEqual([
      { const: "first" },
      { const: 2 },
    ]);
  });

  it("preserves an explicit type and does not interpret a property named const as a schema keyword", () => {
    const schema = {
      type: "object",
      properties: {
        marker: { type: "number", const: "fixed" },
        const: { type: "string" },
      },
      required: ["marker", "const"],
    };

    expect(projectSchemaForCodex(schema)).toEqual(schema);
  });

  it("leaves non-primitive const values unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        objectValue: { const: { marker: "fixed" } },
        arrayValue: { const: ["fixed"] },
      },
      required: ["objectValue", "arrayValue"],
    };

    expect(projectSchemaForCodex(schema)).toEqual(schema);
  });
});

describe("restoreCodexOptionalOmissions", () => {
  it("drops an authored-optional key that came back as an explicit null", () => {
    const restored = restoreCodexOptionalOmissions(blockingVerdictSchema(), {
      summary: "clean",
      issues: [],
      planDefects: null,
    });

    expect(restored).toEqual({ summary: "clean", issues: [] });
  });

  it("keeps a null the authored schema itself admits", () => {
    const restored = restoreCodexOptionalOmissions(
      {
        type: "object",
        properties: { note: { type: ["string", "null"] } },
        additionalProperties: false,
      },
      { note: null },
    );

    expect(restored).toEqual({ note: null });
  });

  it("keeps a null at a required key, where it is a contract failure the gate must see", () => {
    const restored = restoreCodexOptionalOmissions(blockingVerdictSchema(), {
      summary: null,
      issues: [],
    });

    expect(restored).toEqual({ summary: null, issues: [] });
  });

  it("recurses into array items so a nested optional key is restored too", () => {
    const restored = restoreCodexOptionalOmissions(blockingVerdictSchema(), {
      summary: "found one",
      issues: [
        {
          taskId: "t1",
          criterionId: null,
          title: "t",
          description: "d",
        },
      ],
      planDefects: null,
    });

    expect(restored).toEqual({
      summary: "found one",
      issues: [{ taskId: "t1", title: "t", description: "d" }],
    });
  });

  it("returns a non-object payload and unknown keys untouched", () => {
    const schema = blockingVerdictSchema();
    expect(restoreCodexOptionalOmissions(schema, "not an object")).toBe(
      "not an object",
    );
    expect(
      restoreCodexOptionalOmissions(schema, { summary: "s", stray: null }),
    ).toEqual({ summary: "s", stray: null });
  });

  it("round-trips a payload that nulls every optional key back to the authored shape", () => {
    const schema = blockingVerdictSchema();
    const projected = projectSchemaForCodex(schema);

    // What the provider permits once every key is required-and-nullable.
    expect(objectNodesMissingRequiredKeys(projected)).toEqual([]);

    expect(
      restoreCodexOptionalOmissions(schema, {
        summary: "clean",
        issues: [
          { taskId: "t2", criterionId: null, title: "t", description: "d" },
        ],
        planDefects: null,
      }),
    ).toEqual({
      summary: "clean",
      issues: [{ taskId: "t2", title: "t", description: "d" }],
    });
  });
});
