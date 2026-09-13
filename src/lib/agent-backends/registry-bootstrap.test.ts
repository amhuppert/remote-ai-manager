import { describe, expect, it, vi } from "vitest";

describe("agent backend registry bootstrap", () => {
  it("loads registered backends from the registry entrypoint", async () => {
    vi.resetModules();

    const registry = await import("./registry");

    expect(registry.getConversationBackendFactory("claude").backend).toBe(
      "claude",
    );
    expect(registry.getConversationBackendFactory("codex").backend).toBe(
      "codex",
    );
    expect(registry.getTaskRunner("claude").backend).toBe("claude");
    expect(registry.getTaskRunner("codex").backend).toBe("codex");
    expect(registry.getConversationBackendFactory("cursor").backend).toBe(
      "cursor",
    );
  });

  it("registers Cursor conversation and governed task facets", async () => {
    vi.resetModules();

    const registry = await import("./registry");
    const cursor = registry.getBackendDescriptor("cursor");

    expect(cursor.conversation).toBeDefined();
    expect(cursor.tasks?.execution.classes).toEqual([
      "nongoverned-task",
      "governed-execution",
    ]);
    expect(registry.getTaskRunner("cursor").backend).toBe("cursor");
  });

  it("declares each registered task facet's write-restriction support to the client-safe accessor", async () => {
    vi.resetModules();

    const registry = await import("./registry");
    const { getFsWriteRestrictionForBackend } = await import("./catalog");

    // The accessor is what definition validate consults (validation.ts is
    // client-imported and cannot pull the registry in), so a value that
    // disagreed with the descriptor would let validate admit a validator the
    // adapter cannot sandbox.
    for (const backend of ["claude", "codex"] as const) {
      const declared =
        registry.getBackendDescriptor(backend).tasks?.fsWriteRestriction;
      expect(declared).toBe("enforced");
      expect(getFsWriteRestrictionForBackend(backend)).toBe(declared);
    }
  });

  it("loads registered backends from the public barrel", async () => {
    vi.resetModules();

    const registry = await import("./index");

    expect(registry.getConversationBackendFactory("claude").backend).toBe(
      "claude",
    );
    expect(registry.getConversationBackendFactory("codex").backend).toBe(
      "codex",
    );
    expect(registry.getTaskRunner("claude").backend).toBe("claude");
    expect(registry.getTaskRunner("codex").backend).toBe("codex");
  });

  it("loads registered backends when collaboration production agent caller is imported", async () => {
    vi.resetModules();

    await import("@/lib/workflows/collaboration/agent-caller-production");
    const registry = await import("./registry-core");

    expect(registry.getConversationBackendFactory("claude").backend).toBe(
      "claude",
    );
    expect(registry.getConversationBackendFactory("codex").backend).toBe(
      "codex",
    );
    expect(registry.getTaskRunner("claude").backend).toBe("claude");
    expect(registry.getTaskRunner("codex").backend).toBe("codex");
  });
});
