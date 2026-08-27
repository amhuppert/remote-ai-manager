import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import { buildCursorModelCatalog } from "./model-catalog-generation";

const GENERATED_AT = "2026-08-25T12:00:00.000Z";

const MODELS: ModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Cursor's agent model",
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    aliases: ["opus-5"],
    parameters: [
      {
        id: "effort",
        displayName: "Effort",
        values: [
          { value: "high", displayName: "High" },
          { value: "xhigh", displayName: "Extra High" },
        ],
      },
      {
        id: "thinking",
        displayName: "Thinking",
        values: [
          { value: "false", displayName: "Off" },
          { value: "true", displayName: "On" },
        ],
      },
    ],
    variants: [
      {
        displayName: "High",
        isDefault: true,
        params: [
          { id: "thinking", value: "false" },
          { id: "effort", value: "high" },
          { id: "cyber", value: "false" },
        ],
      },
      {
        displayName: "High + Thinking",
        params: [
          { id: "cyber", value: "false" },
          { id: "thinking", value: "true" },
          { id: "effort", value: "high" },
        ],
      },
      {
        displayName: "Extra High",
        params: [
          { id: "effort", value: "xhigh" },
          { id: "thinking", value: "true" },
          { id: "cyber", value: "false" },
        ],
      },
    ],
  },
];

describe("buildCursorModelCatalog", () => {
  it("preserves aliases and constrained variants while synthesizing hidden fixed parameters", () => {
    const catalog = buildCursorModelCatalog(MODELS, {
      generatedAt: GENERATED_AT,
      sdkVersion: "1.0.28",
    });

    expect(catalog).toMatchObject({
      backend: "cursor",
      defaultModelId: "composer-2.5",
      provenance: {
        source: "Cursor.models.list",
        generatedAt: GENERATED_AT,
        sdkVersion: "1.0.28",
      },
    });
    expect(catalog.models[0]).toMatchObject({
      id: "composer-2.5",
      variants: [
        {
          selection: { modelId: "composer-2.5", parameters: {} },
          isDefault: true,
        },
      ],
    });
    expect(catalog.models[1]).toMatchObject({
      id: "claude-opus-5",
      aliases: ["opus-5"],
      parameters: [
        { id: "effort", prominence: "primary" },
        { id: "thinking", prominence: "advanced" },
        {
          id: "cyber",
          prominence: "hidden",
          values: [{ value: "false", label: "false" }],
        },
      ],
    });
    expect(
      catalog.models[1]?.variants.map((variant) => variant.selection),
    ).toEqual([
      {
        modelId: "claude-opus-5",
        parameters: { cyber: "false", effort: "high", thinking: "false" },
      },
      {
        modelId: "claude-opus-5",
        parameters: { cyber: "false", effort: "high", thinking: "true" },
      },
      {
        modelId: "claude-opus-5",
        parameters: { cyber: "false", effort: "xhigh", thinking: "true" },
      },
    ]);
  });

  it("marks above-scale reasoning tiers across Cursor's differing spellings", () => {
    const catalog = buildCursorModelCatalog(
      [
        { id: "composer-2.5", displayName: "Composer 2.5" },
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          parameters: [
            {
              id: "reasoning",
              values: [
                { value: "high" },
                { value: "extra-high" },
                { value: "max" },
              ],
            },
            {
              id: "context",
              values: [{ value: "272k" }, { value: "1m" }],
            },
          ],
          variants: [
            {
              displayName: "High",
              isDefault: true,
              params: [
                { id: "reasoning", value: "high" },
                { id: "context", value: "272k" },
              ],
            },
            {
              displayName: "Extra high",
              params: [
                { id: "reasoning", value: "extra-high" },
                { id: "context", value: "272k" },
              ],
            },
            {
              displayName: "Max",
              params: [
                { id: "reasoning", value: "max" },
                { id: "context", value: "1m" },
              ],
            },
          ],
        },
      ],
      { generatedAt: GENERATED_AT, sdkVersion: "1.0.28" },
    );

    const model = catalog.models.find(({ id }) => id === "gpt-5.5");
    expect(
      model?.parameters.find(({ id }) => id === "reasoning")?.values,
    ).toEqual([
      { value: "high", label: "high" },
      { value: "extra-high", label: "extra-high", emphasis: "exceeds-scale" },
      { value: "max", label: "max", emphasis: "exceeds-scale" },
    ]);
    // "1m" is the top of the context scale but carries no reasoning meaning.
    expect(
      model?.parameters.find(({ id }) => id === "context")?.values,
    ).toEqual([
      { value: "272k", label: "272k" },
      { value: "1m", label: "1m" },
    ]);
  });

  it("refuses parameterized models whose complete variants are absent", () => {
    expect(() =>
      buildCursorModelCatalog(
        [
          { id: "composer-2.5", displayName: "Composer 2.5" },
          {
            id: "model-without-variants",
            displayName: "Model Without Variants",
            parameters: [
              {
                id: "effort",
                values: [{ value: "high" }],
              },
            ],
          },
        ],
        { generatedAt: GENERATED_AT, sdkVersion: "1.0.28" },
      ),
    ).toThrow(/variants/i);
  });

  it("omits ambiguous aliases and deduplicates aliases with one canonical owner", () => {
    const catalog = buildCursorModelCatalog(
      [
        { id: "composer-2.5", displayName: "Composer 2.5" },
        {
          id: "model-a",
          displayName: "Model A",
          aliases: ["shared", "only-a", "only-a", "model-b"],
        },
        {
          id: "model-b",
          displayName: "Model B",
          aliases: ["shared"],
        },
      ],
      { generatedAt: GENERATED_AT, sdkVersion: "1.0.28" },
    );

    expect(catalog.models.map((model) => [model.id, model.aliases])).toEqual([
      ["composer-2.5", []],
      ["model-a", ["only-a"]],
      ["model-b", []],
    ]);
  });

  it("accepts Cursor's explicit empty default variant for a model without parameters", () => {
    const catalog = buildCursorModelCatalog(
      [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          variants: [
            {
              displayName: "Composer 2.5",
              isDefault: true,
              params: [],
            },
          ],
        },
      ],
      { generatedAt: GENERATED_AT, sdkVersion: "1.0.28" },
    );

    expect(catalog.models[0]?.variants[0]?.selection.parameters).toEqual({});
  });
});
