import { describe, expect, it } from "vitest";

import { listBackendCatalogEntries } from "./catalog";
import {
  buildProjectModelOptions,
  projectModelOptionsResponseSchema,
  type ProjectModelOptionsDeps,
} from "./project-model-options";

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
});
