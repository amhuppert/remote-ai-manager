import { describe, expect, it, vi } from "vitest";

describe("agent backend registry bootstrap", () => {
  it("loads registered backends from the registry entrypoint", async () => {
    vi.resetModules();

    const registry = await import("./registry");

    expect(registry.getConversationBackendFactory("claude").backend).toBe(
      "claude",
    );
    expect(registry.getTaskRunner("claude").backend).toBe("claude");
    expect(registry.getTaskRunner("codex").backend).toBe("codex");
  });

  it("loads registered backends from the public barrel", async () => {
    vi.resetModules();

    const registry = await import("./index");

    expect(registry.getConversationBackendFactory("claude").backend).toBe(
      "claude",
    );
    expect(registry.getTaskRunner("claude").backend).toBe("claude");
    expect(registry.getTaskRunner("codex").backend).toBe("codex");
  });
});
