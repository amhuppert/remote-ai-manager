import { describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import type {
  AgentCapabilityOverrides,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

import type { GlobalCapabilityOverrideStore } from "./global-store";
import type { ScopeCapabilityOverrideStore } from "./scope-store";
import { createCapabilityMutationService } from "./mutation-service";

function emptyOverrides(): AgentCapabilityOverrides {
  return { cascades: {} };
}

const globalStore: GlobalCapabilityOverrideStore = {
  async read() {
    return emptyOverrides();
  },
  async patch() {
    return {
      overrides: emptyOverrides(),
      changedItemIds: ["skill:a"],
    };
  },
};

const scopeStore: ScopeCapabilityOverrideStore = {
  async patchProject() {
    throw new Error("not used");
  },
  async patchSession() {
    throw new Error("not used");
  },
  async patchConversation() {
    throw new Error("not used");
  },
};

function view(): AgentCapabilityViewResponse {
  return {
    level: "global",
    cascadeKind: "claude-skills",
    backend: "claude",
    items: [],
    diagnostics: [],
    effectiveHash: "hash-after",
  };
}

describe("agent-capabilities/mutation-service lifecycle correlation", () => {
  it("returns one operation id and passes it to post-mutation apply fanout and logs", async () => {
    const applyAfterMutation = vi.fn(async () => {});
    const service = createCapabilityMutationService({
      globalStore,
      scopeStore,
      computeEffectiveHash: async () => "hash-after",
      computeView: async () => view(),
      applyAfterMutation,
      createOperationId: () => "cap-op-1",
    });

    const result = await service.mutate({
      scope: { level: "global" },
      request: {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      },
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    expect(result.operationId).toBe("cap-op-1");
    expect(applyAfterMutation).toHaveBeenCalledWith({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["skill:a"],
      operationId: "cap-op-1",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "mutation.applied",
      expect.objectContaining({
        cascadeKind: "claude-skills",
        changedCount: 1,
        effectiveHash: "hash-after",
        level: "global",
        operationId: "cap-op-1",
      }),
    );
  });
});
