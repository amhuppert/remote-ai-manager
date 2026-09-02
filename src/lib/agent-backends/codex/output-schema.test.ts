import { describe, expect, it } from "vitest";
import { renderStructuredOutputInstruction } from "../structured-output-prompt";
import {
  projectSchemaForCodex,
  resolveCodexStructuredOutput,
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
          anyOf: [
            { const: "first", type: "string" },
            { const: 2, type: "number" },
          ],
        },
      },
      required: ["text", "count", "flag", "empty", "list", "choice"],
      additionalProperties: false,
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

    expect(projectSchemaForCodex(schema)).toEqual({
      ...schema,
      additionalProperties: false,
    });
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

    expect(projectSchemaForCodex(schema)).toEqual({
      ...schema,
      additionalProperties: false,
    });
  });

  it("rewrites a nested oneOf as anyOf, the only union the provider permits", () => {
    const projected = projectSchemaForCodex({
      type: "object",
      properties: {
        choice: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["choice"],
      additionalProperties: false,
    });

    expect(projected).toEqual({
      type: "object",
      properties: {
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["choice"],
      additionalProperties: false,
    });
  });

  it("declares type object on a node that only lists properties", () => {
    const projected = projectSchemaForCodex({
      properties: { a: { type: "string" } },
      required: ["a"],
    });

    expect(projected).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("spells out an explicitly closed object with no properties as the empty closed object the provider accepts", () => {
    const projected = projectSchemaForCodex({
      type: "object",
      properties: {
        placeholder: { type: "object", additionalProperties: false },
      },
      required: ["placeholder"],
      additionalProperties: false,
    });

    expect(projected).toEqual({
      type: "object",
      properties: {
        placeholder: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      required: ["placeholder"],
      additionalProperties: false,
    });
  });
});

describe("resolveCodexStructuredOutput", () => {
  it("dispatches an expressible schema natively, closed and fully required, and leaves the prompt alone", () => {
    const structured = resolveCodexStructuredOutput(
      measurePayloadMaximaSchema(),
    );

    expect(structured.transport).toBe("native");
    expect(structured.reason).toBeNull();
    expect(objectNodesNotClosed(structured.outputSchema)).toEqual([]);
    expect(objectNodesMissingRequiredKeys(structured.outputSchema)).toEqual([]);
    expect(structured.prepareInput("Measure the payload")).toBe(
      "Measure the payload",
    );
  });

  it("reads a projected null back as the omission the author described on the native path", () => {
    const structured = resolveCodexStructuredOutput(blockingVerdictSchema());

    expect(
      structured.restore({ summary: "clean", issues: [], planDefects: null }),
    ).toEqual({ summary: "clean", issues: [] });
  });

  describe("a shape the strict dialect cannot express rides the prompt instead", () => {
    const closedBranch = (marker: string): Record<string, unknown> => ({
      type: "object",
      properties: { kind: { type: "string", const: marker } },
      required: ["kind"],
      additionalProperties: false,
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        "a free-form object with no declared properties",
        { type: "object" },
        "$",
      ],
      [
        "an explicitly open object",
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: true,
        },
        "$",
      ],
      [
        "a nested free-form object",
        {
          type: "object",
          properties: { extra: { type: "object" } },
          required: ["extra"],
          additionalProperties: false,
        },
        "$.properties.extra",
      ],
      [
        "a free-form object inside array items",
        {
          type: "object",
          properties: { rows: { type: "array", items: { type: "object" } } },
          required: ["rows"],
          additionalProperties: false,
        },
        "$.properties.rows.items",
      ],
      ["a oneOf root", { oneOf: [closedBranch("a"), closedBranch("b")] }, "$"],
    ])("%s", (_, schema, path) => {
      const structured = resolveCodexStructuredOutput(schema);

      expect(structured.transport).toBe("prompt_contract");
      expect(structured.outputSchema).toBeUndefined();
      expect(structured.reason).toContain(path);
    });

    it("appends the rendered contract to a string prompt and to the text item of an image prompt", () => {
      const schema = { type: "object" };
      const structured = resolveCodexStructuredOutput(schema);
      const instruction = renderStructuredOutputInstruction(schema);

      expect(structured.prepareInput("Describe it")).toBe(
        `Describe it\n\n${instruction}`,
      );
      expect(
        structured.prepareInput([
          { type: "text", text: "Describe it" },
          { type: "local_image", path: "/tmp/a.png" },
        ]),
      ).toEqual([
        { type: "text", text: `Describe it\n\n${instruction}` },
        { type: "local_image", path: "/tmp/a.png" },
      ]);
      expect(
        structured.prepareInput([{ type: "local_image", path: "/tmp/a.png" }]),
      ).toEqual([
        { type: "local_image", path: "/tmp/a.png" },
        { type: "text", text: instruction },
      ]);
    });

    it("does not read nulls back as omissions, since nothing was projected", () => {
      const structured = resolveCodexStructuredOutput({ type: "object" });

      expect(structured.restore({ note: null })).toEqual({ note: null });
    });
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

/**
 * The rule the provider stated when it refused execution cc44014e with HTTP
 * 400: "'additionalProperties' is required to be supplied and to be false".
 * Walked over the whole projected schema, since the provider reports only the
 * first offending node.
 */
function objectNodesNotClosed(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      objectNodesNotClosed(entry, `${path}[${index}]`),
    );
  }
  if (typeof schema !== "object" || schema === null) return [];

  const node = schema as Record<string, unknown>;
  const violations: string[] = [];
  if (node.type === "object" && node.additionalProperties !== false) {
    violations.push(path);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "properties" && typeof child === "object" && child !== null) {
      for (const [name, property] of Object.entries(
        child as Record<string, unknown>,
      )) {
        violations.push(
          ...objectNodesNotClosed(property, `${path}.properties.${name}`),
        );
      }
      continue;
    }
    violations.push(...objectNodesNotClosed(child, `${path}.${key}`));
  }
  return violations;
}

/**
 * The authored shape that halted execution cc44014e: every object node declares
 * its properties and required keys but none says `additionalProperties`.
 */
function measurePayloadMaximaSchema(): Record<string, unknown> {
  const observation = {
    type: "object",
    properties: { file: { type: "string" }, max: { type: "integer" } },
    required: ["max", "file"],
  };
  return {
    type: "object",
    properties: {
      notes: { type: "string" },
      observed: {
        type: "object",
        properties: {
          manifestNodes: observation,
          manifestDepth: observation,
        },
        required: ["manifestNodes", "manifestDepth"],
      },
      recommendedCaps: {
        type: "object",
        properties: {
          manifestNodes: { type: "integer" },
          manifestDepth: { type: "integer" },
        },
        required: ["manifestNodes", "manifestDepth"],
      },
    },
    required: ["observed", "recommendedCaps"],
  };
}

describe("projectSchemaForCodex closes every object node", () => {
  it("supplies additionalProperties: false on every object the authored schema left open", () => {
    const schema = measurePayloadMaximaSchema();

    expect(objectNodesNotClosed(schema)).not.toEqual([]);
    expect(objectNodesNotClosed(projectSchemaForCodex(schema))).toEqual([]);
  });

  it("closes an object nested under an authored-optional key, inside array items, and inside oneOf branches", () => {
    const projected = projectSchemaForCodex({
      type: "object",
      properties: {
        maybe: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        list: {
          type: "array",
          items: {
            type: "object",
            properties: { b: { type: "string" } },
            required: ["b"],
          },
        },
        choice: {
          oneOf: [
            {
              type: "object",
              properties: { k: { const: "x" } },
              required: ["k"],
            },
            {
              type: "object",
              properties: { k: { const: "y" } },
              required: ["k"],
            },
          ],
        },
      },
      required: ["list", "choice"],
    });

    expect(objectNodesNotClosed(projected)).toEqual([]);
  });

  it("leaves the authored schema untouched", () => {
    const schema = measurePayloadMaximaSchema();
    const before = JSON.stringify(schema);
    projectSchemaForCodex(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });
});
