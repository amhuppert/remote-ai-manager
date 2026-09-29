import { expect, it } from "vitest";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
it("admits certified Claude, Codex and Cursor checkpoint forks consistently in the server and client catalog", () => {
  for (const backend of ["claude", "codex", "cursor"] as const) {
    expect(
      getBackendDescriptor(backend).conversation?.capabilities.checkpointFork,
    ).toBe(true);
    expect(
      listBackendCatalogEntries().find((entry) => entry.id === backend)
        ?.capabilities?.checkpointFork,
    ).toBe(true);
  }
});
