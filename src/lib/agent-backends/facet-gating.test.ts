import { describe, it, expect } from "vitest";
import { getBackendCatalogEntry, type BackendCatalogEntry } from "./catalog";
import {
  backendFacetRefusal,
  backendFacetRefusalFor,
  GATED_BACKEND_FACET_ERROR_CODE,
} from "./facet-gating";

function entryWithFacets(
  base: BackendCatalogEntry,
  facets: BackendCatalogEntry["facets"],
): BackendCatalogEntry {
  return { ...base, facets };
}

describe("backendFacetRefusal", () => {
  it("refuses a backend that registers no task facet, naming the backend and the facet", () => {
    const reason = backendFacetRefusal(
      getBackendCatalogEntry("cursor"),
      "tasks",
    );

    expect(reason).not.toBeNull();
    expect(reason).toContain("Cursor");
    expect(reason).toContain("task");
  });

  it("permits a backend that registers the required facet", () => {
    expect(
      backendFacetRefusal(getBackendCatalogEntry("claude"), "tasks"),
    ).toBeNull();
    expect(
      backendFacetRefusal(getBackendCatalogEntry("codex"), "tasks"),
    ).toBeNull();
    expect(
      backendFacetRefusal(getBackendCatalogEntry("cursor"), "conversation"),
    ).toBeNull();
  });

  // The gating must follow the registered facet, not the provider's identity:
  // the day Cursor registers a task facet, every gated surface has to open
  // without an edit (spec R15.3).
  it("follows the entry's facet flags rather than the backend id", () => {
    const cursor = getBackendCatalogEntry("cursor");
    const claude = getBackendCatalogEntry("claude");

    expect(
      backendFacetRefusal(
        entryWithFacets(cursor, { conversation: true, tasks: true }),
        "tasks",
      ),
    ).toBeNull();
    expect(
      backendFacetRefusal(
        entryWithFacets(claude, { conversation: true, tasks: false }),
        "tasks",
      ),
    ).not.toBeNull();
  });
});

describe("backendFacetRefusalFor", () => {
  it("resolves the same refusal from a backend id", () => {
    expect(backendFacetRefusalFor("cursor", "tasks")).toBe(
      backendFacetRefusal(getBackendCatalogEntry("cursor"), "tasks"),
    );
    expect(backendFacetRefusalFor("claude", "tasks")).toBeNull();
  });

  it("exposes one stable error code for the bounded API refusal", () => {
    expect(GATED_BACKEND_FACET_ERROR_CODE).toBe("backend-facet-unsupported");
  });
});
