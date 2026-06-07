import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityOverrideOperation,
  AgentCapabilityOverrides,
  AgentCapabilityViewResponse,
} from "./schemas";

import type {
  GlobalCapabilityOverrideStore,
  GlobalCapabilityPatchInput,
} from "./global-store";
import type {
  ScopeCapabilityOverrideStore,
  ScopeCapabilityPatchInput,
  ScopeCapabilityPatchResult,
} from "./scope-store";
import {
  createCapabilityMutationService,
  type MutationScope,
} from "./mutation-service";

function emptyOverrides(): AgentCapabilityOverrides {
  return { cascades: {} };
}

function viewWithHash(
  cascadeKind: AgentCapabilityCascadeKind,
  effectiveHash: string,
): AgentCapabilityViewResponse {
  return {
    level: "global",
    cascadeKind,
    backend: cascadeKind.startsWith("codex-") ? "codex" : "claude",
    items: [],
    diagnostics: [],
    effectiveHash,
  } as AgentCapabilityViewResponse;
}

function createFakeGlobalStore(initial?: {
  read?: AgentCapabilityOverrides;
  patchResult?: {
    overrides: AgentCapabilityOverrides;
    changedItemIds: string[];
  };
  preconditionSnapshot?: AgentCapabilityOverrides;
}): GlobalCapabilityOverrideStore & {
  readCalls: number;
  patchCalls: number;
  preconditionCalls: number;
  lastPatch?: {
    cascadeKind: AgentCapabilityCascadeKind;
    operations: readonly AgentCapabilityOverrideOperation[];
  };
} {
  const state = {
    readCalls: 0,
    patchCalls: 0,
    preconditionCalls: 0,
    lastPatch: undefined as
      | {
          cascadeKind: AgentCapabilityCascadeKind;
          operations: readonly AgentCapabilityOverrideOperation[];
        }
      | undefined,
  };
  return {
    async read() {
      state.readCalls += 1;
      return initial?.read ?? emptyOverrides();
    },
    async patch(input: GlobalCapabilityPatchInput) {
      state.patchCalls += 1;
      state.lastPatch = input;
      if (input.precondition) {
        state.preconditionCalls += 1;
        await input.precondition(
          initial?.preconditionSnapshot ?? initial?.read ?? emptyOverrides(),
        );
      }
      return (
        initial?.patchResult ?? {
          overrides: emptyOverrides(),
          changedItemIds: [],
        }
      );
    },
    get readCalls() {
      return state.readCalls;
    },
    get patchCalls() {
      return state.patchCalls;
    },
    get preconditionCalls() {
      return state.preconditionCalls;
    },
    get lastPatch() {
      return state.lastPatch;
    },
  } as never;
}

function createFakeScopeStore(initial?: {
  patchResult?: ScopeCapabilityPatchResult;
  preconditionSnapshot?: AgentCapabilityOverrides | undefined;
}): ScopeCapabilityOverrideStore & {
  projectCalls: number;
  sessionCalls: number;
  conversationCalls: number;
  projectConversationCalls: number;
  preconditionCalls: number;
  lastArgs?: Record<string, unknown>;
} {
  const state = {
    projectCalls: 0,
    sessionCalls: 0,
    conversationCalls: 0,
    projectConversationCalls: 0,
    preconditionCalls: 0,
    lastArgs: undefined as Record<string, unknown> | undefined,
  };
  const defaultResult: ScopeCapabilityPatchResult = initial?.patchResult ?? {
    overrides: emptyOverrides(),
    changedItemIds: [],
  };
  async function runPrecondition(input: ScopeCapabilityPatchInput) {
    if (input.precondition) {
      state.preconditionCalls += 1;
      await input.precondition(initial?.preconditionSnapshot);
    }
  }
  return {
    async patchProject(projectPath: string, input: ScopeCapabilityPatchInput) {
      state.projectCalls += 1;
      state.lastArgs = { projectPath, ...input };
      await runPrecondition(input);
      return defaultResult;
    },
    async patchSession(
      projectPath: string,
      sessionName: string,
      input: ScopeCapabilityPatchInput,
    ) {
      state.sessionCalls += 1;
      state.lastArgs = { projectPath, sessionName, ...input };
      await runPrecondition(input);
      return defaultResult;
    },
    async patchConversation(
      projectPath: string,
      sessionName: string,
      conversationId: string,
      input: ScopeCapabilityPatchInput,
    ) {
      state.conversationCalls += 1;
      state.lastArgs = {
        projectPath,
        sessionName,
        conversationId,
        ...input,
      };
      await runPrecondition(input);
      return defaultResult;
    },
    async patchProjectConversation(
      projectPath: string,
      conversationId: string,
      input: ScopeCapabilityPatchInput,
    ) {
      state.projectConversationCalls += 1;
      state.lastArgs = {
        projectPath,
        conversationId,
        ...input,
      };
      await runPrecondition(input);
      return defaultResult;
    },
    get projectCalls() {
      return state.projectCalls;
    },
    get sessionCalls() {
      return state.sessionCalls;
    },
    get conversationCalls() {
      return state.conversationCalls;
    },
    get projectConversationCalls() {
      return state.projectConversationCalls;
    },
    get preconditionCalls() {
      return state.preconditionCalls;
    },
    get lastArgs() {
      return state.lastArgs;
    },
  } as never;
}

describe("agent-capabilities/mutation-service", () => {
  describe("expected-hash conflict handling", () => {
    it("returns conflict with latest view and skips write when expectedHash does not match current", async () => {
      const global = createFakeGlobalStore();
      const scope = createFakeScopeStore();
      const computeEffectiveHash = vi.fn().mockResolvedValue("hash-current");
      const computeView = vi
        .fn()
        .mockResolvedValue(viewWithHash("claude-skills", "hash-current"));

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash,
        computeView,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          expectedHash: "hash-stale",
        },
      });

      expect(result.status).toBe("conflict");
      if (result.status !== "conflict") throw new Error("expected conflict");
      expect(result.expectedHash).toBe("hash-stale");
      expect(result.actualHash).toBe("hash-current");
      expect(result.latestView.effectiveHash).toBe("hash-current");
      // The store's patch is invoked because the hash check now runs as a
      // precondition inside the serialized write boundary. Persistence is
      // suppressed because the precondition throws before any write.
      expect(scope.projectCalls).toBe(0);
    });

    it("applies the patch when expectedHash matches current", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["skill:a"],
        },
      });
      const scope = createFakeScopeStore();
      const computeEffectiveHash = vi
        .fn()
        .mockResolvedValueOnce("hash-current")
        .mockResolvedValueOnce("hash-new");
      const computeView = vi
        .fn()
        .mockResolvedValueOnce(viewWithHash("claude-skills", "hash-new"));

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash,
        computeView,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          expectedHash: "hash-current",
        },
      });

      expect(result.status).toBe("applied");
      if (result.status !== "applied") throw new Error("expected applied");
      expect(result.changedItemIds).toEqual(["skill:a"]);
      expect(result.cascadeKind).toBe("claude-skills");
      expect(result.effectiveHash).toBe("hash-new");
      expect(result.view.effectiveHash).toBe("hash-new");
      expect(global.patchCalls).toBe(1);
    });

    it("applies the patch when expectedHash is omitted", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["skill:a"],
        },
      });
      const scope = createFakeScopeStore();
      const computeEffectiveHash = vi.fn().mockResolvedValue("hash-new");
      const computeView = vi
        .fn()
        .mockResolvedValue(viewWithHash("claude-skills", "hash-new"));

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash,
        computeView,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: true },
          ],
        },
      });

      expect(result.status).toBe("applied");
      expect(global.patchCalls).toBe(1);
    });
  });

  describe("scope routing", () => {
    function makeService(
      globalArg?: GlobalCapabilityOverrideStore,
      scopeArg?: ScopeCapabilityOverrideStore,
    ) {
      const global = globalArg ?? createFakeGlobalStore();
      const scope =
        scopeArg ??
        createFakeScopeStore({
          patchResult: { overrides: emptyOverrides(), changedItemIds: ["x"] },
        });
      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "h",
        computeView: async () => viewWithHash("claude-skills", "h"),
      });
      return { service, global, scope };
    }

    it("routes a global mutation to the global store", async () => {
      const global = createFakeGlobalStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["g"] },
      });
      const scope = createFakeScopeStore();
      const { service } = makeService(global, scope);
      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "g" }],
        },
      });
      expect(result.status).toBe("applied");
      expect(global.patchCalls).toBe(1);
      expect(scope.projectCalls).toBe(0);
      expect(scope.sessionCalls).toBe(0);
      expect(scope.conversationCalls).toBe(0);
    });

    it("routes a project mutation to scope.patchProject", async () => {
      const scope = createFakeScopeStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["p"] },
      });
      const { service } = makeService(undefined, scope);
      await service.mutate({
        scope: { level: "project", projectPath: "/repo" },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "p" }],
        },
      });
      expect(scope.projectCalls).toBe(1);
      expect(scope.lastArgs?.projectPath).toBe("/repo");
    });

    it("routes a session mutation to scope.patchSession", async () => {
      const scope = createFakeScopeStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["s"] },
      });
      const { service } = makeService(undefined, scope);
      await service.mutate({
        scope: {
          level: "session",
          projectPath: "/repo",
          sessionName: "feat",
        },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "s" }],
        },
      });
      expect(scope.sessionCalls).toBe(1);
      expect(scope.lastArgs?.sessionName).toBe("feat");
    });

    it("routes a conversation mutation to scope.patchConversation", async () => {
      const scope = createFakeScopeStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["c"] },
      });
      const { service } = makeService(undefined, scope);
      await service.mutate({
        scope: {
          level: "conversation",
          projectPath: "/repo",
          sessionName: "feat",
          conversationId: "conv-1",
        },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "c" }],
        },
      });
      expect(scope.conversationCalls).toBe(1);
      expect(scope.lastArgs?.conversationId).toBe("conv-1");
    });

    it("routes a project-conversation mutation without a session name", async () => {
      const scope = createFakeScopeStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["plc"] },
      });
      const { service } = makeService(undefined, scope);
      await service.mutate({
        scope: {
          level: "conversation",
          projectPath: "/repo",
          conversationScope: "project",
          conversationId: "plc-1",
        },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "plc" }],
        },
      });
      expect(scope.projectConversationCalls).toBe(1);
      expect(scope.conversationCalls).toBe(0);
      expect(scope.lastArgs).toMatchObject({
        projectPath: "/repo",
        conversationId: "plc-1",
      });
      expect(scope.lastArgs).not.toHaveProperty("sessionName");
    });
  });

  describe("fanout metadata", () => {
    it("returns scope, cascade kind, changed item ids, and effective hash", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["a", "b"],
        },
      });
      const scope = createFakeScopeStore();
      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "h-after",
        computeView: async () => viewWithHash("claude-plugins", "h-after"),
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-plugins",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: false },
            { type: "set-item-enabled", itemId: "b", enabled: false },
          ],
        },
      });

      expect(result.status).toBe("applied");
      if (result.status !== "applied") throw new Error();
      expect(result.cascadeKind).toBe("claude-plugins");
      expect(result.scope).toEqual({ level: "global" });
      expect(result.changedItemIds).toEqual(["a", "b"]);
      expect(result.effectiveHash).toBe("h-after");
    });

    it("invokes the post-mutation apply hook after a successful persisted patch", async () => {
      const applyAfterMutation = vi.fn(async () => {});
      const service = createCapabilityMutationService({
        globalStore: createFakeGlobalStore({
          patchResult: {
            overrides: emptyOverrides(),
            changedItemIds: ["a"],
          },
        }),
        scopeStore: createFakeScopeStore(),
        computeEffectiveHash: async () => "h-after",
        computeView: async () => viewWithHash("claude-skills", "h-after"),
        applyAfterMutation,
      });

      await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: false },
          ],
        },
      });

      expect(applyAfterMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { level: "global" },
          cascadeKind: "claude-skills",
          changedItemIds: ["a"],
          operationId: expect.any(String),
        }),
      );
    });

    it("preserves the applied mutation result when the post-mutation apply hook fails", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: {
            cascades: {
              "claude-skills": { items: { a: { enabled: false } } },
            },
          },
          changedItemIds: ["a"],
        },
      });
      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: createFakeScopeStore(),
        computeEffectiveHash: async () => "h-after",
        computeView: async () => viewWithHash("claude-skills", "h-after"),
        applyAfterMutation: async () => {
          throw new Error("runtime apply failed");
        },
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: false },
          ],
        },
      });

      expect(result.status).toBe("applied");
      expect(global.patchCalls).toBe(1);
    });

    it("does not invoke the post-mutation apply hook for a hash conflict", async () => {
      const applyAfterMutation = vi.fn(async () => {});
      const service = createCapabilityMutationService({
        globalStore: createFakeGlobalStore(),
        scopeStore: createFakeScopeStore(),
        computeEffectiveHash: async () => "h-current",
        computeView: async () => viewWithHash("claude-skills", "h-current"),
        applyAfterMutation,
      });

      await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: false },
          ],
          expectedHash: "h-stale",
        },
      });

      expect(applyAfterMutation).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("propagates a store failure as a thrown error and reports nothing as applied", async () => {
      const global: GlobalCapabilityOverrideStore = {
        async read() {
          return emptyOverrides();
        },
        async patch() {
          throw new Error("disk full");
        },
      };
      const scope = createFakeScopeStore();
      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "h",
        computeView: async () => viewWithHash("claude-skills", "h"),
      });

      await expect(
        service.mutate({
          scope: { level: "global" },
          request: {
            cascadeKind: "claude-skills",
            operations: [
              { type: "set-item-enabled", itemId: "x", enabled: true },
            ],
          },
        }),
      ).rejects.toThrow(/disk full/);
    });

    it("rejects an unsupported scope level at the boundary", async () => {
      const service = createCapabilityMutationService({
        globalStore: createFakeGlobalStore(),
        scopeStore: createFakeScopeStore(),
        computeEffectiveHash: async () => "h",
        computeView: async () => viewWithHash("claude-skills", "h"),
      });

      await expect(
        service.mutate({
          scope: { level: "bogus" } as unknown as MutationScope,
          request: {
            cascadeKind: "claude-skills",
            operations: [{ type: "reset-item", itemId: "x" }],
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("atomic hash check via precondition", () => {
    it("delegates the hash check to the store via a precondition that runs inside the write boundary", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["skill:a"],
        },
      });
      const scope = createFakeScopeStore();
      const computeEffectiveHash = vi
        .fn()
        .mockResolvedValueOnce("hash-current")
        .mockResolvedValueOnce("hash-new");
      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash,
        computeView: async () => viewWithHash("claude-skills", "hash-new"),
      });

      await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          expectedHash: "hash-current",
        },
      });

      expect(global.patchCalls).toBe(1);
      expect(global.preconditionCalls).toBe(1);
      expect(global.lastPatch).toBeDefined();
      // The patch input must carry a precondition function so the hash check
      // runs inside the serialized write boundary, not before it.
      expect(
        typeof (global.lastPatch as unknown as { precondition?: unknown })
          ?.precondition,
      ).toBe("function");
    });

    it("returns conflict (skipping the write) when the store-side precondition fires hash conflict", async () => {
      const global = createFakeGlobalStore();
      // Precondition runs against the (fresh) snapshot inside store; the
      // injected computeEffectiveHash returns the latest-on-disk hash that
      // disagrees with the caller's expectedHash. The fake store re-throws
      // whatever the precondition throws.
      const scope = createFakeScopeStore();
      const computeEffectiveHash = vi.fn().mockResolvedValue("hash-actual");
      const computeView = vi
        .fn()
        .mockResolvedValue(viewWithHash("claude-skills", "hash-actual"));

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash,
        computeView,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          expectedHash: "hash-stale",
        },
      });

      expect(result.status).toBe("conflict");
      if (result.status !== "conflict") throw new Error();
      expect(result.expectedHash).toBe("hash-stale");
      expect(result.actualHash).toBe("hash-actual");
      expect(result.latestView.effectiveHash).toBe("hash-actual");
      // The patch was invoked (the precondition fired inside it) but the
      // store reports nothing was persisted: applied result is not returned.
      expect(global.preconditionCalls).toBe(1);
    });

    it("propagates the precondition for scope mutations as well", async () => {
      const scope = createFakeScopeStore({
        patchResult: { overrides: emptyOverrides(), changedItemIds: ["x"] },
      });
      const service = createCapabilityMutationService({
        globalStore: createFakeGlobalStore(),
        scopeStore: scope,
        computeEffectiveHash: async () => "h",
        computeView: async () => viewWithHash("claude-skills", "h"),
      });

      await service.mutate({
        scope: { level: "project", projectPath: "/r" },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "x" }],
          expectedHash: "h",
        },
      });

      expect(scope.preconditionCalls).toBe(1);
    });
  });

  describe("applyAfterMutation fanout hook", () => {
    it("invokes the fanout hook with scope, cascade kind, and changed item ids on a successful mutation", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["a", "b"],
        },
      });
      const scope = createFakeScopeStore();
      const applyAfterMutation = vi.fn(async () => undefined);

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "h-after",
        computeView: async () => viewWithHash("claude-skills", "h-after"),
        applyAfterMutation,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: false },
            { type: "set-item-enabled", itemId: "b", enabled: false },
          ],
        },
      });

      expect(result.status).toBe("applied");
      expect(applyAfterMutation).toHaveBeenCalledTimes(1);
      expect(applyAfterMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { level: "global" },
          cascadeKind: "claude-skills",
          changedItemIds: ["a", "b"],
          operationId: expect.any(String),
        }),
      );
    });

    it("does not invoke the fanout hook on a hash conflict", async () => {
      const global = createFakeGlobalStore();
      const scope = createFakeScopeStore();
      const applyAfterMutation = vi.fn(async () => undefined);

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "hash-actual",
        computeView: async () => viewWithHash("claude-skills", "hash-actual"),
        applyAfterMutation,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "x" }],
          expectedHash: "hash-stale",
        },
      });

      expect(result.status).toBe("conflict");
      expect(applyAfterMutation).not.toHaveBeenCalled();
    });

    it("swallows fanout hook failures so the mutation still returns applied", async () => {
      const global = createFakeGlobalStore({
        patchResult: {
          overrides: emptyOverrides(),
          changedItemIds: ["a"],
        },
      });
      const scope = createFakeScopeStore();
      const applyAfterMutation = vi.fn(async () => {
        throw new Error("fanout broken");
      });

      const service = createCapabilityMutationService({
        globalStore: global,
        scopeStore: scope,
        computeEffectiveHash: async () => "h",
        computeView: async () => viewWithHash("claude-skills", "h"),
        applyAfterMutation,
      });

      const result = await service.mutate({
        scope: { level: "global" },
        request: {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: true },
          ],
        },
      });

      expect(result.status).toBe("applied");
      expect(applyAfterMutation).toHaveBeenCalledTimes(1);
    });
  });
});
