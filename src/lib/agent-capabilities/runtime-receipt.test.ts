import { describe, expect, it } from "vitest";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import {
  projectConversationTarget,
  sessionConversationTarget,
} from "@/lib/conversations/conversation-target";
import { computeCascadeRuntimeHash } from "./runtime-hashes";
import { recordCapabilityConfigReceipt } from "./runtime-receipt";
import {
  createCapabilityConfigComposer,
  reconcileDeliveredCapabilityState,
} from "./runtime-seed";
import {
  agentCapabilitiesUpdatedEventSchema,
  type AgentCapabilitiesUpdatedEvent,
  type AgentCapabilityRuntimeApplicationState,
} from "./schemas";
import { computeAgentCapabilityInvalidations } from "./sse-invalidation";

const delivered: ResolvedCapabilityCascade = {
  backend: "codex",
  kinds: [
    {
      kind: "skills",
      items: [
        { itemId: "review", enabled: false, originLayer: "conversation" },
      ],
    },
    {
      kind: "plugins",
      items: [{ itemId: "tools", enabled: true, originLayer: "project" }],
    },
  ],
};
const skillHash = computeCascadeRuntimeHash({
  cascadeKind: "codex-skills",
  rows: delivered.kinds[0]?.items ?? [],
});
const pluginHash = computeCascadeRuntimeHash({
  cascadeKind: "codex-plugins",
  rows: delivered.kinds[1]?.items ?? [],
});

describe("capability configuration acceptance receipts", () => {
  it("does not mark creation-only selections applied before backend acceptance", async () => {
    const runtimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "cursor-skills": {
          pendingHash: "desired",
          lastApplyStatus: "deferred-next-conversation",
        },
      },
    };
    const compose = createCapabilityConfigComposer(async () => ({
      backend: "cursor",
      capabilities: {
        backend: "cursor",
        kinds: [{ kind: "skills", items: [] }],
      },
      runtimeState,
      diagnostics: [],
      views: {},
      failedCascadeKinds: [],
    }));

    const seed = await compose({
      conversationScope: "project",
      projectPath: "/project",
      projectName: "demo",
      conversationId: "conversation",
      worktreePath: "/project",
      backend: "cursor",
    });

    expect(seed?.runtimeState).toEqual(runtimeState);
    expect(
      seed?.runtimeState.cascades["cursor-skills"]?.appliedHash,
    ).toBeUndefined();
    expect(seed?.runtimeState.cascades["cursor-skills"]?.pendingHash).toBe(
      "desired",
    );
  });

  it("keeps a newer pending change after a delayed accepted-input receipt", () => {
    const accepted: ResolvedCapabilityCascade = {
      backend: "codex",
      kinds: [
        {
          kind: "skills",
          items: [{ itemId: "a", enabled: true, originLayer: "global" }],
        },
      ],
    };
    const unrelated = {
      pendingHash: "plugins-pending",
      lastApplyStatus: "staged-next-turn" as const,
    };
    const reconciled = reconcileDeliveredCapabilityState(
      {
        cascades: {
          "codex-skills": {
            pendingHash: "newer-pending",
            lastApplyStatus: "staged-next-turn",
          },
          "codex-plugins": unrelated,
        },
      },
      accepted,
    );

    expect(reconciled.cascades["codex-skills"]).toEqual({
      appliedHash: computeCascadeRuntimeHash({
        cascadeKind: "codex-skills",
        rows: accepted.kinds[0]?.items ?? [],
      }),
      pendingHash: "newer-pending",
      lastApplyStatus: "staged-next-turn",
    });
    expect(reconciled.cascades["codex-plugins"]).toEqual(unrelated);
  });

  it.each([
    projectConversationTarget("demo", "conversation"),
    sessionConversationTarget("demo", "work", "conversation"),
  ])(
    "publishes each accepted kind after updating the $scope conversation",
    async (target) => {
      let state: AgentCapabilityRuntimeApplicationState = {
        cascades: {
          "codex-skills": {
            pendingHash: skillHash,
            pendingItemIds: ["review"],
            lastApplyStatus: "staged-next-turn",
          },
          "codex-plugins": {
            pendingHash: pluginHash,
            pendingItemIds: ["tools"],
            lastApplyStatus: "staged-next-turn",
          },
          "cursor-skills": {
            appliedHash: "unrelated",
            lastApplyStatus: "applied",
          },
        },
      };
      let committed = false;
      const events: AgentCapabilitiesUpdatedEvent[] = [];
      await recordCapabilityConfigReceipt(
        target,
        delivered,
        async (updater) => {
          state = updater(state);
          committed = true;
        },
        (event) => {
          expect(committed).toBe(true);
          expect(
            state.cascades[event.cascadeKind]?.pendingHash,
          ).toBeUndefined();
          events.push(event);
        },
      );

      expect(events).toHaveLength(2);
      expect(state.cascades["cursor-skills"]).toEqual({
        appliedHash: "unrelated",
        lastApplyStatus: "applied",
      });
      for (const event of events) {
        expect(
          agentCapabilitiesUpdatedEventSchema.safeParse(event).success,
        ).toBe(true);
        const expectedHash =
          event.cascadeKind === "codex-skills" ? skillHash : pluginHash;
        const expectedItems =
          event.cascadeKind === "codex-skills" ? ["review"] : ["tools"];
        expect(event).toMatchObject({
          type: "agent-capabilities-updated",
          level: "conversation",
          backend: "codex",
          projectName: "demo",
          conversationId: "conversation",
          conversationScope: target.scope,
          effectiveHash: expectedHash,
          changedItemIds: expectedItems,
          invalidationHints: {
            level: "conversation",
            cascadeKind: event.cascadeKind,
            effectiveHash: expectedHash,
            itemIds: expectedItems,
          },
        });
        expect(computeAgentCapabilityInvalidations(event)).toEqual([
          {
            queryKey: [
              "agent-capabilities",
              "conversation",
              "demo",
              event.cascadeKind,
              target.scope === "project" ? "project" : "work",
              "conversation",
            ],
          },
        ]);
        if (target.scope === "project") {
          expect(event).not.toHaveProperty("sessionName");
          expect(event.invalidationHints).not.toHaveProperty("sessionName");
        } else {
          expect(event.sessionName).toBe("work");
          expect(event.invalidationHints.sessionName).toBe("work");
        }
      }
    },
  );

  it("keeps newer pending intent and publishes its hash when an older receipt arrives", async () => {
    let state: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "codex-skills": { pendingHash: skillHash, pendingItemIds: ["review"] },
      },
    };
    const commit = Promise.withResolvers<void>();
    const events: AgentCapabilitiesUpdatedEvent[] = [];
    const receipt = recordCapabilityConfigReceipt(
      projectConversationTarget("demo", "conversation"),
      {
        ...delivered,
        kinds: delivered.kinds.filter((kind) => kind.kind === "skills"),
      },
      async (updater) => {
        await commit.promise;
        state = updater(state);
      },
      (event) => {
        events.push(event);
      },
    );
    expect(events).toEqual([]);
    state = {
      cascades: {
        "codex-skills": {
          pendingHash: "newer-preference",
          pendingItemIds: ["newer-item"],
          lastApplyStatus: "staged-next-turn",
        },
      },
    };
    commit.resolve();
    await receipt;

    expect(state.cascades["codex-skills"]).toMatchObject({
      appliedHash: skillHash,
      pendingHash: "newer-preference",
      pendingItemIds: ["newer-item"],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effectiveHash: "newer-preference",
      changedItemIds: ["newer-item"],
      invalidationHints: {
        effectiveHash: "newer-preference",
        itemIds: ["newer-item"],
      },
    });
  });

  it("does not publish an acceptance when the state update fails", async () => {
    const events: AgentCapabilitiesUpdatedEvent[] = [];
    await expect(
      recordCapabilityConfigReceipt(
        projectConversationTarget("demo", "conversation"),
        delivered,
        async () => {
          throw new Error("write failed");
        },
        (event) => {
          events.push(event);
        },
      ),
    ).rejects.toThrow("write failed");
    expect(events).toEqual([]);
  });
});
