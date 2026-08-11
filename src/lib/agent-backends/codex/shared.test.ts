import { describe, expect, it } from "vitest";
import { projectSchemaForCodex } from "./shared";

describe("projectSchemaForCodex", () => {
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
    };

    expect(projectSchemaForCodex(schema)).toEqual(schema);
  });
});
