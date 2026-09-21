import { describe, expect, it } from "vitest";

import { validateModelSelection } from "../model-selection";
import { buildCursorModelCatalog } from "./model-catalog-generation";
import {
  CursorModelCatalogError,
  createCursorModelCatalogFacet,
  filterCursorModelCatalog,
  parseGeneratedCursorModelCatalog,
} from "./model-catalog";

const catalog = buildCursorModelCatalog(
  [
    { id: "composer-2.5", displayName: "Composer 2.5" },
    {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      aliases: ["opus-5"],
    },
    { id: "gpt-5.4", displayName: "GPT-5.4" },
  ],
  {
    generatedAt: "2026-08-25T12:00:00.000Z",
    sdkVersion: "1.0.28",
  },
);

describe("parseGeneratedCursorModelCatalog", () => {
  it("rejects a generated artifact recorded for another SDK version", () => {
    expect(() => parseGeneratedCursorModelCatalog(catalog, "1.0.29")).toThrow(
      /SDK version/i,
    );
  });

  it("rejects malformed generated artifacts", () => {
    expect(() =>
      parseGeneratedCursorModelCatalog(
        { ...catalog, defaultModelId: "missing" },
        "1.0.28",
      ),
    ).toThrow(/default model/i);
  });
});

describe("filterCursorModelCatalog", () => {
  it("offers every generated model when the project configures no opt-outs", () => {
    for (const disabledModels of [null, undefined, []]) {
      const result = filterCursorModelCatalog(catalog, disabledModels);

      expect(result.defaultModelId).toBe("composer-2.5");
      expect(result.models.map((model) => model.id)).toEqual([
        "composer-2.5",
        "claude-opus-5",
        "gpt-5.4",
      ]);
    }
  });

  it("removes only the opted-out models and accepts catalog aliases", () => {
    const result = filterCursorModelCatalog(catalog, ["opus-5"]);

    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "gpt-5.4",
    ]);
  });

  it("ignores an opt-out id the generated snapshot no longer contains", () => {
    // Cursor retires models; a stale exclusion must not break the project.
    const result = filterCursorModelCatalog(catalog, ["retired-model"]);

    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
      "gpt-5.4",
    ]);
  });

  it("refuses an opt-out list that disables the catalog default", () => {
    expect(() =>
      filterCursorModelCatalog(catalog, ["composer-2.5"]),
    ).toThrowError(
      expect.objectContaining({
        name: CursorModelCatalogError.name,
        code: "default_model_disabled",
        modelId: "composer-2.5",
      }),
    );
  });

  it("fails closed when the project disables every generated model", () => {
    expect(() =>
      filterCursorModelCatalog(catalog, [
        "composer-2.5",
        "claude-opus-5",
        "gpt-5.4",
      ]),
    ).toThrowError(expect.objectContaining({ code: "all_models_disabled" }));
  });

  it("uses a validated configured selection as the effective default", () => {
    const result = filterCursorModelCatalog(catalog, ["gpt-5.4"], {
      modelId: "opus-5",
      parameters: {},
    });

    expect(result.defaultModelId).toBe("claude-opus-5");
    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
    ]);
  });

  it("recovers the catalog default when the configured selection is opted out", () => {
    const result = filterCursorModelCatalog(catalog, ["opus-5"], {
      modelId: "claude-opus-5",
      parameters: {},
    });

    expect(result.defaultModelId).toBe("composer-2.5");
    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "gpt-5.4",
    ]);
  });
});

describe("createCursorModelCatalogFacet", () => {
  it("offers the whole generated catalog when the project omits Cursor configuration", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async disabledModels() {
        return null;
      },
    });

    const effective = await facet.getCatalog({
      projectPath: "/repo",
      configuredSelection: { modelId: "composer-2.5", parameters: {} },
    });

    expect(effective.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
      "gpt-5.4",
    ]);
  });

  it("leaves the generated catalog complete outside a project boundary", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async disabledModels() {
        throw new Error("unscoped catalog reads have no project config");
      },
    });

    const effective = await facet.getCatalog({});

    expect(effective.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
      "gpt-5.4",
    ]);
  });

  it("applies the project opt-outs and configured default atomically", async () => {
    const requestedPaths: string[] = [];
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async disabledModels(projectPath) {
        requestedPaths.push(projectPath);
        return ["gpt-5.4"];
      },
    });

    const effective = await facet.getCatalog({
      projectPath: "/repo",
      configuredSelection: { modelId: "opus-5", parameters: {} },
    });

    expect(requestedPaths).toEqual(["/repo"]);
    expect(effective.defaultModelId).toBe("claude-opus-5");
    expect(effective.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
    ]);
  });

  it("keeps an available explicit model selectable when the configured default is opted out", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async disabledModels() {
        return ["gpt-5.4"];
      },
    });

    const effective = await facet.getCatalog({
      projectPath: "/repo",
      configuredSelection: { modelId: "gpt-5.4", parameters: {} },
    });
    const explicitSelection = validateModelSelection(effective, {
      modelId: "opus-5",
      parameters: {},
    });

    expect(effective.defaultModelId).toBe("composer-2.5");
    expect(effective.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
    ]);
    expect(explicitSelection).toMatchObject({
      valid: true,
      selection: { modelId: "claude-opus-5", parameters: {} },
    });
  });
});
