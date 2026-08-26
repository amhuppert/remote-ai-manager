import { describe, expect, it } from "vitest";

import { listBackendCatalogEntries } from "./catalog";
import { backendModelCatalogSchema } from "./schemas";
import {
  buildProjectModelOptions,
  type ProjectModelOptionsDeps,
} from "./project-model-options";
import { projectModelOptionsResponseSchema } from "./project-model-options-schema";

const PROJECT = "/work/tree";

/** Every backend served straight from the catalog — no project-scoped list. */
function deps(): ProjectModelOptionsDeps {
  return {
    entries: () => listBackendCatalogEntries(),
    resolver: () => undefined,
  };
}

describe("project-scoped model options", () => {
  it("serves the catalog's models for a backend with no project-scoped list", async () => {
    const response = await buildProjectModelOptions(PROJECT, deps());

    const claude = response.backends.find((b) => b.backend === "claude");
    expect(claude?.source).toBe("catalog");
    expect(claude?.models.map((m) => m.id)).toEqual(
      listBackendCatalogEntries()
        .find((e) => e.id === "claude")
        ?.models.map((m) => m.id),
    );
    expect(claude?.defaultModelId).toBe(
      listBackendCatalogEntries().find((e) => e.id === "claude")
        ?.defaultModelId,
    );
  });

  it("serves the project's list for a backend that declares one", async () => {
    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => listBackendCatalogEntries(),
      resolver: (backend) =>
        backend === "cursor"
          ? async (input) => {
              expect(input.projectPath).toBe(PROJECT);
              return {
                models: ["composer-2.5", "composer-1"],
                defaultModelId: "composer-2.5",
              };
            }
          : undefined,
    });

    const cursor = response.backends.find((b) => b.backend === "cursor");
    expect(cursor?.source).toBe("project");
    expect(cursor?.models.map((m) => m.id)).toEqual([
      "composer-2.5",
      "composer-1",
    ]);
    expect(cursor?.defaultModelId).toBe("composer-2.5");
  });

  it("labels a project-declared model the catalog does not describe by its ID", async () => {
    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => listBackendCatalogEntries(),
      resolver: (backend) =>
        backend === "cursor"
          ? async () => ({
              models: ["composer-99"],
              defaultModelId: null,
            })
          : undefined,
    });

    const cursor = response.backends.find((b) => b.backend === "cursor");
    expect(cursor?.models).toEqual([
      {
        id: "composer-99",
        label: "composer-99",
        description: expect.stringContaining("project"),
        effortLevels: [],
      },
    ]);
  });

  it("keeps the catalog's label and effort levels for a listed model it does describe", async () => {
    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => listBackendCatalogEntries(),
      resolver: (backend) =>
        backend === "cursor"
          ? async () => ({
              models: ["composer-2.5"],
              defaultModelId: "composer-2.5",
            })
          : undefined,
    });

    const catalogModel = listBackendCatalogEntries()
      .find((e) => e.id === "cursor")
      ?.models.find((m) => m.id === "composer-2.5");
    expect(
      response.backends.find((b) => b.backend === "cursor")?.models[0],
    ).toEqual(catalogModel);
  });

  it("reports no default when the project's list permits nothing", async () => {
    // The fail-closed edge: nothing is offered and nothing is implicitly
    // chosen, so a creation surface has to ask for an explicit choice rather
    // than substitute a model the project never listed.
    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => listBackendCatalogEntries(),
      resolver: (backend) =>
        backend === "cursor"
          ? async () => ({ models: [], defaultModelId: null })
          : undefined,
    });

    const cursor = response.backends.find((b) => b.backend === "cursor");
    expect(cursor?.models).toEqual([]);
    expect(cursor?.defaultModelId).toBeNull();
  });

  it("produces a response the wire schema accepts", async () => {
    const response = await buildProjectModelOptions(PROJECT, deps());

    expect(projectModelOptionsResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(response.backends.map((b) => b.backend)).toEqual(
      listBackendCatalogEntries().map((e) => e.id),
    );
  });

  it("serves the descriptor's complete effective catalog and atomic default", async () => {
    const cursorEntry = listBackendCatalogEntries().find(
      ({ id }) => id === "cursor",
    )!;
    const modelCatalog = backendModelCatalogSchema.parse({
      backend: "cursor",
      defaultModelId: "composer-2.5",
      models: [
        {
          id: "composer-2.5",
          label: "Composer 2.5",
          aliases: ["composer"],
          parameters: [],
          variants: [
            {
              selection: { modelId: "composer-2.5", parameters: {} },
              label: "Composer 2.5",
              isDefault: true,
            },
          ],
        },
      ],
      provenance: { source: "test" },
    });

    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => [cursorEntry],
      resolver: () => undefined,
      catalogFacet: () => ({ getCatalog: async () => modelCatalog }),
      configuredSelection: async () => ({
        modelId: "composer",
        parameters: {},
      }),
    });

    expect(response.backends[0]).toEqual(
      expect.objectContaining({
        backend: "cursor",
        modelCatalog,
        defaultSelection: {
          modelId: "composer-2.5",
          parameters: {},
        },
        diagnostics: [],
      }),
    );
  });

  it("keeps an effective catalog recoverable when the configured selection is excluded", async () => {
    const cursorEntry = listBackendCatalogEntries().find(
      ({ id }) => id === "cursor",
    )!;
    const modelCatalog = backendModelCatalogSchema.parse({
      backend: "cursor",
      defaultModelId: "composer-2",
      models: [
        {
          id: "composer-2",
          label: "Composer 2",
          aliases: [],
          parameters: [],
          variants: [
            {
              selection: { modelId: "composer-2", parameters: {} },
              label: "Composer 2",
              isDefault: true,
            },
          ],
        },
      ],
      provenance: {
        source: "Cursor.models.list",
        generatedAt: "2026-08-25T18:55:11.561Z",
        sdkVersion: "1.0.28",
      },
    });

    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => [cursorEntry],
      resolver: () => undefined,
      catalogFacet: () => ({ getCatalog: async () => modelCatalog }),
      configuredSelection: async () => ({
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      }),
    });

    expect(response.backends[0]).toEqual(
      expect.objectContaining({
        modelCatalog,
        models: [expect.objectContaining({ id: "composer-2" })],
        defaultModelId: null,
        defaultSelection: null,
        diagnostics: [],
      }),
    );
  });

  it("blocks the backend with a bounded diagnostic when its catalog fails", async () => {
    const cursorEntry = listBackendCatalogEntries().find(
      ({ id }) => id === "cursor",
    )!;
    const response = await buildProjectModelOptions(PROJECT, {
      entries: () => [cursorEntry],
      resolver: () => undefined,
      catalogFacet: () => ({
        getCatalog: async () => {
          throw Object.assign(new Error("snapshot unavailable"), {
            code: "catalog_unavailable",
          });
        },
      }),
    });

    expect(response.backends[0]).toEqual(
      expect.objectContaining({
        models: [],
        defaultModelId: null,
        modelCatalog: null,
        defaultSelection: null,
        diagnostics: [expect.objectContaining({ code: "catalog_unavailable" })],
      }),
    );
  });
});
