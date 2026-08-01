import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCHEMA_ANNOTATION_KEYWORDS,
  OUTPUT_SCHEMA_SUPPORTED_KEYWORDS,
  UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS,
  outputSchemaKeywordGuidance,
  validateJsonSchemaSubset,
  validateOutputSchemaDeclaration,
} from "./output-schema-subset";

const paths = (issues: ReadonlyArray<{ path: string }>): string[] =>
  issues.map((issue) => issue.path);

describe("validateOutputSchemaDeclaration (authoring-time subset gate)", () => {
  it("accepts a nested declaration built only from enforced keywords", () => {
    // The same document shape the runtime gate validates values against: if the
    // walker rejected this, the editor would flag a schema the server happily
    // enforces.
    expect(
      validateOutputSchemaDeclaration({
        type: "object",
        additionalProperties: false,
        required: ["summary", "items"],
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 500 },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "done"],
              properties: {
                id: { type: "string", pattern: "^T-[0-9]+$" },
                done: { type: "boolean" },
                score: { type: "number", minimum: 0, maximum: 1 },
                verdict: { type: "string", enum: ["pass", "fail"] },
                marker: { const: "fixed" },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("accepts annotation keywords that make no enforcement claim", () => {
    expect(
      validateOutputSchemaDeclaration({
        type: "object",
        title: "Review verdict",
        description: "What the reviewer concluded.",
        properties: {
          verdict: {
            type: "string",
            description: "Keep this under 80 characters.",
          },
        },
      }),
    ).toEqual([]);
  });

  it("refuses a declaration that is not an object at all", () => {
    expect(validateOutputSchemaDeclaration("type: object")).toHaveLength(1);
    expect(validateOutputSchemaDeclaration([{ type: "object" }])).toHaveLength(
      1,
    );
    expect(validateOutputSchemaDeclaration(null)).toHaveLength(1);
  });

  it("refuses a root that does not describe an object", () => {
    const issues = validateOutputSchemaDeclaration({ type: "string" });
    expect(paths(issues)).toEqual(["$"]);
    expect(issues[0]?.message).toMatch(/object/i);
  });

  it("accepts a root whose object shape is implied by `properties` alone", () => {
    // No `type`, but `hasObjectShape` routes this into object validation at
    // runtime, so refusing it would be a lie about the server's behavior.
    const schema = { properties: { verdict: { type: "string" } } };
    expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
    expect(validateJsonSchemaSubset(schema, { verdict: 1 }).valid).toBe(false);
  });

  describe("oneOf", () => {
    it("supports oneOf — the handoff prototype's contrary list was a bug", () => {
      expect(
        validateOutputSchemaDeclaration({
          type: "object",
          properties: {
            outcome: {
              oneOf: [
                {
                  type: "object",
                  required: ["ok"],
                  properties: { ok: { type: "boolean" } },
                },
                {
                  type: "object",
                  required: ["error"],
                  properties: { error: { type: "string" } },
                },
              ],
            },
          },
        }),
      ).toEqual([]);
    });

    it("accepts a root that is a oneOf over object branches", () => {
      // A discriminated payload is a legitimate object-describing root: the
      // requirement lands on each branch, not on the `oneOf` node itself.
      const schema = {
        oneOf: [
          {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        ],
      };

      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      expect(validateJsonSchemaSubset(schema, { ok: true }).valid).toBe(true);
      expect(validateJsonSchemaSubset(schema, { nope: 1 }).valid).toBe(false);
    });

    it("does not let a non-schema branch vacuously satisfy a oneOf at runtime", () => {
      // Such a branch is refused at authoring time, so this only matters for a
      // schema stored before that check existed — but "any value passes"
      // silently is the worst possible failure mode for an output contract.
      const schema = {
        type: "object",
        properties: { f: { oneOf: ["junk", { type: "string" }] } },
      };

      expect(validateJsonSchemaSubset(schema, { f: 5 }).valid).toBe(false);
      expect(validateJsonSchemaSubset(schema, { f: "ok" }).valid).toBe(true);
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.f.oneOf[0]",
      ]);
    });

    it("locates a non-object branch of a root oneOf at that branch", () => {
      const issues = validateOutputSchemaDeclaration({
        oneOf: [
          { type: "object", properties: { ok: { type: "boolean" } } },
          { type: "string" },
        ],
      });

      expect(paths(issues)).toEqual(["$.oneOf[1]"]);
    });
  });

  describe("keywords the runtime validator never reads", () => {
    it.each([
      ["$ref", { $ref: "#/$defs/finding" }],
      ["$defs", { $defs: { finding: { type: "string" } } }],
      ["anyOf", { anyOf: [{ type: "object" }] }],
      ["allOf", { allOf: [{ type: "object" }] }],
      ["format", { format: "uri" }],
    ])(
      "refuses the unsupported keyword %s with its own guidance message",
      (keyword, extra) => {
        const issues = validateOutputSchemaDeclaration({
          type: "object",
          properties: { field: { type: "string", ...extra } },
        });

        expect(paths(issues)).toContain(`$.properties.field.${keyword}`);
        const issue = issues.find(
          (candidate) => candidate.path === `$.properties.field.${keyword}`,
        );
        expect(issue?.message).toBe(
          UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.get(keyword),
        );
      },
    );

    it("refuses an unknown keyword with generic guidance naming the supported set", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: { field: { type: "string", frobnicate: true } },
      });

      expect(paths(issues)).toEqual(["$.properties.field.frobnicate"]);
      expect(issues[0]?.message).toContain("frobnicate");
    });

    it("locates an unsupported keyword nested inside array items and oneOf branches", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: { type: "string", format: "email" },
          },
          outcome: {
            oneOf: [
              { type: "object", properties: { ok: { $ref: "#/x" } } },
              { type: "object", properties: { err: { type: "string" } } },
            ],
          },
        },
      });

      expect(paths(issues)).toEqual(
        expect.arrayContaining([
          "$.properties.findings.items.format",
          "$.properties.outcome.oneOf[0].properties.ok.$ref",
        ]),
      );
    });

    it("refuses `format` at authoring time precisely because the gate never enforces it", () => {
      const schema = {
        type: "object",
        properties: { f: { type: "string", format: "email" } },
      };

      // The runtime gate accepts a value that plainly violates the format...
      expect(
        validateJsonSchemaSubset(schema, { f: "not-an-email" }).valid,
      ).toBe(true);
      // ...so the declaration is refused up front rather than shipping a
      // constraint the author believes is running.
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.f.format",
      ]);
    });
  });

  describe("type-specific keywords the declared type never selects", () => {
    it("refuses a string keyword on an array node", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: { tags: { type: "array", minLength: 2 } },
      });

      expect(paths(issues)).toEqual(["$.properties.tags.minLength"]);
    });

    it.each([
      ["minLength", { minLength: 2 }, "a"],
      ["maxLength", { maxLength: 1 }, "abc"],
      ["pattern", { pattern: "^a$" }, "zzz"],
      ["minItems", { minItems: 2 }, []],
      ["maxItems", { maxItems: 0 }, ["x"]],
      ["minimum", { minimum: 5 }, 1],
      ["maximum", { maximum: 5 }, 9],
    ])(
      "refuses %s when the node declares no type, because the runtime dispatch then reads nothing",
      (keyword, constraint, violatingValue) => {
        const schema = {
          type: "object",
          properties: { f: { ...constraint } },
        };

        // Proof the refusal is honest: the runtime accepts a plainly violating
        // value, because with no `type` the dispatch reaches no branch at all.
        expect(
          validateJsonSchemaSubset(schema, { f: violatingValue }).valid,
        ).toBe(true);
        expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
          `$.properties.f.${keyword}`,
        ]);
      },
    );

    it("refuses a type-specific keyword beside a union type, which reaches no branch", () => {
      const schema = {
        type: "object",
        properties: { f: { type: ["string", "null"], minLength: 3 } },
      };

      expect(validateJsonSchemaSubset(schema, { f: "a" }).valid).toBe(true);
      const issues = validateOutputSchemaDeclaration(schema);
      expect(paths(issues)).toEqual(["$.properties.f.minLength"]);
      expect(issues[0]?.message).toMatch(/union/i);
    });

    it("keeps a union type itself supported when it carries no type-specific constraint", () => {
      const schema = {
        type: "object",
        properties: { f: { type: ["string", "null"] } },
      };

      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      expect(validateJsonSchemaSubset(schema, { f: null }).valid).toBe(true);
      expect(validateJsonSchemaSubset(schema, { f: 3 }).valid).toBe(false);
    });
  });

  describe("short-circuit keywords", () => {
    it("refuses sibling constraints alongside oneOf, including `type`", () => {
      // The runtime returns at `oneOf` before it reads `type` or anything else.
      const schema = {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            oneOf: [{ type: "string" }, { type: "number" }],
            minLength: 3,
          },
        },
      };

      expect(validateJsonSchemaSubset(schema, { outcome: "ab" }).valid).toBe(
        true,
      );
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual(
        expect.arrayContaining([
          "$.properties.outcome.type",
          "$.properties.outcome.minLength",
        ]),
      );
    });

    it("refuses `type` beside `const`, which the runtime never reaches", () => {
      const schema = {
        type: "object",
        properties: { marker: { type: "number", const: "fixed" } },
      };

      // `const` returns before the type check, so the contradictory `type` is
      // never applied — the value passes on the const alone.
      expect(validateJsonSchemaSubset(schema, { marker: "fixed" }).valid).toBe(
        true,
      );
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.marker.type",
      ]);
    });

    it("keeps `enum` live beside `const`, because the runtime checks enum first", () => {
      const schema = {
        type: "object",
        properties: { marker: { enum: ["fixed", "other"], const: "fixed" } },
      };

      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      expect(validateJsonSchemaSubset(schema, { marker: "nope" }).valid).toBe(
        false,
      );
    });

    it("prefers oneOf over const when both are present, matching the runtime order", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: {
          outcome: {
            oneOf: [{ type: "string" }, { type: "number" }],
            const: "x",
            enum: ["x"],
          },
        },
      });

      expect(paths(issues)).toEqual(
        expect.arrayContaining([
          "$.properties.outcome.const",
          "$.properties.outcome.enum",
        ]),
      );
      expect(issues.every((issue) => issue.message.includes("`oneOf`"))).toBe(
        true,
      );
    });
  });

  describe("values compared by reference", () => {
    it("refuses an object-valued const, which no parsed payload can equal", () => {
      const schema = {
        type: "object",
        properties: { shape: { const: { a: 1 } } },
      };

      // Structurally identical input still fails: `!==` is reference equality.
      expect(validateJsonSchemaSubset(schema, { shape: { a: 1 } }).valid).toBe(
        false,
      );
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.shape.const",
      ]);
    });

    it("refuses object and array entries in an enum", () => {
      const schema = {
        type: "object",
        properties: { shape: { enum: ["ok", { a: 1 }, [1, 2]] } },
      };

      expect(validateJsonSchemaSubset(schema, { shape: { a: 1 } }).valid).toBe(
        false,
      );
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.shape.enum[1]",
        "$.properties.shape.enum[2]",
      ]);
    });

    it("keeps primitive enum entries — including null — supported", () => {
      const schema = {
        type: "object",
        properties: { shape: { enum: ["ok", 1, true, null] } },
      };

      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      expect(validateJsonSchemaSubset(schema, { shape: null }).valid).toBe(
        true,
      );
    });
  });

  it("refuses malformed values for supported keywords", () => {
    const issues = validateOutputSchemaDeclaration({
      type: "object",
      required: ["ok", 7],
      properties: {
        ok: { type: "string", pattern: "([unclosed" },
        count: { type: "number", minimum: "zero" },
        tags: { type: "array", items: ["not-a-schema"] },
        flag: { type: "nonsense" },
      },
    });

    expect(paths(issues)).toEqual(
      expect.arrayContaining([
        "$.required[1]",
        "$.properties.ok.pattern",
        "$.properties.count.minimum",
        "$.properties.tags.items",
        "$.properties.flag.type",
      ]),
    );
  });

  it("collects every issue rather than stopping at the first", () => {
    const issues = validateOutputSchemaDeclaration({
      type: "object",
      properties: {
        a: { type: "string", format: "uri" },
        b: { type: "string", $ref: "#/x" },
      },
    });

    expect(paths(issues)).toEqual([
      "$.properties.a.format",
      "$.properties.b.$ref",
    ]);
  });
});

// The descriptor's claim is "these keywords are enforced, those are not". If
// that claim drifts from what validateJsonSchemaSubset actually does, the
// editor's errors stop corresponding to real behavior. These cases pin the
// claim behaviorally in both directions.
describe("descriptor ↔ runtime validator agreement (D2, R1.3)", () => {
  it.each([
    [
      "type",
      { type: "object", properties: { f: { type: "string" } } },
      { f: 1 },
    ],
    [
      "enum",
      { type: "object", properties: { f: { enum: ["a"] } } },
      { f: "b" },
    ],
    [
      "const",
      { type: "object", properties: { f: { const: "a" } } },
      { f: "b" },
    ],
    [
      "oneOf",
      {
        type: "object",
        properties: {
          f: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
      },
      { f: true },
    ],
    ["required", { type: "object", required: ["f"] }, {}],
    [
      "additionalProperties",
      { type: "object", additionalProperties: false, properties: {} },
      { f: 1 },
    ],
    [
      "minItems",
      { type: "object", properties: { f: { type: "array", minItems: 2 } } },
      { f: [1] },
    ],
    [
      "maxItems",
      { type: "object", properties: { f: { type: "array", maxItems: 1 } } },
      { f: [1, 2] },
    ],
    [
      "items",
      {
        type: "object",
        properties: { f: { type: "array", items: { type: "string" } } },
      },
      { f: [1] },
    ],
    [
      "minLength",
      { type: "object", properties: { f: { type: "string", minLength: 2 } } },
      { f: "a" },
    ],
    [
      "maxLength",
      { type: "object", properties: { f: { type: "string", maxLength: 1 } } },
      { f: "ab" },
    ],
    [
      "pattern",
      {
        type: "object",
        properties: { f: { type: "string", pattern: "^a$" } },
      },
      { f: "b" },
    ],
    [
      "minimum",
      { type: "object", properties: { f: { type: "number", minimum: 5 } } },
      { f: 1 },
    ],
    [
      "maximum",
      { type: "object", properties: { f: { type: "number", maximum: 5 } } },
      { f: 9 },
    ],
    [
      "properties",
      {
        type: "object",
        properties: {
          f: { type: "object", properties: { g: { type: "string" } } },
        },
      },
      { f: { g: 1 } },
    ],
  ])(
    "every keyword the descriptor calls enforced really rejects a violating value: %s",
    (keyword, schema, violatingValue) => {
      const enforced = Object.values(OUTPUT_SCHEMA_SUPPORTED_KEYWORDS).flat();
      expect(enforced).toContain(keyword);
      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      expect(validateJsonSchemaSubset(schema, violatingValue).valid).toBe(
        false,
      );
    },
  );

  it("classifies every keyword exactly once across the three buckets", () => {
    const enforced = Object.values(OUTPUT_SCHEMA_SUPPORTED_KEYWORDS).flat();
    const unsupported = [...UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.keys()];
    // `oneOf` is enforced, so it must never appear as unsupported — the exact
    // drift the single-sourced descriptor exists to prevent.
    expect(enforced).toContain("oneOf");
    expect(unsupported).not.toContain("oneOf");
    // `format` is unenforced, so it is a refusal — not a softer warning tone.
    expect(unsupported).toContain("format");
    expect(enforced).not.toContain("format");
    for (const annotation of OUTPUT_SCHEMA_ANNOTATION_KEYWORDS) {
      expect(enforced).not.toContain(annotation);
      expect(unsupported).not.toContain(annotation);
    }
  });
});

/**
 * Every defect below is a case where the walker's verdict and the runtime's
 * behavior disagreed about a schema whose property names collide with
 * `Object.prototype`, or where a locator could not name the offending key
 * unambiguously. Two root causes: prototype-inclusive `in`/index lookups, and
 * dot-joined paths that cannot survive a key containing a dot.
 *
 * `constructor` and `toString` are perfectly legal JSON property names, so the
 * fix is to read own properties — NOT to refuse the names at authoring time.
 */
describe("prototype-inclusive lookups and ambiguous locators (R1.2, R1.3)", () => {
  describe("payload keys are read as own properties", () => {
    it("reports a required property named like an inherited one as missing", () => {
      // `"constructor" in {}` is true, so an inherited key satisfied `required`
      // and a payload missing the property was accepted.
      const result = validateJsonSchemaSubset(
        { type: "object", required: ["constructor"] },
        {},
      );

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain("constructor");
    });

    it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
      "accepts a payload omitting the optional property %s instead of validating Object.prototype's value",
      (name) => {
        const schema = {
          type: "object",
          properties: { [name]: { type: "string" } },
        };

        expect(validateJsonSchemaSubset(schema, {}).valid).toBe(true);
      },
    );

    it("still validates such a property when the payload really carries it", () => {
      const schema = {
        type: "object",
        properties: { constructor: { type: "string" } },
      };

      expect(
        validateJsonSchemaSubset(schema, { constructor: "ok" }).valid,
      ).toBe(true);
      expect(validateJsonSchemaSubset(schema, { constructor: 5 }).valid).toBe(
        false,
      );
    });

    it("accepts a declaration using those names, because the runtime now handles them", () => {
      expect(
        validateOutputSchemaDeclaration({
          type: "object",
          required: ["constructor"],
          properties: {
            constructor: { type: "string" },
            toString: { type: "number" },
          },
        }),
      ).toEqual([]);
    });
  });

  describe("keyword guidance lookup is prototype-safe", () => {
    it.each(["toString", "constructor", "hasOwnProperty", "valueOf"])(
      "refuses the unknown keyword %s with a string message, not an inherited function",
      (keyword) => {
        const issues = validateOutputSchemaDeclaration({
          type: "object",
          properties: {},
          [keyword]: 1,
        });
        const issue = issues.find(
          (candidate) => candidate.path === `$.${keyword}`,
        );

        expect(typeof issue?.message).toBe("string");
        expect(issue?.message).toContain(
          "not a supported output-schema keyword",
        );
      },
    );

    it("produces a string message for every inherited name used as a keyword", () => {
      const inherited = Object.getOwnPropertyNames(Object.prototype);
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: {},
        ...Object.fromEntries(inherited.map((name) => [name, 1])),
      });

      expect(issues.length).toBeGreaterThanOrEqual(inherited.length);
      for (const issue of issues) {
        expect(typeof issue.message).toBe("string");
      }
    });

    it("exposes guidance through one prototype-safe accessor for server and UI", () => {
      expect(outputSchemaKeywordGuidance("format")).toBe(
        UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.get("format"),
      );
      expect(outputSchemaKeywordGuidance("toString")).toContain(
        "not a supported output-schema keyword",
      );
    });
  });

  describe("type arrays naming a single type", () => {
    it("accepts a singleton object type array with object keywords the runtime does enforce", () => {
      const schema = {
        type: ["object"],
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };

      expect(validateOutputSchemaDeclaration(schema)).toEqual([]);
      // Honest acceptance: object-shaped keywords route into object validation
      // regardless of how `type` is written, so both really are enforced.
      expect(validateJsonSchemaSubset(schema, { verdict: "ok" }).valid).toBe(
        true,
      );
      expect(validateJsonSchemaSubset(schema, { verdict: 1 }).valid).toBe(
        false,
      );
      expect(validateJsonSchemaSubset(schema, {}).valid).toBe(false);
    });

    it("accepts a singleton object type array at the root with no object keywords", () => {
      expect(validateOutputSchemaDeclaration({ type: ["object"] })).toEqual([]);
    });

    it("refuses a root type array that admits a non-object payload", () => {
      expect(
        paths(validateOutputSchemaDeclaration({ type: ["object", "null"] })),
      ).toEqual(["$"]);
    });

    it("keeps refusing a singleton NON-object type array carrying that type's keywords", () => {
      const schema = {
        type: "object",
        properties: { note: { type: ["string"], minLength: 3 } },
      };

      // The runtime compares `type === "string"` against an ARRAY, so it never
      // reaches the string branch: minLength is genuinely not enforced. Only
      // the object branch is reachable through an array-valued type.
      expect(validateJsonSchemaSubset(schema, { note: "a" }).valid).toBe(true);
      expect(paths(validateOutputSchemaDeclaration(schema))).toEqual([
        "$.properties.note.minLength",
      ]);
    });

    it("refuses object keywords beside a type that admits a non-object value", () => {
      const schema = {
        type: "object",
        properties: {
          f: {
            type: ["object", "null"],
            properties: { g: { type: "string" } },
          },
        },
      };

      // The union passes the type check for null and then falls into object
      // validation, which rejects null: the node cannot accept what it declares.
      expect(validateJsonSchemaSubset(schema, { f: null }).valid).toBe(false);
      const issues = validateOutputSchemaDeclaration(schema);
      expect(paths(issues)).toEqual(["$.properties.f.type"]);
      expect(issues[0]?.message).toMatch(/never/i);
    });
  });

  describe("locators name arbitrary property keys unambiguously", () => {
    it("brackets a property name containing a dot", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: { "a.b": { type: "string", format: "email" } },
      });

      expect(paths(issues)).toEqual(['$.properties["a.b"].format']);
    });

    it("distinguishes a dotted key from a genuinely nested one", () => {
      const dotted = validateOutputSchemaDeclaration({
        type: "object",
        properties: { "a.b": { type: "string", format: "email" } },
      });
      const nested = validateOutputSchemaDeclaration({
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: { b: { type: "string", format: "email" } },
          },
        },
      });

      expect(paths(nested)).toEqual(["$.properties.a.properties.b.format"]);
      expect(paths(dotted)).not.toEqual(paths(nested));
    });

    it("brackets and escapes keys carrying quotes, spaces, or brackets", () => {
      const issues = validateOutputSchemaDeclaration({
        type: "object",
        properties: { 'we"ird key[0]': { type: "string", format: "email" } },
      });

      expect(paths(issues)).toEqual(['$.properties["we\\"ird key[0]"].format']);
    });

    it("brackets a dotted key in a runtime value error too", () => {
      const result = validateJsonSchemaSubset(
        {
          type: "object",
          properties: { "a.b": { type: "string" } },
          required: ["a.b"],
        },
        { "a.b": 7 },
      );

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('$["a.b"]');
    });
  });
});
