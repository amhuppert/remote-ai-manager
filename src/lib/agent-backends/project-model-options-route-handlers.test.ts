import { describe, expect, it } from "vitest";

import { listBackendCatalogEntries } from "./catalog";
import { createProjectModelOptionsRouteHandlers } from "./project-model-options-route-handlers";
import { projectModelOptionsResponseSchema } from "./project-model-options-schema";

const PROJECT_PATH = "/work/tree";

function context(name: string) {
  return { params: Promise.resolve({ name }) };
}

function handlers(
  overrides: Partial<
    Parameters<typeof createProjectModelOptionsRouteHandlers>[0]
  > = {},
) {
  return createProjectModelOptionsRouteHandlers({
    resolveProjectPath: async (name) => (name === "repo" ? PROJECT_PATH : null),
    entries: () => listBackendCatalogEntries(),
    resolver: () => undefined,
    ...overrides,
  });
}

describe("GET project model options", () => {
  it("404s an unknown project rather than serving a catalog it cannot scope", async () => {
    const response = await handlers().GET(context("missing"));

    expect(response.status).toBe(404);
  });

  it("serves the project's effective options for every registered backend", async () => {
    const seen: string[] = [];
    const response = await handlers({
      resolver: (backend) =>
        backend === "cursor"
          ? async (input) => {
              seen.push(input.projectPath);
              return {
                models: ["composer-1"],
                defaultModelId: "composer-1",
              };
            }
          : undefined,
    }).GET(context("repo"));

    expect(response.status).toBe(200);
    const body = projectModelOptionsResponseSchema.parse(await response.json());
    expect(seen).toEqual([PROJECT_PATH]);
    expect(
      body.backends
        .find((b) => b.backend === "cursor")
        ?.models.map((m) => m.id),
    ).toEqual(["composer-1"]);
    expect(body.backends.map((b) => b.backend)).toEqual(
      listBackendCatalogEntries().map((e) => e.id),
    );
  });

  it("reports an empty list and no default when the project permits nothing", async () => {
    const response = await handlers({
      resolver: (backend) =>
        backend === "cursor"
          ? async () => ({ models: [], defaultModelId: null })
          : undefined,
    }).GET(context("repo"));

    const body = projectModelOptionsResponseSchema.parse(await response.json());
    const cursor = body.backends.find((b) => b.backend === "cursor");
    expect(cursor?.models).toEqual([]);
    expect(cursor?.defaultModelId).toBeNull();
  });

  it("reports a backend's resolution failure as a bounded server error", async () => {
    const response = await handlers({
      resolver: () => async () => {
        throw new Error("config unreadable");
      },
    }).GET(context("repo"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining("model") }),
    );
  });
});
