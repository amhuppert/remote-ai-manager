import { describe, expect, it } from "vitest";

import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  DELIVERY_PLAN_ENVELOPE_MAX_BYTES,
  deliveryPlanDocumentSchema,
} from "./delivery-plan";

function maximalAuthoredLaunch() {
  const record = createWorkflowDefinitionRecord();
  return {
    name: record.name,
    description: record.description,
    definition: {
      ...record.definition,
      parameters: [
        {
          type: "string" as const,
          name: "fixture-input",
          label: "Fixture input",
          required: true,
          default: "value",
          minLength: 1,
          maxLength: 32,
        },
        {
          type: "enum" as const,
          name: "fixture-mode",
          label: "Fixture mode",
          required: true,
          options: ["safe", "fast"],
          default: "safe",
        },
        {
          type: "text" as const,
          name: "fixture-notes",
          label: "Fixture notes",
          required: false,
          default: "Explain the launch.",
          minLength: 1,
          maxLength: 200,
        },
      ],
      prerequisites: [
        {
          kind: "path" as const,
          path: "src",
          label: "Fixture source path",
        },
        {
          kind: "skill" as const,
          skill: "fixture-skill",
          backend: "codex" as const,
          label: "Fixture skill prerequisite",
        },
      ],
      executionContexts: record.definition.executionContexts.map((context) =>
        context.id === "context-implement"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
              placement: {
                lane: "implement",
                mode: "owned" as const,
                ownedPaths: ["src/fixture"],
              },
            }
          : context.id === "context-verify"
            ? {
                ...context,
                placement: { lane: "verify", mode: "readOnly" as const },
              }
            : context,
      ),
      edges: [
        ...record.definition.edges.map((edge) =>
          edge.id === "edge-implement-verify"
            ? {
                ...edge,
                when: {
                  schema: {
                    type: "object",
                    properties: { result: { const: "verified" } },
                    required: ["result"],
                  },
                },
              }
            : edge,
        ),
        {
          id: "edge-implement-fallback",
          sourceContextId: "context-implement",
          targetContextId: "context-plan",
          when: { else: true as const },
        },
      ],
    },
    layout: record.layout,
  };
}

function maximalEnvelope() {
  return {
    schemaVersion: 2,
    launch: maximalAuthoredLaunch(),
    binding: {
      dispositions: [
        {
          criterionElementId: "criterion-one",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-two",
          disposition: "deferred",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-one", "criterion-two"],
        },
      ],
    },
  };
}

describe("version-2 delivery plan envelope", () => {
  it("accepts the complete graph launch unchanged and writes deterministic envelope bytes", () => {
    const parsed = deliveryPlanDocumentSchema.parse(maximalEnvelope());

    expect(parsed.launch).toEqual(maximalAuthoredLaunch());
    expect(parsed.launch.definition.parameters).toContainEqual(
      expect.objectContaining({
        type: "enum",
        name: "fixture-mode",
        options: ["safe", "fast"],
      }),
    );
    expect(parsed.launch.definition.prerequisites).toContainEqual(
      expect.objectContaining({
        kind: "skill",
        skill: "fixture-skill",
        backend: "codex",
      }),
    );
    expect(parsed.launch.definition.parameters).toContainEqual(
      expect.objectContaining({
        type: "text",
        name: "fixture-notes",
        minLength: 1,
        maxLength: 200,
      }),
    );
    expect(parsed.launch.definition.executionContexts).toContainEqual(
      expect.objectContaining({
        id: "context-implement",
        placement: {
          lane: "implement",
          mode: "owned",
          ownedPaths: ["src/fixture"],
        },
      }),
    );
    expect(parsed.launch.definition.executionContexts).toContainEqual(
      expect.objectContaining({
        id: "context-verify",
        placement: { lane: "verify", mode: "readOnly" },
      }),
    );
    expect(parsed.launch.definition.edges).toContainEqual(
      expect.objectContaining({
        when: {
          schema: {
            type: "object",
            properties: { result: { const: "verified" } },
            required: ["result"],
          },
        },
      }),
    );
    expect(parsed.launch.definition.edges).toContainEqual(
      expect.objectContaining({ when: { else: true } }),
    );
    expect(canonicalDeliveryPlanEnvelopeBytes(parsed)).toBe(
      canonicalDeliveryPlanEnvelopeBytes(
        deliveryPlanDocumentSchema.parse({
          binding: maximalEnvelope().binding,
          launch: maximalAuthoredLaunch(),
          schemaVersion: 2,
        }),
      ),
    );
  });

  it.each([
    [
      "schema version",
      { ...maximalEnvelope(), schemaVersion: 1 },
      "schemaVersion",
    ],
    [
      "server origin",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            origin: { sourceUri: "spec-plan://attempt", label: "reserved" },
          },
        },
      },
      "launch.definition.origin",
    ],
    [
      "server locks",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            lockedRegions: [],
          },
        },
      },
      "launch.definition.lockedRegions",
    ],
    [
      "server approval policy",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            approvalRequired: false,
          },
        },
      },
      "launch.definition.approvalRequired",
    ],
    [
      "reserved pinned source",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            charter: {
              ...maximalAuthoredLaunch().definition.charter,
              sourcesOfTruth: [
                ...(maximalAuthoredLaunch().definition.charter.sourcesOfTruth ??
                  []),
                {
                  rank: 99,
                  id: "native-sdd-pinned-spec",
                  label: "Reserved source",
                  type: "spec",
                  locator: ".cc/graph-workflow-docs/spec/example.md",
                  description: "Reserved source locator.",
                  accessPolicy: "worktree-relative",
                },
              ],
            },
          },
        },
      },
      "launch.definition.charter.sourcesOfTruth.2.id",
    ],
    [
      "reserved pinned-spec locator namespace",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            charter: {
              ...maximalAuthoredLaunch().definition.charter,
              sourcesOfTruth: [
                {
                  ...maximalAuthoredLaunch().definition.charter
                    .sourcesOfTruth[0],
                  locator: ".cc/graph-workflow-docs/spec/collision.md",
                },
              ],
            },
          },
        },
      },
      "launch.definition.charter.sourcesOfTruth.0.locator",
    ],
    [
      "reserved candidate-claims locator namespace",
      {
        ...maximalEnvelope(),
        launch: {
          ...maximalAuthoredLaunch(),
          definition: {
            ...maximalAuthoredLaunch().definition,
            charter: {
              ...maximalAuthoredLaunch().definition.charter,
              sourcesOfTruth: [
                {
                  ...maximalAuthoredLaunch().definition.charter
                    .sourcesOfTruth[0],
                  locator:
                    ".cc/graph-workflow-docs/spec-bindings/collision/claims.md",
                },
              ],
            },
          },
        },
      },
      "launch.definition.charter.sourcesOfTruth.0.locator",
    ],
  ])("refuses %s at %s", (_label, document, expectedPath) => {
    const parsed = deliveryPlanDocumentSchema.safeParse(document);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
      expectedPath,
    );
  });

  it.each([
    [
      "duplicate claim records",
      [
        ...maximalEnvelope().binding.claims,
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-two"],
        },
      ],
    ],
    [
      "repeated criteria within a claim record",
      [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-one", "criterion-one"],
        },
      ],
    ],
  ])("preserves %s for post-admission binding lint", (_label, claims) => {
    const parsed = deliveryPlanDocumentSchema.parse({
      ...maximalEnvelope(),
      binding: { ...maximalEnvelope().binding, claims },
    });

    expect(parsed.binding.claims).toEqual(claims);
  });

  it("refuses a whole envelope that exceeds the canonical byte limit", () => {
    const parsed = deliveryPlanDocumentSchema.safeParse({
      ...maximalEnvelope(),
      launch: {
        ...maximalAuthoredLaunch(),
        description: "x".repeat(DELIVERY_PLAN_ENVELOPE_MAX_BYTES),
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({ path: [] }),
    );
  });
});

/**
 * The retired dialect, spelled exactly as an attempt written before the
 * cutover held it. Nothing translates it: after the destructive migration the
 * only thing that can meet these bytes is the version-2 schema refusing them.
 */
function legacyDialectDocument(): Record<string, unknown> {
  return {
    dispositions: [
      { criterionElementId: "criterion-a", disposition: "in_scope" },
    ],
    contexts: [
      {
        contextId: "context-implement",
        title: "Implement",
        type: "implementation",
        placement: { mode: "full", executionLane: "impl" },
      },
    ],
    tasks: [
      {
        taskId: "task-implement",
        contextId: "context-implement",
        title: "Implement",
        instructions: "Implement the criterion.",
        coveredCriterionElementIds: ["criterion-a"],
        dependsOnTaskElementIds: [],
        laneGroup: "impl",
      },
    ],
    edges: [{ from: "context-implement", to: "context-verify" }],
    wiring: [{ kind: "downstream", contextId: "context-verify" }],
    policyOverrides: [],
    touchedSurfaces: ["src/lib/specs"],
    governance: { validationCommandNames: ["test"] },
  };
}

describe("retired delivery plan dialect", () => {
  it("refuses legacy bytes at the schema gate instead of translating them", () => {
    const parsed = deliveryPlanDocumentSchema.safeParse(
      legacyDialectDocument(),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // The refusal names the version-2 envelope the bytes do not have plus the
    // whole-document unrecognized-keys issue; no issue names a legacy field,
    // because no branch ever looked at one.
    expect(
      [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
      ].sort(),
    ).toEqual(["", "binding", "launch", "schemaVersion"]);
  });

  it("refuses a legacy document even when it is stamped as version 2", () => {
    const parsed = deliveryPlanDocumentSchema.safeParse({
      schemaVersion: 2,
      ...legacyDialectDocument(),
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("launch");
    expect(paths).toContain("binding");
    // `.strict()` is the floor: every retired field is unrecognized, so no
    // caller can smuggle the old dialect in beside a version-2 stamp.
    expect(
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);
  });
});
