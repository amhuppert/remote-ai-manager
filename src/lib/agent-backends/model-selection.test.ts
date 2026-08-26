import { describe, expect, it } from "vitest";

import {
  ModelSelectionPolicyError,
  availableParameterValues,
  canonicalizeModelSelection,
  defaultSelectionForModel,
  modelSelectionKey,
  resolveModelSelection,
  validateModelSelection,
} from "./model-selection";
import { backendModelCatalogSchema } from "./schemas";

const catalog = backendModelCatalogSchema.parse({
  backend: "cursor",
  defaultModelId: "claude-opus-5",
  models: [
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      aliases: ["opus-5"],
      parameters: [
        {
          id: "effort",
          label: "Effort",
          values: [
            { value: "low", label: "Low" },
            { value: "xhigh", label: "Extra high" },
          ],
          prominence: "primary",
        },
        {
          id: "thinking",
          label: "Thinking",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
      ],
      variants: [
        {
          selection: {
            modelId: "claude-opus-5",
            parameters: { effort: "low", thinking: "false" },
          },
          label: "Low effort, thinking off",
          isDefault: true,
        },
        {
          selection: {
            modelId: "claude-opus-5",
            parameters: { effort: "low", thinking: "true" },
          },
          label: "Low effort, thinking on",
          isDefault: false,
        },
        {
          selection: {
            modelId: "claude-opus-5",
            parameters: { effort: "xhigh", thinking: "true" },
          },
          label: "Extra-high effort, thinking on",
          isDefault: false,
        },
      ],
    },
  ],
  provenance: { source: "test" },
});

describe("model selection policy", () => {
  it("canonicalizes an alias while resolving the first whole candidate", () => {
    const resolved = resolveModelSelection({
      catalog,
      candidates: [
        {
          modelId: "opus-5",
          parameters: { thinking: "true", effort: "xhigh" },
        },
      ],
    });

    expect(resolved).toEqual({
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    });
  });

  it("validates keys, values, and complete combinations without clamping", () => {
    expect(
      validateModelSelection(catalog, {
        modelId: "claude-opus-5",
        parameters: { effort: "xhigh", thinking: "false" },
      }),
    ).toEqual({
      valid: false,
      issues: [
        expect.objectContaining({
          code: "unsupported_combination",
          modelId: "claude-opus-5",
        }),
      ],
    });

    const incomplete = validateModelSelection(catalog, {
      modelId: "claude-opus-5",
      parameters: { effort: "turbo", future: "on" },
    });
    expect(incomplete).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported_value",
          parameterId: "effort",
        }),
        expect.objectContaining({
          code: "unknown_parameter",
          parameterId: "future",
        }),
        expect.objectContaining({
          code: "missing_parameter",
          parameterId: "thinking",
        }),
      ]),
    });
  });

  it("never merges or falls through from an invalid higher-precedence candidate", () => {
    expect(() =>
      resolveModelSelection({
        catalog,
        candidates: [
          {
            modelId: "claude-opus-5",
            parameters: { effort: "xhigh" },
          },
          {
            modelId: "claude-opus-5",
            parameters: { effort: "low", thinking: "false" },
          },
        ],
      }),
    ).toThrow(ModelSelectionPolicyError);

    try {
      resolveModelSelection({
        catalog,
        candidates: [
          {
            modelId: "claude-opus-5",
            parameters: { effort: "xhigh" },
          },
          {
            modelId: "claude-opus-5",
            parameters: { effort: "low", thinking: "false" },
          },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSelectionPolicyError);
      expect((error as ModelSelectionPolicyError).issues).toContainEqual(
        expect.objectContaining({
          code: "missing_parameter",
          parameterId: "thinking",
        }),
      );
    }
  });

  it("uses the declared model default only when no candidate is present", () => {
    expect(
      resolveModelSelection({
        catalog,
        candidates: [undefined, null],
      }),
    ).toEqual({
      modelId: "claude-opus-5",
      parameters: { effort: "low", thinking: "false" },
    });
    expect(defaultSelectionForModel(catalog, "opus-5")).toEqual({
      modelId: "claude-opus-5",
      parameters: { effort: "low", thinking: "false" },
    });
  });

  it("reports constrained values in the parameter definition's order", () => {
    const model = catalog.models[0]!;
    const draft = {
      modelId: model.id,
      parameters: { effort: "xhigh", thinking: "false" },
    };

    expect(
      availableParameterValues({ model, draft, parameterId: "thinking" }),
    ).toEqual(["true"]);
    expect(
      availableParameterValues({ model, draft, parameterId: "effort" }),
    ).toEqual(["low"]);
  });

  it("gives equivalent parameter records the same stable key", () => {
    expect(
      modelSelectionKey({
        modelId: "claude-opus-5",
        parameters: { thinking: "true", effort: "xhigh" },
      }),
    ).toBe(
      modelSelectionKey({
        modelId: "claude-opus-5",
        parameters: { effort: "xhigh", thinking: "true" },
      }),
    );
  });

  it("canonicalizes aliases without accepting an unknown model", () => {
    expect(
      canonicalizeModelSelection(catalog, {
        modelId: "opus-5",
        parameters: { thinking: "true", effort: "xhigh" },
      }),
    ).toEqual({
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    });
    expect(() =>
      canonicalizeModelSelection(catalog, {
        modelId: "missing",
        parameters: {},
      }),
    ).toThrow(ModelSelectionPolicyError);
  });
});

describe("backend model catalog schema", () => {
  it("rejects ambiguous aliases, duplicate variants, and incomplete variants", () => {
    const invalid = {
      ...catalog,
      models: [
        catalog.models[0],
        {
          ...catalog.models[0],
          id: "other-model",
          aliases: ["opus-5"],
          variants: [
            {
              selection: {
                modelId: "other-model",
                parameters: { effort: "low" },
              },
              label: "Incomplete",
              isDefault: true,
            },
            {
              selection: {
                modelId: "other-model",
                parameters: { effort: "low" },
              },
              label: "Duplicate",
              isDefault: false,
            },
          ],
        },
      ],
    };

    const result = backendModelCatalogSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("already owned"),
        expect.stringContaining("missing parameter"),
        expect.stringContaining("same complete selection"),
      ]),
    );
  });
});
