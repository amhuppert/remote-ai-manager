import { describe, expect, it } from "vitest";
import {
  getBackendCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { collaborationBackendRefusal } from "./types";

function entryWithFacets(
  base: BackendCatalogEntry,
  facets: BackendCatalogEntry["facets"],
): BackendCatalogEntry {
  return { ...base, facets };
}

describe("collaborationBackendRefusal", () => {
  it("permits both backends of the evidenced pair", () => {
    expect(
      collaborationBackendRefusal(getBackendCatalogEntry("claude")),
    ).toBeNull();
    expect(
      collaborationBackendRefusal(getBackendCatalogEntry("codex")),
    ).toBeNull();
  });

  it("refuses a backend with no task facet, naming the facet and the surface", () => {
    const reason = collaborationBackendRefusal(
      entryWithFacets(getBackendCatalogEntry("cursor"), {
        conversation: true,
        tasks: false,
      }),
    );

    expect(reason).not.toBeNull();
    expect(reason).toContain("Cursor");
    expect(reason).toContain("task");
    expect(reason).toContain("Collaboration Mode");
  });

  // The gate is the catalog's facet flag, not the backend's identity: a
  // non-Claude lane is dispatched as a task run, so the facet is what decides.
  it("follows the entry's task-facet flag rather than the backend id", () => {
    const claudeWithoutTasks = entryWithFacets(
      getBackendCatalogEntry("claude"),
      { conversation: true, tasks: false },
    );

    const reason = collaborationBackendRefusal(claudeWithoutTasks);
    expect(reason).not.toBeNull();
    expect(reason).toContain("task");
  });

  // Clearing the facet gate is not the same as clearing the pair policy: a
  // backend that HAS a task facet but is outside the evidenced pair is still
  // refused, and for the honest reason.
  it("falls back to the pair policy for a task-capable backend outside the pair", () => {
    const cursorWithTasks = entryWithFacets(getBackendCatalogEntry("cursor"), {
      conversation: true,
      tasks: true,
    });

    const reason = collaborationBackendRefusal(cursorWithTasks);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("task facet");
    expect(reason).toContain("Claude and Codex");
  });
});
