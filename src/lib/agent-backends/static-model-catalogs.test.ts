import { describe, expect, it } from "vitest";

import {
  getConfiguredBackendModelCatalog,
  getStaticBackendModelCatalog,
} from "./catalog";
import { validateModelSelection } from "./model-selection";
import { backendModelCatalogSchema } from "./schemas";

describe("static backend model catalogs", () => {
  it("describes Claude effort as complete selectable variants", () => {
    const catalog = getStaticBackendModelCatalog("claude");
    const opus = catalog.models.find(({ id }) => id === "opus");

    expect(backendModelCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(opus?.parameters).toEqual([
      expect.objectContaining({
        id: "effort",
        prominence: "primary",
        values: expect.arrayContaining([
          expect.objectContaining({ value: "low" }),
          expect.objectContaining({ value: "xhigh" }),
        ]),
      }),
    ]);
    expect(
      validateModelSelection(catalog, {
        modelId: "opus",
        parameters: { effort: "xhigh" },
      }).valid,
    ).toBe(true);
  });

  it("describes Codex reasoning and fast mode without special top-level fields", () => {
    const catalog = getStaticBackendModelCatalog("codex");
    const model = catalog.models.find(({ id }) => id === "gpt-5.4");

    expect(model?.parameters.map(({ id }) => id)).toEqual([
      "reasoning",
      "fast",
    ]);
    expect(
      validateModelSelection(catalog, {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "true" },
      }).valid,
    ).toBe(true);
  });

  it("offers GPT-6 Astra with only its supported reasoning levels", () => {
    const catalog = getStaticBackendModelCatalog("codex");
    const astra = catalog.models.find(({ id }) => id === "gpt-6-astra");

    expect(astra).toEqual(
      expect.objectContaining({
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        description: "Most capable",
      }),
    );
    expect(
      validateModelSelection(catalog, {
        modelId: "gpt-6-astra",
        parameters: { reasoning: "max", fast: "true" },
      }).valid,
    ).toBe(true);
    expect(
      validateModelSelection(catalog, {
        modelId: "gpt-6-astra",
        parameters: { reasoning: "ultra", fast: "false" },
      }).valid,
    ).toBe(false);
  });

  it("preserves a configured custom Codex model with generic complete variants", () => {
    const catalog = getStaticBackendModelCatalog("codex", {
      modelId: "o3-pro-custom",
      parameters: { reasoning: "ultra", fast: "false" },
    });

    const custom = catalog.models.find(({ id }) => id === "o3-pro-custom");
    expect(custom?.label).toBe("o3-pro-custom");
    expect(
      validateModelSelection(catalog, {
        modelId: "o3-pro-custom",
        parameters: { reasoning: "ultra", fast: "false" },
      }).valid,
    ).toBe(true);
  });

  it("hides provider catalog sourcing behind one atomic configured-selection lookup", () => {
    const cursor = getConfiguredBackendModelCatalog("cursor", {
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    });
    const composer = cursor.models.find(({ id }) => id === "composer-2.5");

    expect(cursor.backend).toBe("cursor");
    expect(composer?.parameters.map(({ id }) => id)).toContain("fast");
    expect(
      validateModelSelection(cursor, {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      }).valid,
    ).toBe(true);
  });
});
