import { describe, expect, it } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  parameterDeclarationSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";

function baseExecution(): Record<string, unknown> {
  return {
    id: "wf-1",
    origin: {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 1,
      tier: "project",
    },
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "pending",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function baseDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    executionContexts: [
      {
        id: "context-1",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "All tasks are complete and verified.",
        placement: { lane: "context-1", mode: "full" },
      },
    ],
    tasks: [],
    edges: [],
  };
}

describe("parameterDeclarationSchema", () => {
  it("parses a string declaration with length bounds and default", () => {
    const result = parameterDeclarationSchema.parse({
      type: "string",
      name: "feature-name",
      label: "Feature name",
      required: true,
      default: "widget",
      minLength: 1,
      maxLength: 64,
    });

    expect(result).toEqual({
      type: "string",
      name: "feature-name",
      label: "Feature name",
      required: true,
      default: "widget",
      minLength: 1,
      maxLength: 64,
    });
  });

  it("parses a text (multiline) declaration", () => {
    const result = parameterDeclarationSchema.parse({
      type: "text",
      name: "brief",
      label: "Feature brief",
      required: true,
    });

    expect(result).toEqual({
      type: "text",
      name: "brief",
      label: "Feature brief",
      required: true,
    });
  });

  it("parses an enum declaration with options and default", () => {
    const result = parameterDeclarationSchema.parse({
      type: "enum",
      name: "tier",
      label: "Tier",
      options: ["free", "pro", "enterprise"],
      default: "pro",
    });

    expect(result).toEqual({
      type: "enum",
      name: "tier",
      label: "Tier",
      required: false,
      options: ["free", "pro", "enterprise"],
      default: "pro",
    });
  });

  it("defaults required to false when omitted", () => {
    const result = parameterDeclarationSchema.parse({
      type: "string",
      name: "note",
      label: "Note",
    });

    expect(result.required).toBe(false);
  });

  it("trims and rejects empty name", () => {
    expect(() =>
      parameterDeclarationSchema.parse({
        type: "string",
        name: "   ",
        label: "Label",
      }),
    ).toThrow();
  });

  it("rejects an empty label", () => {
    expect(() =>
      parameterDeclarationSchema.parse({
        type: "string",
        name: "ok",
        label: "",
      }),
    ).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() =>
      parameterDeclarationSchema.parse({
        type: "boolean",
        name: "flag",
        label: "Flag",
      }),
    ).toThrow();
  });

  it("is parse-permissive: accepts empty enum options (shape check deferred)", () => {
    const result = parameterDeclarationSchema.parse({
      type: "enum",
      name: "tier",
      label: "Tier",
      options: [],
    });

    expect(result).toMatchObject({ type: "enum", options: [] });
  });

  it("is parse-permissive: accepts an enum default not in options (cross-validation deferred)", () => {
    const result = parameterDeclarationSchema.parse({
      type: "enum",
      name: "tier",
      label: "Tier",
      options: ["free", "pro"],
      default: "enterprise",
    });

    expect(result).toMatchObject({ default: "enterprise" });
  });
});

describe("workflowSemanticDefinitionSchema parameters block", () => {
  it("parses a definition declaring one of every parameter type without loss", () => {
    const input = {
      ...baseDefinition(),
      parameters: [
        {
          type: "string",
          name: "feature-name",
          label: "Feature name",
          required: true,
          default: "widget",
          minLength: 1,
          maxLength: 64,
        },
        {
          type: "text",
          name: "brief",
          label: "Feature brief",
          required: true,
        },
        {
          type: "enum",
          name: "tier",
          label: "Tier",
          options: ["free", "pro"],
          default: "pro",
        },
        {
          type: "string",
          name: "optional-note",
          label: "Optional note",
        },
      ],
    };

    const parsed = workflowSemanticDefinitionSchema.parse(input);

    // Round-trip: parsed parameters equal the input with declaration defaults
    // (required:false) applied.
    expect(parsed.parameters).toEqual([
      {
        type: "string",
        name: "feature-name",
        label: "Feature name",
        required: true,
        default: "widget",
        minLength: 1,
        maxLength: 64,
      },
      {
        type: "text",
        name: "brief",
        label: "Feature brief",
        required: true,
      },
      {
        type: "enum",
        name: "tier",
        label: "Tier",
        required: false,
        options: ["free", "pro"],
        default: "pro",
      },
      {
        type: "string",
        name: "optional-note",
        label: "Optional note",
        required: false,
      },
    ]);

    // Re-serialize (re-parse the parsed object) is stable.
    expect(workflowSemanticDefinitionSchema.parse(parsed).parameters).toEqual(
      parsed.parameters,
    );
  });

  it("defaults parameters to an empty list for a legacy definition with no parameters field", () => {
    const parsed = workflowSemanticDefinitionSchema.parse(baseDefinition());

    expect(parsed.parameters).toEqual([]);
  });
});

describe("graphWorkflowExecutionSchema boundInputs audit field", () => {
  it("parses an execution carrying a non-empty boundInputs snapshot without loss (R6.1)", () => {
    const boundInputs = {
      "feature-name": "auth",
      brief: "Add OAuth login to the dashboard",
      tier: "pro",
    };

    const parsed = graphWorkflowExecutionSchema.parse({
      ...baseExecution(),
      boundInputs,
    });

    expect(parsed.boundInputs).toEqual(boundInputs);

    // Re-serialize (re-parse the parsed object) is stable.
    expect(graphWorkflowExecutionSchema.parse(parsed).boundInputs).toEqual(
      boundInputs,
    );
  });

  it("defaults boundInputs to {} for a pre-feature execution record that omits it (R6.5, R10.2)", () => {
    const parsed = graphWorkflowExecutionSchema.parse(baseExecution());

    expect(parsed.boundInputs).toEqual({});
  });

  it("preserves an explicitly empty boundInputs for a zero-input run (R6.5)", () => {
    const parsed = graphWorkflowExecutionSchema.parse({
      ...baseExecution(),
      boundInputs: {},
    });

    expect(parsed.boundInputs).toEqual({});
  });
});
