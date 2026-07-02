import { describe, expect, it } from "vitest";

import {
  renderCharterDigest,
  renderCharterMarkdown,
} from "@/lib/workflow-graph/charter/render";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type {
  ParameterDeclaration,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";

import {
  buildLaunchInputSchema,
  forEachScannedField,
  lintParameterReferences,
  SUBSTITUTION_FIELD_SET,
  validateParameterDeclarations,
} from "./parameter-validation";

function stringParam(
  overrides: Partial<Extract<ParameterDeclaration, { type: "string" }>> = {},
): ParameterDeclaration {
  return {
    type: "string",
    name: "feature-name",
    label: "Feature name",
    required: false,
    ...overrides,
  };
}

function textParam(
  overrides: Partial<Extract<ParameterDeclaration, { type: "text" }>> = {},
): ParameterDeclaration {
  return {
    type: "text",
    name: "brief",
    label: "Brief",
    required: false,
    ...overrides,
  };
}

function enumParam(
  overrides: Partial<Extract<ParameterDeclaration, { type: "enum" }>> = {},
): ParameterDeclaration {
  return {
    type: "enum",
    name: "mode",
    label: "Mode",
    required: false,
    options: ["fast", "focus"],
    ...overrides,
  };
}

function charter(overrides: Partial<WorkflowCharter> = {}): WorkflowCharter {
  return {
    mission: "Ship the feature",
    sourcesOfTruth: [
      {
        rank: 1,
        id: "primary",
        label: "Primary source",
        type: "spec",
        locator: "spec.md",
        description: "The spec",
        accessPolicy: "worktree-relative",
      },
    ],
    ...overrides,
  };
}

function definition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: charter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Context one",
        acceptanceCriteria: "It works",
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Task one",
        instructions: "Do the thing",
        source: "user",
      },
    ],
    edges: [],
    ...overrides,
  };
}

describe("validateParameterDeclarations", () => {
  it("accepts a valid declaration set covering every type", () => {
    const parameters: ParameterDeclaration[] = [
      stringParam({ name: "feature-name", default: "auth", maxLength: 64 }),
      textParam({ name: "brief", minLength: 1 }),
      enumParam({ name: "mode", options: ["fast", "focus"], default: "fast" }),
    ];

    expect(validateParameterDeclarations(parameters)).toEqual([]);
  });

  it("accepts an empty declaration set", () => {
    expect(validateParameterDeclarations([])).toEqual([]);
  });

  describe("duplicate names (R1.5)", () => {
    it("rejects two declarations sharing the same name and identifies the conflicting name", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({ name: "shared" }),
        textParam({ name: "shared" }),
      ];

      const errors = validateParameterDeclarations(parameters);

      const duplicateErrors = errors.filter(
        (error) => error.code === "duplicate-parameter-name",
      );
      expect(duplicateErrors.length).toBeGreaterThan(0);
      for (const error of duplicateErrors) {
        expect(error.parameterName).toBe("shared");
        expect(error.message).toContain("shared");
      }
    });

    it("does not flag distinct names", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({ name: "alpha" }),
        textParam({ name: "beta" }),
      ];

      expect(
        validateParameterDeclarations(parameters).filter(
          (error) => error.code === "duplicate-parameter-name",
        ),
      ).toEqual([]);
    });
  });

  describe("enum options (R1.3)", () => {
    it("rejects an enum declaration with an empty options list", () => {
      const parameters: ParameterDeclaration[] = [
        enumParam({ name: "mode", options: [] }),
      ];

      const errors = validateParameterDeclarations(parameters);
      const optionError = errors.find(
        (error) => error.code === "empty-enum-options",
      );
      expect(optionError).toBeDefined();
      expect(optionError?.parameterName).toBe("mode");
      expect(optionError?.message).toContain("mode");
    });
  });

  describe("default conformance (R1.7)", () => {
    it("rejects an enum default that is not one of the declared options", () => {
      const parameters: ParameterDeclaration[] = [
        enumParam({
          name: "mode",
          options: ["fast", "focus"],
          default: "slow",
        }),
      ];

      const errors = validateParameterDeclarations(parameters);
      const defaultError = errors.find(
        (error) => error.code === "default-not-in-enum-options",
      );
      expect(defaultError).toBeDefined();
      expect(defaultError?.parameterName).toBe("mode");
      expect(defaultError?.message).toContain("mode");
    });

    it("accepts an enum default that is one of the declared options", () => {
      const parameters: ParameterDeclaration[] = [
        enumParam({
          name: "mode",
          options: ["fast", "focus"],
          default: "fast",
        }),
      ];

      expect(validateParameterDeclarations(parameters)).toEqual([]);
    });

    it("does not emit a default error when the enum options list is empty (already flagged)", () => {
      const parameters: ParameterDeclaration[] = [
        enumParam({ name: "mode", options: [], default: "slow" }),
      ];

      const errors = validateParameterDeclarations(parameters);
      expect(
        errors.some((error) => error.code === "default-not-in-enum-options"),
      ).toBe(false);
      expect(errors.some((error) => error.code === "empty-enum-options")).toBe(
        true,
      );
    });

    it("rejects a string default shorter than minLength", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({ name: "feature-name", default: "ab", minLength: 3 }),
      ];

      const errors = validateParameterDeclarations(parameters);
      const defaultError = errors.find(
        (error) => error.code === "default-length-out-of-bounds",
      );
      expect(defaultError).toBeDefined();
      expect(defaultError?.parameterName).toBe("feature-name");
      expect(defaultError?.message).toContain("feature-name");
    });

    it("rejects a string default longer than maxLength", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({ name: "feature-name", default: "abcdef", maxLength: 3 }),
      ];

      const errors = validateParameterDeclarations(parameters);
      expect(
        errors.some((error) => error.code === "default-length-out-of-bounds"),
      ).toBe(true);
    });

    it("rejects a text default violating length bounds", () => {
      const parameters: ParameterDeclaration[] = [
        textParam({ name: "brief", default: "", minLength: 1 }),
      ];

      const errors = validateParameterDeclarations(parameters);
      const defaultError = errors.find(
        (error) => error.code === "default-length-out-of-bounds",
      );
      expect(defaultError).toBeDefined();
      expect(defaultError?.parameterName).toBe("brief");
    });

    it("accepts a string default within length bounds", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({
          name: "feature-name",
          default: "auth",
          minLength: 1,
          maxLength: 64,
        }),
      ];

      expect(validateParameterDeclarations(parameters)).toEqual([]);
    });

    it("does not check length bounds when no default is declared", () => {
      const parameters: ParameterDeclaration[] = [
        stringParam({ name: "feature-name", minLength: 3, maxLength: 5 }),
      ];

      expect(validateParameterDeclarations(parameters)).toEqual([]);
    });
  });

  it("collects all errors across multiple declarations in declaration order", () => {
    const parameters: ParameterDeclaration[] = [
      enumParam({ name: "mode", options: [] }),
      stringParam({ name: "feature-name", default: "ab", minLength: 3 }),
      enumParam({ name: "mode", options: ["fast"], default: "fast" }),
    ];

    const errors = validateParameterDeclarations(parameters);

    const codes = errors.map((error) => error.code);
    expect(codes).toContain("empty-enum-options");
    expect(codes).toContain("default-length-out-of-bounds");
    expect(codes).toContain("duplicate-parameter-name");
  });

  it("carries the parameterName locator on every emitted error", () => {
    const parameters: ParameterDeclaration[] = [
      enumParam({ name: "mode", options: [] }),
      stringParam({ name: "feature-name", default: "ab", minLength: 3 }),
      enumParam({ name: "mode", options: ["fast"] }),
    ];

    const errors = validateParameterDeclarations(parameters);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.parameterName).toBeDefined();
      expect(error.parameterName).not.toBe("");
    }
  });
});

describe("lintParameterReferences", () => {
  const requiredFeatureName = stringParam({
    name: "feature-name",
    required: true,
  });

  describe("undeclared references rejected with a locator (R2.3)", () => {
    it("flags an undeclared reference in task instructions", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Build {{inputs.unknown-name}} now",
            source: "user",
          },
        ],
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error).toBeDefined();
      expect(error?.field).toBe("tasks[0].instructions");
      expect(error?.parameterName).toBe("unknown-name");
    });

    it("flags an undeclared reference in context acceptanceCriteria", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Context one",
            acceptanceCriteria: "Done when {{inputs.nope}}",
          },
        ],
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error).toBeDefined();
      expect(error?.field).toBe("executionContexts[0].acceptanceCriteria");
      expect(error?.parameterName).toBe("nope");
    });

    it("flags an undeclared reference in context title", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Context {{inputs.nope}}",
            acceptanceCriteria: "It works",
          },
        ],
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error?.field).toBe("executionContexts[0].title");
      expect(error?.parameterName).toBe("nope");
    });

    it("flags an undeclared reference in context description when present", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Context one",
            description: "About {{inputs.nope}}",
            acceptanceCriteria: "It works",
          },
        ],
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error?.field).toBe("executionContexts[0].description");
      expect(error?.parameterName).toBe("nope");
    });

    it("flags an undeclared reference in charter.mission", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        charter: charter({ mission: "Ship {{inputs.nope}}" }),
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error?.field).toBe("charter.mission");
      expect(error?.parameterName).toBe("nope");
    });

    it("flags an undeclared reference in a charter source description", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        charter: charter({
          sourcesOfTruth: [
            {
              rank: 1,
              id: "primary",
              label: "Primary",
              type: "spec",
              locator: "spec.md",
              description: "Covers {{inputs.nope}}",
              accessPolicy: "worktree-relative",
            },
          ],
        }),
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "undeclared-parameter-reference",
      );
      expect(error?.field).toBe("charter.sourcesOfTruth[0].description");
      expect(error?.parameterName).toBe("nope");
    });
  });

  describe("grammar violations rejected (R2.3, R2.8)", () => {
    it.each([
      ["unknown namespace", "Use {{execution.id}} here"],
      ["internal whitespace", "Use {{ inputs.feature-name }} here"],
      ["leading whitespace only", "Use {{inputs.feature-name }} here"],
      ["malformed braces", "Use {{inputs.feature-name} here"],
      ["bare literal braces", "A literal {{ sequence"],
      ["double-namespace", "Use {{inputs.inputs.x}} here"],
      ["empty token", "Use {{}} here"],
    ])(
      "rejects %s with the field and offending token",
      (_label, instructions) => {
        const def = definition({
          parameters: [requiredFeatureName],
          tasks: [
            {
              id: "task-1",
              contextId: "ctx-1",
              order: 1,
              title: "Task one",
              instructions,
              source: "user",
            },
          ],
        });

        const errors = lintParameterReferences(def);
        const error = errors.find(
          (e) => e.code === "invalid-placeholder-token",
        );
        expect(error).toBeDefined();
        expect(error?.field).toBe("tasks[0].instructions");
        expect(error?.message).toContain("{{");
      },
    );

    it("rejects a grammar violation in a charter field with the charter locator", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        charter: charter({ mission: "Ship {{ inputs.feature-name }}" }),
      });

      const errors = lintParameterReferences(def);
      const error = errors.find((e) => e.code === "invalid-placeholder-token");
      expect(error?.field).toBe("charter.mission");
    });
  });

  describe("referenced-but-valueless parameter rejected (R2.7)", () => {
    it("rejects a reference to a declared parameter that is neither required nor defaulted", () => {
      const def = definition({
        parameters: [stringParam({ name: "feature-name", required: false })],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Build {{inputs.feature-name}} now",
            source: "user",
          },
        ],
      });

      const errors = lintParameterReferences(def);
      const error = errors.find(
        (e) => e.code === "referenced-parameter-without-value",
      );
      expect(error).toBeDefined();
      expect(error?.field).toBe("tasks[0].instructions");
      expect(error?.parameterName).toBe("feature-name");
    });

    it("accepts a reference to a declared optional parameter that carries a default", () => {
      const def = definition({
        parameters: [
          stringParam({
            name: "feature-name",
            required: false,
            default: "auth",
          }),
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Build {{inputs.feature-name}} now",
            source: "user",
          },
        ],
      });

      expect(lintParameterReferences(def)).toEqual([]);
    });

    it("accepts a reference to a declared required parameter without a default", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Build {{inputs.feature-name}} now",
            source: "user",
          },
        ],
      });

      expect(lintParameterReferences(def)).toEqual([]);
    });

    it("treats an empty-string default as a value (R2.7 boundary)", () => {
      const def = definition({
        parameters: [
          stringParam({ name: "feature-name", required: false, default: "" }),
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Build {{inputs.feature-name}} now",
            source: "user",
          },
        ],
      });

      expect(
        lintParameterReferences(def).filter(
          (e) => e.code === "referenced-parameter-without-value",
        ),
      ).toEqual([]);
    });
  });

  describe("acceptance cases", () => {
    it("accepts a definition where every reference is declared and required across multiple field types", () => {
      const def = definition({
        parameters: [
          requiredFeatureName,
          textParam({ name: "brief", required: true }),
        ],
        charter: charter({ mission: "Ship {{inputs.feature-name}}" }),
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build {{inputs.feature-name}}",
            acceptanceCriteria: "Done per {{inputs.brief}}",
          },
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Implement {{inputs.feature-name}}",
            source: "user",
          },
        ],
      });

      expect(lintParameterReferences(def)).toEqual([]);
    });

    it("accepts declared-but-unused parameters including optional with no default (R2.6)", () => {
      const def = definition({
        parameters: [
          stringParam({ name: "feature-name", required: false }),
          enumParam({ name: "mode", options: ["fast", "focus"] }),
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Do the thing with no placeholders",
            source: "user",
          },
        ],
      });

      expect(lintParameterReferences(def)).toEqual([]);
    });

    it("accepts a definition with no placeholders and no parameters", () => {
      expect(lintParameterReferences(definition())).toEqual([]);
    });

    it("does not scan task titles (titles are not a content field)", () => {
      const def = definition({
        parameters: [requiredFeatureName],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Title with {{inputs.nope}} unscanned",
            instructions: "Do the thing",
            source: "user",
          },
        ],
      });

      expect(lintParameterReferences(def)).toEqual([]);
    });
  });

  it("collects violations across multiple fields in deterministic traversal order", () => {
    const def = definition({
      parameters: [requiredFeatureName],
      charter: charter({ mission: "Ship {{inputs.nope}}" }),
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "Task one",
          instructions: "Build {{inputs.other}}",
          source: "user",
        },
      ],
    });

    const errors = lintParameterReferences(def);
    const undeclared = errors.filter(
      (e) => e.code === "undeclared-parameter-reference",
    );
    expect(undeclared).toHaveLength(2);
    // Charter is traversed before content fields, so its error comes first.
    expect(undeclared[0]?.field).toBe("charter.mission");
    expect(undeclared[1]?.field).toBe("tasks[0].instructions");
  });
});

describe("buildLaunchInputSchema", () => {
  describe("enum value constraint (R3.1)", () => {
    it("accepts a value that is one of the declared options", () => {
      const schema = buildLaunchInputSchema([
        enumParam({ name: "mode", options: ["fast", "focus"], required: true }),
      ]);

      const result = schema.safeParse({ mode: "fast" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ mode: "fast" });
      }
    });

    it("rejects a value that is outside the declared options", () => {
      const schema = buildLaunchInputSchema([
        enumParam({ name: "mode", options: ["fast", "focus"], required: true }),
      ]);

      expect(schema.safeParse({ mode: "slow" }).success).toBe(false);
    });

    it("does not throw on an empty options list (accept-time error) and accepts no value", () => {
      const schema = buildLaunchInputSchema([
        enumParam({ name: "mode", options: [], required: true }),
      ]);

      expect(schema.safeParse({ mode: "fast" }).success).toBe(false);
      expect(schema.safeParse({ mode: "" }).success).toBe(false);
    });
  });

  describe("required + default (R3.3, R3.4)", () => {
    it("rejects an omitted required parameter that has no default", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true }),
      ]);

      expect(schema.safeParse({}).success).toBe(false);
    });

    it("accepts a supplied value for a required parameter", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true }),
      ]);

      const result = schema.safeParse({ "feature-name": "auth" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ "feature-name": "auth" });
      }
    });

    it("applies the declared default when the value is omitted", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", default: "auth" }),
      ]);

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ "feature-name": "auth" });
      }
    });

    it("applies an enum default when the value is omitted", () => {
      const schema = buildLaunchInputSchema([
        enumParam({
          name: "mode",
          options: ["fast", "focus"],
          default: "focus",
        }),
      ]);

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ mode: "focus" });
      }
    });

    it("prefers a supplied value over the declared default", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", default: "auth" }),
      ]);

      const result = schema.safeParse({ "feature-name": "billing" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ "feature-name": "billing" });
      }
    });

    it("accepts an omitted optional parameter that has no default", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: false }),
      ]);

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  describe("strict unknown-key rejection (R3.5)", () => {
    it("rejects a payload that supplies a name that is not a declared parameter", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true }),
      ]);

      expect(
        schema.safeParse({ "feature-name": "auth", extra: "nope" }).success,
      ).toBe(false);
    });
  });

  describe("string/text length bounds (R3.1)", () => {
    it("rejects a value shorter than minLength", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true, minLength: 3 }),
      ]);

      expect(schema.safeParse({ "feature-name": "ab" }).success).toBe(false);
    });

    it("rejects a value longer than maxLength", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true, maxLength: 3 }),
      ]);

      expect(schema.safeParse({ "feature-name": "abcd" }).success).toBe(false);
    });

    it("accepts a value within the declared length bounds", () => {
      const schema = buildLaunchInputSchema([
        stringParam({
          name: "feature-name",
          required: true,
          minLength: 1,
          maxLength: 64,
        }),
      ]);

      expect(schema.safeParse({ "feature-name": "auth" }).success).toBe(true);
    });

    it("enforces length bounds on a text parameter", () => {
      const schema = buildLaunchInputSchema([
        textParam({ name: "brief", required: true, minLength: 1 }),
      ]);

      expect(schema.safeParse({ brief: "" }).success).toBe(false);
      expect(schema.safeParse({ brief: "x" }).success).toBe(true);
    });
  });

  describe("no secret-content constraint (R3.7)", () => {
    it("accepts a string value containing secret-looking content unredacted", () => {
      const schema = buildLaunchInputSchema([
        stringParam({ name: "feature-name", required: true }),
      ]);

      const secretish = "password=hunter2 token=sk-abc123";
      const result = schema.safeParse({ "feature-name": secretish });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ "feature-name": secretish });
      }
    });
  });

  describe("zero-parameter definition (R3.6)", () => {
    it("accepts an empty payload and parses it to an empty object", () => {
      const schema = buildLaunchInputSchema([]);

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });

    it("rejects any key for a zero-parameter definition", () => {
      const schema = buildLaunchInputSchema([]);

      expect(schema.safeParse({ anything: "x" }).success).toBe(false);
    });
  });
});

describe("SUBSTITUTION_FIELD_SET drift guard", () => {
  // The charter portion of the shared field set MUST equal exactly the charter
  // text fields that charter/render.ts renders into agent prompts / docs. The
  // guard below derives the rendered set MECHANICALLY from the real render
  // functions (not a hand-maintained list), so it fails in BOTH directions:
  //   - under-registration: a charter text field render.ts renders but that is
  //     NOT in SUBSTITUTION_FIELD_SET.charterFields (the security-critical
  //     direction — an unlinted rendered field lets a {{...}} token escape to
  //     an agent as literal text), and
  //   - over-registration: a registered field render.ts never renders.

  // Stable fieldKey identifiers for every string-typed charter field. Each maps
  // to a unique sentinel so we can detect which fields surface in rendered
  // output. `source.id` is included because it IS rendered (see exclusion set
  // below); `rank` (number), `type`/`accessPolicy` (enums) cannot carry a
  // string sentinel and are therefore naturally excluded.
  const sentinelFor = (fieldKey: string): string =>
    `SENTINEL_${fieldKey.replace(/[^A-Za-z]/g, "_")}_VALUE`;

  // Build a MAXIMAL charter where every string-typed field carries its unique
  // sentinel, alongside the fieldKey each sentinel belongs to.
  function maximalSentineledCharter(): {
    charter: WorkflowCharter;
    sentinelByField: Map<string, string>;
  } {
    const allStringFieldKeys = [
      "mission",
      "conventions",
      "nonGoals",
      "vocabulary",
      "testStrategy",
      "knownAmbiguities",
      "source.id",
      "source.label",
      "source.locator",
      "source.description",
      "source.appliesTo",
    ];
    const sentinelByField = new Map(
      allStringFieldKeys.map((key) => [key, sentinelFor(key)]),
    );

    const charterValue: WorkflowCharter = {
      mission: sentinelFor("mission"),
      conventions: [sentinelFor("conventions")],
      nonGoals: [sentinelFor("nonGoals")],
      vocabulary: [sentinelFor("vocabulary")],
      testStrategy: sentinelFor("testStrategy"),
      knownAmbiguities: [sentinelFor("knownAmbiguities")],
      sourcesOfTruth: [
        {
          rank: 1,
          id: sentinelFor("source.id"),
          label: sentinelFor("source.label"),
          type: "spec",
          locator: sentinelFor("source.locator"),
          description: sentinelFor("source.description"),
          appliesTo: sentinelFor("source.appliesTo"),
          accessPolicy: "worktree-relative",
        },
      ],
    };

    return { charter: charterValue, sentinelByField };
  }

  // `source.id` is the ONE structural-but-rendered string field: render.ts
  // prints it (markdown: `- id: \`<id>\``) as a stable structural identifier,
  // but it is intentionally NOT substitutable (substituting an id would break
  // graph wiring). Every OTHER rendered string field MUST be registered.
  const NON_SUBSTITUTABLE_RENDERED_STRING_FIELDS = new Set(["source.id"]);

  it("registers exactly the rendered, substitutable charter text fields (catches over- AND under-registration)", () => {
    const { charter: sentineledCharter, sentinelByField } =
      maximalSentineledCharter();

    const rendered = `${renderCharterDigest(sentineledCharter)}\n${renderCharterMarkdown(
      sentineledCharter,
    )}`;

    // Mechanically derive the set of fieldKeys whose sentinel actually appears
    // in the rendered output — the ground-truth rendered surface.
    const renderedFields = new Set<string>();
    for (const [fieldKey, sentinel] of sentinelByField) {
      if (rendered.includes(sentinel)) {
        renderedFields.add(fieldKey);
      }
    }

    const substitutableRenderedFields = new Set(
      [...renderedFields].filter(
        (fieldKey) => !NON_SUBSTITUTABLE_RENDERED_STRING_FIELDS.has(fieldKey),
      ),
    );

    expect(substitutableRenderedFields).toEqual(
      new Set(SUBSTITUTION_FIELD_SET.charterFields),
    );
  });

  it("includes source.id in the rendered set but excludes it from the registered substitutable surface", () => {
    // Pins the exclusion so the structural id can never silently slip into the
    // substitutable surface, and proves source.id genuinely IS rendered (so the
    // exclusion is load-bearing, not dead).
    const { charter: sentineledCharter, sentinelByField } =
      maximalSentineledCharter();
    const rendered = `${renderCharterDigest(sentineledCharter)}\n${renderCharterMarkdown(
      sentineledCharter,
    )}`;

    const idSentinel = sentinelByField.get("source.id");
    expect(idSentinel).toBeDefined();
    expect(rendered.includes(idSentinel ?? "")).toBe(true);
    expect([...SUBSTITUTION_FIELD_SET.charterFields]).not.toContain(
      "source.id",
    );
  });

  it("registers exactly the expected charter text fields", () => {
    const expectedCharterFields = [
      "mission",
      "conventions",
      "nonGoals",
      "vocabulary",
      "testStrategy",
      "knownAmbiguities",
      "source.label",
      "source.locator",
      "source.description",
      "source.appliesTo",
    ].sort();

    expect([...SUBSTITUTION_FIELD_SET.charterFields].sort()).toEqual(
      expectedCharterFields,
    );
  });
});

describe("forEachScannedField visits exactly the registered surface", () => {
  // Ties the shared traversal to the constant: forEachScannedField (consumed by
  // both lintParameterReferences and the future substituteContent) must visit
  // exactly the charter + content field kinds registered in
  // SUBSTITUTION_FIELD_SET. This closes the traversal<->constant link so the
  // traversal cannot silently drift from the declared substitutable surface.

  // Map a concrete visited locator to its registered field-kind, e.g.
  //   charter.mission                         -> mission
  //   charter.conventions[0]                  -> conventions
  //   charter.sourcesOfTruth[0].description   -> source.description
  //   executionContexts[0].title              -> executionContexts[].title
  //   tasks[0].instructions                   -> tasks[].instructions
  function charterFieldKind(locator: string): string | null {
    const sourceMatch = /^charter\.sourcesOfTruth\[\d+\]\.(\w+)$/.exec(locator);
    if (sourceMatch) return `source.${sourceMatch[1]}`;
    const charterMatch = /^charter\.([A-Za-z]+)(?:\[\d+\])?$/.exec(locator);
    if (charterMatch) return charterMatch[1] ?? null;
    return null;
  }

  function contentFieldKind(locator: string): string | null {
    const contextMatch = /^executionContexts\[\d+\]\.(\w+)$/.exec(locator);
    if (contextMatch) return `executionContexts[].${contextMatch[1]}`;
    const taskMatch = /^tasks\[\d+\]\.(\w+)$/.exec(locator);
    if (taskMatch) return `tasks[].${taskMatch[1]}`;
    return null;
  }

  function fullyPopulatedDefinition(): WorkflowSemanticDefinition {
    return definition({
      charter: {
        mission: "Ship the feature",
        conventions: ["Use TDD"],
        nonGoals: ["No rewrite"],
        vocabulary: ["term: meaning"],
        testStrategy: "unit + integration",
        knownAmbiguities: ["scope of X"],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "primary",
            label: "Primary source",
            type: "spec",
            locator: "spec.md",
            description: "The spec",
            appliesTo: "everything",
            accessPolicy: "worktree-relative",
          },
        ],
      },
      executionContexts: [
        {
          id: "ctx-1",
          title: "Context one",
          description: "About the context",
          acceptanceCriteria: "It works",
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "Task one",
          instructions: "Do the thing",
          source: "user",
        },
      ],
    });
  }

  it("visits exactly the registered charter field kinds", () => {
    const visitedCharterKinds = new Set<string>();
    forEachScannedField(fullyPopulatedDefinition(), (locator) => {
      const kind = charterFieldKind(locator);
      if (kind !== null) visitedCharterKinds.add(kind);
    });

    expect(visitedCharterKinds).toEqual(
      new Set(SUBSTITUTION_FIELD_SET.charterFields),
    );
  });

  it("visits exactly the registered content field kinds", () => {
    const visitedContentKinds = new Set<string>();
    forEachScannedField(fullyPopulatedDefinition(), (locator) => {
      const kind = contentFieldKind(locator);
      if (kind !== null) visitedContentKinds.add(kind);
    });

    expect(visitedContentKinds).toEqual(
      new Set(SUBSTITUTION_FIELD_SET.contentFields),
    );
  });
});
