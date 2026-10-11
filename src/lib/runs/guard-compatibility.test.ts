import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCHEMA_SUPPORTED_KEYWORDS,
  validateJsonSchemaSubset,
} from "@/lib/workflows/primitives/output-schema-subset";
import {
  checkGuardCompatibility,
  GUARD_COMPATIBILITY_KEYWORD_ROLES,
} from "./guard-compatibility";

const CLASSIFIER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "reject", "escalate"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "high"] },
        },
        required: ["severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict"],
  additionalProperties: false,
};

function guard(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties };
}

const pathsOf = (guardSchema: Record<string, unknown>) =>
  checkGuardCompatibility(guardSchema, CLASSIFIER_OUTPUT_SCHEMA).map(
    (issue) => issue.path,
  );

describe("GUARD_COMPATIBILITY_KEYWORD_ROLES", () => {
  it("classifies every keyword the shared subset descriptor supports", () => {
    const supported = Object.values(OUTPUT_SCHEMA_SUPPORTED_KEYWORDS)
      .flat()
      .sort();
    const classified = Object.keys(GUARD_COMPATIBILITY_KEYWORD_ROLES).sort();

    expect(classified).toEqual(supported);
  });
});

describe("numeric guard overlap", () => {
  it.each([
    { sourceType: "integer", guardType: "number" },
    { sourceType: "number", guardType: "integer" },
    { sourceType: ["integer", "null"], guardType: ["number", "string"] },
    { sourceType: ["number", "null"], guardType: "integer" },
  ])(
    "accepts an integer witness for $sourceType and $guardType",
    ({ sourceType, guardType }) => {
      const sourceSchema = guard({ score: { type: sourceType } });
      const guardSchema = guard({ score: { type: guardType } });
      expect(validateJsonSchemaSubset(sourceSchema, { score: 2 }).valid).toBe(
        true,
      );
      expect(validateJsonSchemaSubset(guardSchema, { score: 2 }).valid).toBe(
        true,
      );
      expect(checkGuardCompatibility(guardSchema, sourceSchema)).toEqual([]);
    },
  );
});

describe("checkGuardCompatibility", () => {
  it("accepts a guard the source can satisfy", () => {
    expect(pathsOf(guard({ verdict: { const: "approve" } }))).toEqual([]);
  });

  it("refuses a guard property the source schema never declares", () => {
    const issues = checkGuardCompatibility(
      guard({ verdcit: { const: "approve" } }),
      CLASSIFIER_OUTPUT_SCHEMA,
    );

    expect(issues).toEqual([
      {
        path: "$.properties.verdcit",
        message: expect.stringContaining("verdcit"),
      },
    ]);
  });

  it("refuses a const the source's enum can never produce", () => {
    const issues = checkGuardCompatibility(
      guard({ verdict: { const: "aprove" } }),
      CLASSIFIER_OUTPUT_SCHEMA,
    );

    expect(issues).toEqual([
      {
        path: "$.properties.verdict.const",
        message: expect.stringContaining("approve, reject, escalate"),
      },
    ]);
  });

  it("locates an unsatisfiable enum member by index", () => {
    expect(pathsOf(guard({ verdict: { enum: ["approve", "nope"] } }))).toEqual([
      "$.properties.verdict.enum[1]",
    ]);
  });

  it("refuses a guard type that cannot intersect the source type", () => {
    expect(pathsOf(guard({ score: { type: "string" } }))).toEqual([
      "$.properties.score.type",
    ]);
  });

  it("refuses a required property the source schema never declares", () => {
    expect(
      pathsOf({
        type: "object",
        properties: { verdict: { const: "approve" } },
        required: ["verdict", "ghost"],
      }),
    ).toEqual(["$.required[1]"]);
  });

  it("walks into array items", () => {
    expect(
      pathsOf(
        guard({
          findings: {
            type: "array",
            minItems: 1,
            items: guard({ severity: { const: "high" } }),
          },
        }),
      ),
    ).toEqual([]);
    expect(
      pathsOf(
        guard({
          findings: {
            type: "array",
            items: guard({ sevrity: { const: "high" } }),
          },
        }),
      ),
    ).toEqual(["$.properties.findings.items.properties.sevrity"]);
  });

  it("accepts a guard oneOf branch set whose branches are each compatible", () => {
    expect(
      pathsOf({
        oneOf: [
          {
            ...guard({ verdict: { const: "approve" } }),
            required: ["verdict"],
          },
          {
            ...guard({ verdict: { const: "escalate" } }),
            required: ["verdict"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("locates the incompatible branch of a guard oneOf", () => {
    expect(
      pathsOf({
        oneOf: [
          {
            ...guard({ verdict: { const: "approve" } }),
            required: ["verdict"],
          },
          { ...guard({ verdict: { const: "nope" } }), required: ["verdict"] },
        ],
      }),
    ).toEqual(["$.oneOf[1].properties.verdict.const"]);
  });

  it("accepts a guard compatible with at least one source oneOf branch", () => {
    const source = {
      oneOf: [
        { ...guard({ kind: { const: "done" } }), required: ["kind"] },
        {
          ...guard({
            kind: { const: "retry" },
            attempt: { type: "integer" },
          }),
          required: ["kind"],
        },
      ],
    };

    expect(
      checkGuardCompatibility(
        guard({ attempt: { type: "integer", minimum: 2 } }),
        source,
      ),
    ).toEqual([]);
  });

  it("refuses a guard compatible with no source oneOf branch, at the guard's root", () => {
    const source = {
      oneOf: [
        { ...guard({ kind: { const: "done" } }), required: ["kind"] },
        { ...guard({ kind: { const: "retry" } }), required: ["kind"] },
      ],
    };

    expect(
      checkGuardCompatibility(
        guard({ elapsed: { type: "number" } }),
        source,
      ).map((issue) => issue.path),
    ).toEqual(["$"]);
  });

  it("reads guard and source properties as own properties only", () => {
    const source = {
      ...guard({ verdict: { type: "string" } }),
      required: ["verdict"],
    };
    // Built through JSON.parse, not a literal: `{ __proto__: … }` in an object
    // literal sets the prototype instead of creating the own property this case
    // is about. `constructor` and `toString` resolve on Object.prototype, so a
    // walk using `in`/bare indexing would read the source schema as declaring
    // them and pass an unsatisfiable guard.
    const adversarialGuard: Record<string, unknown> = JSON.parse(
      `{"type":"object","properties":{
         "__proto__":{"type":"string"},
         "constructor":{"type":"string"},
         "toString":{"type":"string"}
       }}`,
    );

    expect(
      checkGuardCompatibility(adversarialGuard, source).map(
        (issue) => issue.path,
      ),
    ).toEqual([
      "$.properties.__proto__",
      "$.properties.constructor",
      "$.properties.toString",
    ]);
  });
});
