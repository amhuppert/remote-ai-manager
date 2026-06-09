import { beforeEach, describe, expect, it, vi } from "vitest";

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
} from "./schemas";

import type { GlobalCapabilityOverrideStore } from "./global-store";
import type { ScopeCapabilityOverrideStore } from "./scope-store";
import { createCapabilityMutationService } from "./mutation-service";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

function allLoggedArgs(): string {
  return JSON.stringify([
    logger.debug.mock.calls,
    logger.info.mock.calls,
    logger.warn.mock.calls,
    logger.error.mock.calls,
  ]);
}

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
  async patchProjectConversation() {
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

function plcView(): AgentCapabilityViewResponse {
  return {
    level: "conversation",
    cascadeKind: "claude-skills",
    backend: "claude",
    projectName: "proj",
    conversationScope: "project",
    conversationId: "plc-1",
    items: [],
    diagnostics: [],
    effectiveHash: "hash-plc-after",
  };
}

const plcScope = {
  level: "conversation" as const,
  projectPath: "/projects/proj",
  conversationScope: "project" as const,
  conversationId: "plc-1",
};

describe("agent-capabilities/mutation-service lifecycle correlation", () => {
  beforeEach(() => {
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  it("logs PLC mutation.applied with project conversation scope and id, never the sentinel (Req 16.1, 16.3, 20.2)", async () => {
    const patchProjectConversation = vi.fn(
      async (
        projectPath: string,
        conversationId: string,
      ): Promise<{
        overrides: AgentCapabilityOverrides;
        changedItemIds: readonly string[];
      }> => {
        expect(projectPath).toBe("/projects/proj");
        expect(conversationId).toBe("plc-1");
        return { overrides: emptyOverrides(), changedItemIds: ["skill:a"] };
      },
    );
    const plcScopeStore: ScopeCapabilityOverrideStore = {
      ...scopeStore,
      patchProjectConversation,
    };
    const service = createCapabilityMutationService({
      globalStore,
      scopeStore: plcScopeStore,
      computeEffectiveHash: async () => "hash-plc-after",
      computeView: async () => plcView(),
      createOperationId: () => "cap-op-plc",
    });

    const result = await service.mutate({
      scope: plcScope,
      request: {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      },
    });

    expect(result.status).toBe("applied");
    expect(patchProjectConversation).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "mutation.applied",
      expect.objectContaining({
        cascadeKind: "claude-skills",
        level: "conversation",
        conversationScope: "project",
        conversationId: "plc-1",
        operationId: "cap-op-plc",
      }),
    );
    expect(allLoggedArgs()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(allLoggedArgs()).not.toContain("sessionName");
  });

  it("logs PLC mutation.rejected on hash conflict with project conversation scope, never the sentinel (Req 16.1, 16.3, 20.2)", async () => {
    const plcScopeStore: ScopeCapabilityOverrideStore = {
      ...scopeStore,
      // The real project-conversation store runs the injected precondition
      // inside its serialized mutate boundary; replicate that so the hash
      // conflict surfaces through the production rejection path.
      async patchProjectConversation(_projectPath, _conversationId, input) {
        await input.precondition?.(emptyOverrides());
        throw new Error(
          "store write must not run after a conflicting precondition",
        );
      },
    };
    const service = createCapabilityMutationService({
      globalStore,
      scopeStore: plcScopeStore,
      // The stored hash drifted from the client's expected hash, so the
      // serialized precondition rejects the write as a conflict.
      computeEffectiveHash: async () => "hash-actual",
      computeView: async () => plcView(),
      createOperationId: () => "cap-op-plc-conflict",
    });

    const result = await service.mutate({
      scope: plcScope,
      request: {
        cascadeKind: "claude-skills",
        expectedHash: "hash-stale",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      },
    });

    expect(result.status).toBe("conflict");
    expect(logger.info).toHaveBeenCalledWith(
      "mutation.rejected",
      expect.objectContaining({
        reason: "hash_conflict",
        cascadeKind: "claude-skills",
        level: "conversation",
        conversationScope: "project",
        conversationId: "plc-1",
        operationId: "cap-op-plc-conflict",
      }),
    );
    expect(allLoggedArgs()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(allLoggedArgs()).not.toContain("sessionName");
  });

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
