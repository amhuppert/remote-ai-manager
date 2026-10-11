import { describe, expect, it } from "vitest";
import {
  lintGuardEnumCoverage,
  validateEdgeGuards,
  type GuardBearingEdge,
  type GuardSourceContext,
} from "./edge-guard-validation";

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
} as const;

function classifier(
  overrides: Partial<GuardSourceContext> = {},
): GuardSourceContext {
  return {
    id: "classify",
    outputSchema: { ...CLASSIFIER_OUTPUT_SCHEMA },
    ...overrides,
  };
}

function contexts(...extra: GuardSourceContext[]): GuardSourceContext[] {
  return [classifier(), { id: "approve" }, { id: "reject" }, ...extra];
}

function edge(
  id: string,
  when?: GuardBearingEdge["when"],
  targetContextId = "approve",
): GuardBearingEdge {
  return {
    id,
    sourceContextId: "classify",
    targetContextId,
    ...(when !== undefined ? { when } : {}),
  };
}

/**
 * A document whose keys live on the PROTOTYPE, not on itself — the adversarial
 * shape an own-property read must ignore: nothing here is part of the JSON the
 * author wrote.
 */
function inheriting(
  inherited: Record<string, unknown>,
): Record<string, unknown> {
  return Object.create(inherited) as Record<string, unknown>;
}

function guard(properties: Record<string, unknown>): GuardBearingEdge["when"] {
  return {
    schema: {
      type: "object",
      properties,
      required: Object.keys(properties),
    },
  };
}

describe("validateEdgeGuards — dormant on unconditional edges", () => {
  it("returns no errors for a graph whose edges carry no guard", () => {
    expect(
      validateEdgeGuards(contexts(), [edge("e1"), edge("e2", undefined)]),
    ).toEqual([]);
  });

  it("accepts a guard whose document is subset-valid and source-compatible", () => {
    expect(
      validateEdgeGuards(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge(
          "reject-edge",
          guard({ verdict: { enum: ["reject", "escalate"] } }),
          "reject",
        ),
      ]),
    ).toEqual([]);
  });
});

describe("validateEdgeGuards — source must declare an outputSchema", () => {
  it("refuses a guard-bearing edge whose source declares no outputSchema", () => {
    const errors = validateEdgeGuards(
      [classifier({ outputSchema: undefined }), { id: "approve" }],
      [edge("approve-edge", guard({ verdict: { const: "approve" } }))],
    );

    expect(errors).toEqual([
      {
        code: "guard-source-without-output-schema",
        message: expect.stringContaining("approve-edge"),
        contextId: "classify",
        edgeId: "approve-edge",
        field: "edges[0].when",
      },
    ]);
  });

  it("refuses an else edge whose source declares no outputSchema", () => {
    const errors = validateEdgeGuards(
      [classifier({ outputSchema: undefined }), { id: "approve" }],
      [edge("fallback", { else: true })],
    );

    expect(errors.map((error) => error.code)).toEqual([
      "guard-source-without-output-schema",
    ]);
  });

  it("does not refuse an unconditional edge from a schema-less source", () => {
    expect(
      validateEdgeGuards(
        [classifier({ outputSchema: undefined }), { id: "approve" }],
        [edge("plain")],
      ),
    ).toEqual([]);
  });
});

describe("validateEdgeGuards — guard document must satisfy the schema subset", () => {
  it("refuses an unsupported keyword, locating it inside the guard document", () => {
    const errors = validateEdgeGuards(contexts(), [
      edge(
        "approve-edge",
        guard({ verdict: { type: "string", format: "email" } }),
      ),
    ]);

    expect(errors).toEqual([
      {
        code: "unsupported-guard-schema",
        message: expect.stringContaining("`format`"),
        contextId: "classify",
        edgeId: "approve-edge",
        field: "edges[0].when.schema.properties.verdict.format",
      },
    ]);
  });

  it("refuses a guard document that does not describe an object payload", () => {
    const errors = validateEdgeGuards(contexts(), [
      edge("approve-edge", { schema: { type: "string" } }),
    ]);

    expect(errors.map((error) => error.field)).toEqual([
      "edges[0].when.schema",
    ]);
    expect(errors[0]?.code).toBe("unsupported-guard-schema");
  });

  it("reports every subset violation rather than stopping at the first", () => {
    const errors = validateEdgeGuards(contexts(), [
      edge(
        "approve-edge",
        guard({
          verdict: { type: "string", format: "email" },
          score: { type: "number", multipleOf: 2 },
        }),
      ),
    ]);

    expect(errors.map((error) => error.field)).toEqual([
      "edges[0].when.schema.properties.verdict.format",
      "edges[0].when.schema.properties.score.multipleOf",
    ]);
  });
});

describe("validateEdgeGuards — compatibility walk against the source schema", () => {
  // The walk's cases live with it in `runs/guard-compatibility.test.ts`; these
  // check that its issues are located on the edge's guard.
  it("refuses a guard property the source schema never declares", () => {
    const errors = validateEdgeGuards(contexts(), [
      edge("approve-edge", guard({ verdcit: { const: "approve" } })),
    ]);

    expect(errors).toEqual([
      {
        code: "incompatible-guard-schema",
        message: expect.stringContaining("verdcit"),
        contextId: "classify",
        edgeId: "approve-edge",
        field: "edges[0].when.schema.properties.verdcit",
      },
    ]);
  });

  it("refuses a guard compatible with no source oneOf branch", () => {
    const source: GuardSourceContext = {
      id: "classify",
      outputSchema: {
        oneOf: [
          {
            type: "object",
            properties: { kind: { const: "done" } },
            required: ["kind"],
          },
          {
            type: "object",
            properties: { kind: { const: "retry" } },
            required: ["kind"],
          },
        ],
      },
    };

    const errors = validateEdgeGuards(
      [source, { id: "approve" }],
      [edge("approve-edge", guard({ elapsed: { type: "number" } }))],
    );

    expect(errors.map((error) => error.code)).toEqual([
      "incompatible-guard-schema",
    ]);
    expect(errors[0]?.field).toBe("edges[0].when.schema");
  });
});

describe("validateEdgeGuards — at most one else edge per source", () => {
  it("accepts a single else edge alongside conditional siblings", () => {
    expect(
      validateEdgeGuards(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge("fallback", { else: true }, "reject"),
      ]),
    ).toEqual([]);
  });

  it("refuses the second else edge on one source, naming that edge", () => {
    const errors = validateEdgeGuards(contexts(), [
      edge("fallback-a", { else: true }),
      edge("fallback-b", { else: true }, "reject"),
    ]);

    expect(errors).toEqual([
      {
        code: "duplicate-else-edge",
        message: expect.stringContaining("fallback-b"),
        contextId: "classify",
        edgeId: "fallback-b",
        field: "edges[1].when.else",
      },
    ]);
  });

  it("allows one else edge per source across several sources", () => {
    const errors = validateEdgeGuards(
      [
        classifier(),
        { id: "second", outputSchema: { type: "object" } },
        { id: "approve" },
        { id: "reject" },
      ],
      [
        edge("fallback-a", { else: true }),
        {
          id: "fallback-b",
          sourceContextId: "second",
          targetContextId: "reject",
          when: { else: true },
        },
      ],
    );

    expect(errors).toEqual([]);
  });
});

describe("lintGuardEnumCoverage — R3.2", () => {
  it("warns naming the uncovered values when a closed enum is partly branched with no else edge", () => {
    const warnings = lintGuardEnumCoverage(contexts(), [
      edge("approve-edge", guard({ verdict: { const: "approve" } })),
      edge("reject-edge", guard({ verdict: { const: "reject" } }), "reject"),
    ]);

    expect(warnings).toEqual([
      {
        code: "uncovered-guard-enum-values",
        message: expect.stringContaining('"escalate"'),
        contextId: "classify",
        field: "executionContexts[0].outputSchema.properties.verdict.enum",
      },
    ]);
    expect(warnings[0]?.message).toContain("verdict");
  });

  it("counts an enum guard's whole value list as covered", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge(
          "rest-edge",
          guard({ verdict: { enum: ["reject", "escalate"] } }),
          "reject",
        ),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the source carries an else edge", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge("fallback", { else: true }, "reject"),
      ]),
    ).toEqual([]);
  });

  it("stays silent when a guard also constrains the payload's other properties", () => {
    // `additionalProperties: false` forbids every field the guard does not name,
    // so the guard tests more than one top-level field and falls outside the
    // analysed simple case.
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", {
          schema: {
            type: "object",
            properties: { verdict: { const: "approve" } },
            required: ["verdict"],
            additionalProperties: false,
          },
        }),
        edge("reject-edge", guard({ verdict: { const: "reject" } }), "reject"),
      ]),
    ).toEqual([]);
  });

  it("stays silent for a guard whose schema is inherited rather than declared", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge(
          "approve-edge",
          inheriting({
            schema: {
              type: "object",
              properties: { verdict: { const: "approve" } },
              required: ["verdict"],
            },
          }) as GuardBearingEdge["when"],
        ),
      ]),
    ).toEqual([]);
  });

  it("stays silent for a guard whose properties are inherited rather than declared", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", {
          schema: inheriting({
            type: "object",
            properties: { verdict: { const: "approve" } },
            required: ["verdict"],
          }),
        }),
      ]),
    ).toEqual([]);
  });

  it("stays silent for a guard whose tested value set is inherited rather than declared", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", {
          schema: {
            type: "object",
            properties: { verdict: inheriting({ const: "approve" }) },
            required: ["verdict"],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the source's properties are inherited rather than declared", () => {
    const inheritedSource: GuardSourceContext = {
      id: "classify",
      outputSchema: inheriting({
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approve", "reject"] },
        },
      }),
    };

    expect(
      lintGuardEnumCoverage(
        [inheritedSource, { id: "approve" }],
        [edge("approve-edge", guard({ verdict: { const: "approve" } }))],
      ),
    ).toEqual([]);
  });

  it("stays silent when the source field's value set is inherited rather than declared", () => {
    const inheritedEnum: GuardSourceContext = {
      id: "classify",
      outputSchema: {
        type: "object",
        properties: {
          verdict: inheriting({ type: "string", enum: ["approve", "reject"] }),
        },
        required: ["verdict"],
      },
    };

    expect(
      lintGuardEnumCoverage(
        [inheritedEnum, { id: "approve" }],
        [edge("approve-edge", guard({ verdict: { const: "approve" } }))],
      ),
    ).toEqual([]);
  });

  it("stays silent for a guard testing a deeper path", () => {
    const nested: GuardSourceContext = {
      id: "classify",
      outputSchema: {
        type: "object",
        properties: {
          result: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["approve", "reject"] },
            },
            required: ["verdict"],
          },
        },
        required: ["result"],
      },
    };

    expect(
      lintGuardEnumCoverage(
        [nested, { id: "approve" }],
        [
          edge(
            "approve-edge",
            guard({
              result: {
                type: "object",
                properties: { verdict: { const: "approve" } },
                required: ["verdict"],
              },
            }),
          ),
        ],
      ),
    ).toEqual([]);
  });

  it("stays silent when any guard from the source tests more than one field", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge(
          "reject-edge",
          guard({ verdict: { const: "reject" }, score: { const: 1 } }),
          "reject",
        ),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the guards from one source test different fields", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge("score-edge", guard({ score: { const: 1 } }), "reject"),
      ]),
    ).toEqual([]);
  });

  it("stays silent for a non-enum guard form on the tested field", () => {
    expect(
      lintGuardEnumCoverage(contexts(), [
        edge("typed-edge", guard({ verdict: { type: "string" } })),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the source field declares no closed value set", () => {
    const open: GuardSourceContext = {
      id: "classify",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
    };

    expect(
      lintGuardEnumCoverage(
        [open, { id: "approve" }],
        [edge("approve-edge", guard({ verdict: { const: "approve" } }))],
      ),
    ).toEqual([]);
  });

  it("reports each under-covered source once, in definition order", () => {
    const second: GuardSourceContext = {
      id: "second",
      outputSchema: {
        type: "object",
        properties: { mode: { type: "string", enum: ["fast", "slow"] } },
        required: ["mode"],
      },
    };

    const warnings = lintGuardEnumCoverage(
      [classifier(), second, { id: "approve" }, { id: "reject" }],
      [
        edge("approve-edge", guard({ verdict: { const: "approve" } })),
        edge("reject-edge", guard({ verdict: { const: "reject" } }), "reject"),
        {
          id: "fast-edge",
          sourceContextId: "second",
          targetContextId: "approve",
          when: {
            schema: {
              type: "object",
              properties: { mode: { const: "fast" } },
              required: ["mode"],
            },
          },
        },
      ],
    );

    expect(
      warnings.map(({ contextId, field }) => ({ contextId, field })),
    ).toEqual([
      {
        contextId: "classify",
        field: "executionContexts[0].outputSchema.properties.verdict.enum",
      },
      {
        contextId: "second",
        field: "executionContexts[1].outputSchema.properties.mode.enum",
      },
    ]);
  });

  it("returns nothing for a graph whose edges carry no guard", () => {
    expect(lintGuardEnumCoverage(contexts(), [edge("e1"), edge("e2")])).toEqual(
      [],
    );
  });
});
