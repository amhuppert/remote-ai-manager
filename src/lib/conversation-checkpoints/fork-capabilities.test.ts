import { expect, it } from "vitest";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
it("admits certified Claude and Codex checkpoint forks consistently in the server and client catalog", () => {
  for (const backend of ["claude", "codex"] as const) {
    expect(
      getBackendDescriptor(backend).conversation?.capabilities.checkpointFork,
    ).toBe(true);
    expect(
      listBackendCatalogEntries().find((entry) => entry.id === backend)
        ?.capabilities?.checkpointFork,
    ).toBe(true);
  }
  expect(
    getBackendDescriptor("cursor").conversation?.capabilities.checkpointFork,
  ).toBe(false);
});
