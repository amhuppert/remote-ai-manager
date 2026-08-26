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
  it("uses the documented default allowlist when project config is omitted", () => {
    const result = filterCursorModelCatalog(catalog, null);

    expect(result.defaultModelId).toBe("composer-2.5");
    expect(result.models.map((model) => model.id)).toEqual(["composer-2.5"]);
  });

  it("keeps only project-allowlisted models and accepts catalog aliases", () => {
    const result = filterCursorModelCatalog(catalog, [
      "composer-2.5",
      "opus-5",
    ]);

    expect(result.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-5",
    ]);
  });

  it("refuses configured model ids absent from the generated snapshot", () => {
    expect(() =>
      filterCursorModelCatalog(catalog, ["composer-2.5", "not-in-catalog"]),
    ).toThrowError(
      expect.objectContaining({
        name: CursorModelCatalogError.name,
        code: "model_not_in_generated_catalog",
        modelId: "not-in-catalog",
      }),
    );
  });

  it("refuses an allowlist that excludes the catalog default", () => {
    expect(() => filterCursorModelCatalog(catalog, ["opus-5"])).toThrowError(
      expect.objectContaining({ code: "default_model_not_allowed" }),
    );
  });

  it("fails closed when the project explicitly configures an empty allowlist", () => {
    expect(() => filterCursorModelCatalog(catalog, [])).toThrowError(
      expect.objectContaining({ code: "no_models_allowed" }),
    );
  });

  it("uses a validated configured selection as the effective allowlisted default", () => {
    const result = filterCursorModelCatalog(catalog, ["opus-5"], {
      modelId: "opus-5",
      parameters: {},
    });

    expect(result.defaultModelId).toBe("claude-opus-5");
    expect(result.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
  });
});

describe("createCursorModelCatalogFacet", () => {
  it("uses the default allowlist when the project omits Cursor configuration", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async supportedModels() {
        return null;
      },
    });

    const effective = await facet.getCatalog({
      projectPath: "/repo",
      configuredSelection: { modelId: "composer-2.5", parameters: {} },
    });

    expect(effective.models.map((model) => model.id)).toEqual(["composer-2.5"]);
  });

  it("leaves the generated catalog complete outside a project boundary", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async supportedModels() {
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

  it("applies the project allowlist and configured default atomically", async () => {
    const requestedPaths: string[] = [];
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async supportedModels(projectPath) {
        requestedPaths.push(projectPath);
        return ["opus-5"];
      },
    });

    const effective = await facet.getCatalog({
      projectPath: "/repo",
      configuredSelection: { modelId: "opus-5", parameters: {} },
    });

    expect(requestedPaths).toEqual(["/repo"]);
    expect(effective.defaultModelId).toBe("claude-opus-5");
    expect(effective.models.map((model) => model.id)).toEqual([
      "claude-opus-5",
    ]);
  });

  it("keeps an allowed explicit model available when the configured default is excluded", async () => {
    const facet = createCursorModelCatalogFacet({
      loadCatalog: () => catalog,
      async supportedModels() {
        return ["opus-5"];
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

    expect(effective.defaultModelId).toBe("claude-opus-5");
    expect(effective.models.map((model) => model.id)).toEqual([
      "claude-opus-5",
    ]);
    expect(explicitSelection).toMatchObject({
      valid: true,
      selection: { modelId: "claude-opus-5", parameters: {} },
    });
  });
});
