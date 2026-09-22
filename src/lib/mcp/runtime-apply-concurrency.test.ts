import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { projectConversationTarget } from "@/lib/conversations/conversation-target";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type {
  McpApplyResult,
  PortableMcpConfig,
} from "@/lib/agent-backends/portable-mcp";
import { computeEffectiveConfigHash } from "./config-hash";
import {
  createMcpRuntimeApplicationStore,
  createMcpRuntimeApplyService,
} from "./runtime-apply";

const projectPath = "/repo";
const target = projectConversationTarget("repo", "mcp-race");
const first: PortableMcpConfig = {
  servers: [{ id: "one", transport: "stdio", command: "first" }],
};
const second: PortableMcpConfig = {
  servers: [{ id: "two", transport: "stdio", command: "second" }],
};

describe("MCP save and turn-start concurrency", () => {
  it("clears a saved reset at the next boundary when that exact configuration was already accepted", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(projectPath);
      const hash = computeEffectiveConfigHash(first);
      await fixture.seedProjectConversation(
        projectPath,
        makeConversationState({
          id: target.conversationId,
          scope: "project",
          agentBackend: "codex",
          mcpRuntime: {
            lastAppliedConfigHash: hash,
            pendingConfigHash: computeEffectiveConfigHash(second),
            pendingServerKeys: ["two"],
            lastApplyDisposition: "deferred_to_next_turn",
          },
        }),
      );
      const service = createMcpRuntimeApplyService({
        applicationState: createMcpRuntimeApplicationStore(fixture.store),
        getRuntime: () => undefined,
        resolvePortableForConversation: async () => ({ portable: first }),
      });
      const identity = { projectPath, target, backend: "codex" as const };
      await service.applyAfterOverrideChange({
        ...identity,
        changedServerKeys: ["one", "two"],
      });
      expect(
        (
          await fixture.store.getProjectConversation(
            projectPath,
            target.conversationId,
          )
        )?.mcpRuntime?.pendingConfigHash,
      ).toBe(hash);
      const result = await service.applyAtTurnStart(identity);
      expect(result.disposition).toBe("applied_now");
      const reloaded = await fixture
        .recreateStore()
        .getProjectConversation(projectPath, target.conversationId);
      expect(reloaded?.mcpRuntime).toEqual({
        lastAppliedConfigHash: hash,
        lastApplyDisposition: "applied_now",
      });
    } finally {
      fixture.close();
    }
  });

  it("keeps a newer save when the already-accepted boundary check resolves slowly", async () => {
    const fixture = createPersistenceFixture();
    let releaseResolve: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let check: Promise<unknown> | undefined;
    try {
      fixture.seedProject(projectPath);
      const acceptedHash = computeEffectiveConfigHash(first);
      await fixture.seedProjectConversation(
        projectPath,
        makeConversationState({
          id: target.conversationId,
          scope: "project",
          agentBackend: "codex",
          mcpRuntime: {
            lastAppliedConfigHash: acceptedHash,
            pendingConfigHash: acceptedHash,
            pendingServerKeys: ["one"],
            lastApplyDisposition: "deferred_to_next_turn",
          },
        }),
      );
      const base = {
        applicationState: createMcpRuntimeApplicationStore(fixture.store),
        getRuntime: () => undefined,
      };
      const checkService = createMcpRuntimeApplyService({
        ...base,
        resolvePortableForConversation: async () => {
          startedResolve?.();
          await gate;
          return { portable: first };
        },
      });
      const saveService = createMcpRuntimeApplyService({
        ...base,
        resolvePortableForConversation: async () => ({ portable: second }),
      });
      const identity = { projectPath, target, backend: "codex" as const };
      check = checkService.applyAtTurnStart(identity);
      await started;
      await saveService.applyAfterOverrideChange({
        ...identity,
        changedServerKeys: ["two"],
      });
      releaseResolve?.();
      await check;
      const reloaded = await fixture
        .recreateStore()
        .getProjectConversation(projectPath, target.conversationId);
      expect(reloaded?.mcpRuntime).toEqual({
        lastAppliedConfigHash: acceptedHash,
        pendingConfigHash: computeEffectiveConfigHash(second),
        pendingServerKeys: ["two"],
        lastApplyDisposition: "no_active_runtime",
      });
    } finally {
      releaseResolve?.();
      await check;
      fixture.close();
    }
  });

  it.each(["deferred_to_next_turn", "rejected", "applied_now"] as const)(
    "preserves the newer save while an earlier delivery returns %s through another service",
    async (disposition) => {
      const fixture = createPersistenceFixture();
      let releaseDelivery: (() => void) | undefined;
      let beganDelivery: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const started = new Promise<void>((resolve) => {
        beganDelivery = resolve;
      });
      let earlier: Promise<unknown> | undefined;
      let save: Promise<unknown> | undefined;
      try {
        fixture.seedProject(projectPath);
        await fixture.seedProjectConversation(
          projectPath,
          makeConversationState({
            id: target.conversationId,
            scope: "project",
            agentBackend: "codex",
            mcpRuntime: {
              pendingConfigHash: computeEffectiveConfigHash(first),
              pendingServerKeys: ["one"],
              lastApplyDisposition: "deferred_to_next_turn",
            },
          }),
        );
        const runtime: ConversationBackendRuntime = {
          backend: "codex",
          status: "alive",
          isTurnActive: false,
          modelSelection: { modelId: "test", parameters: {} },
          sendTurn: async () => {
            throw new Error("unused");
          },
          close: async () => {},
          applyPortableMcpConfig: async (): Promise<McpApplyResult> => {
            beganDelivery?.();
            await gate;
            return {
              disposition,
              droppedServerIds: [],
              droppedFields: [],
              errors: disposition === "rejected" ? { one: "unavailable" } : {},
            };
          },
        };
        let portable = first;
        const deps = {
          applicationState: createMcpRuntimeApplicationStore(fixture.store),
          getRuntime: () => runtime,
          resolvePortableForConversation: async () => ({ portable }),
        };
        const turnService = createMcpRuntimeApplyService(deps);
        const saveService = createMcpRuntimeApplyService(deps);
        const identity = { projectPath, target, backend: "codex" as const };
        earlier = turnService.applyAtTurnStart(identity);
        await started;
        portable = second;
        save = saveService.applyAfterOverrideChange({
          ...identity,
          changedServerKeys: ["two"],
        });
        // Bound the assertion so a regression releases the held runtime and store.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const savedBeforeDelivery = await Promise.race([
          save.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 1000);
          }),
        ]);
        clearTimeout(timeout);
        expect(savedBeforeDelivery).toBe(true);
        releaseDelivery?.();
        await earlier;
        const reloaded = await fixture
          .recreateStore()
          .getProjectConversation(projectPath, target.conversationId);
        expect(reloaded?.mcpRuntime).toEqual({
          ...(disposition === "applied_now"
            ? { lastAppliedConfigHash: computeEffectiveConfigHash(first) }
            : {}),
          pendingConfigHash: computeEffectiveConfigHash(second),
          pendingServerKeys: ["two"],
          lastApplyDisposition: "deferred_to_next_turn",
        });
      } finally {
        releaseDelivery?.();
        await Promise.allSettled([earlier, save]);
        fixture.close();
      }
    },
  );
});
