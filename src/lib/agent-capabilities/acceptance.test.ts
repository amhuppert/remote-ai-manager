import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityCascadeKind,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityInventory,
  AgentCapabilityOverrides,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

import { applyCapabilityOperations } from "./patch";
import {
  createCapabilityMutationService,
  type MutationScope,
} from "./mutation-service";
import { createGlobalCapabilityHandlers } from "./route-handlers";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ClaudeApplyPortInput,
  type ClaudeApplyPortResult,
} from "./apply-service";
import { composeConversationStartRuntime } from "./runtime-composer";
import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import { resolveCascadeView, resolvePluginEnablement } from "./resolver";

function request(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

function discoveredPlugin(itemId: string): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "plugin",
    source: { kind: "plugin", pluginId: itemId },
    nativeDefault: { enabled: true },
    runtimeVisibility: "runtime-visible",
  };
}

function discoveredSkill(
  itemId: string,
  owningPluginId?: string,
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "project-file", path: `/repo/.claude/skills/${itemId}` },
    nativeDefault: { enabled: true },
    ...(owningPluginId === undefined ? {} : { owningPluginId }),
    runtimeVisibility: "runtime-visible",
  };
}

function codexSkill(itemId: string): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "project-file", path: `/repo/.agents/skills/${itemId}` },
    nativeDefault: { enabled: true },
    runtimeVisibility: "source-only",
  };
}

function emptyOverrides(): AgentCapabilityOverrides {
  return { cascades: {} };
}

describe("agent capability end-to-end acceptance", () => {
  it("covers discovery, toggle, inheritance, apply, SSE, isolation, verification-gated, and non-blocking diagnostics", async () => {
    let globalOverrides = emptyOverrides();
    const events: AgentCapabilitiesUpdatedEvent[] = [];
    const writes: AgentCapabilityOverrides[] = [];
    const runtimeWrites: unknown[] = [];
    const applyClaudeRuntime = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));

    const claudePlugins = [discoveredPlugin("owner-plugin")];
    const claudeSkills = [
      discoveredSkill("child-skill", "owner-plugin"),
      discoveredSkill("standalone-skill"),
    ];
    const codexSkills = [codexSkill("codex-skill")];

    const overrideChain = () => [
      { layer: "global" as const, overrides: globalOverrides },
    ];

    const resolveView = (
      cascadeKind: AgentCapabilityCascadeKind,
    ): AgentCapabilityViewResponse => {
      const pluginResolution =
        cascadeKind === "claude-skills"
          ? resolvePluginEnablement({
              pluginCascadeKind: "claude-plugins",
              discoveredPlugins: claudePlugins,
              overrideChain: overrideChain(),
            })
          : undefined;
      const discoveredItems =
        cascadeKind === "claude-plugins"
          ? claudePlugins
          : cascadeKind === "claude-skills"
            ? claudeSkills
            : cascadeKind === "codex-skills"
              ? codexSkills
              : [];
      return resolveCascadeView({
        cascadeKind,
        scope: { level: "global" },
        overrideChain: overrideChain(),
        discoveredItems,
        metadata: defaultAgentCapabilityMetadataRegistry.get(cascadeKind),
        ...(pluginResolution === undefined ? {} : { pluginResolution }),
        discoveryDiagnostics:
          cascadeKind === "codex-plugins"
            ? [
                {
                  severity: "warning",
                  code: "codex-plugins-unavailable",
                  message: "Codex plugin discovery is verification-gated.",
                  cascadeKind: "codex-plugins",
                  backend: "codex",
                },
              ]
            : [],
      });
    };

    const affectedConversation: AffectedConversation = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
      isTurnActive: false,
    };

    const applyService = createCapabilityRuntimeApplyService({
      listAffectedConversations: async () => [affectedConversation],
      isTurnActive: () => false,
      composeForConversation: async () =>
        composeConversationStartRuntime({
          backend: "claude",
          scope: {
            level: "conversation",
            projectName: "repo",
            sessionName: "session-a",
            conversationId: "conv-1",
          },
          overrideChain: overrideChain(),
          discoveryByCascade: {
            "claude-plugins": { items: claudePlugins },
            "claude-skills": { items: claudeSkills },
          },
        }),
      readRuntimeState: async () => undefined,
      writeRuntimeState: async (input) => {
        runtimeWrites.push(input.state);
      },
      applyClaudeRuntime,
    });

    const mutationService = createCapabilityMutationService({
      globalStore: {
        async read() {
          return globalOverrides;
        },
        async patch(input) {
          const result = applyCapabilityOperations({
            current: globalOverrides,
            cascadeKind: input.cascadeKind,
            operations: input.operations,
          });
          globalOverrides = result.overrides;
          writes.push(result.overrides);
          return result;
        },
      },
      scopeStore: {
        async patchProject() {
          throw new Error("not used");
        },
        async patchSession() {
          throw new Error("not used");
        },
        async patchConversation() {
          throw new Error("not used");
        },
      },
      computeEffectiveHash: async (
        _scope: MutationScope,
        cascadeKind: AgentCapabilityCascadeKind,
      ) => resolveView(cascadeKind).effectiveHash,
      computeView: async (
        _scope: MutationScope,
        cascadeKind: AgentCapabilityCascadeKind,
      ) => resolveView(cascadeKind),
      createOperationId: () => "cap-acceptance-1",
      async applyAfterMutation(input) {
        await applyService.applyAfterOverrideChange(input);
      },
    });

    const handlers = createGlobalCapabilityHandlers({
      resolveView: async (input) => resolveView(input.cascadeKind),
      mutate: (input) => mutationService.mutate(input),
      refreshDiscovery: async (input) => {
        const view = resolveView(input.cascadeKind);
        const inventory: AgentCapabilityInventory = {
          cascadeKind: input.cascadeKind,
          items: view.items.map((row) => ({
            itemId: row.itemId,
            displayName: row.displayName,
            capabilityKind: row.capabilityKind,
            source: row.source,
            nativeDefault: row.nativeDefault,
            ...(row.owningPluginId === undefined
              ? {}
              : { owningPluginId: row.owningPluginId }),
            runtimeVisibility: row.runtimeVisibility,
          })),
          diagnostics: view.diagnostics,
          sourceSignature: `${input.cascadeKind}:sig`,
          refreshedAt: "2026-05-18T12:00:00.000Z",
        };
        return { inventory, view };
      },
      broadcast(event) {
        if (event.type === "agent-capabilities-updated") {
          events.push(event);
        }
      },
    });

    const patchResponse = await handlers.PATCH(
      request("PATCH", "http://cc.test/api/config/agent-capabilities", {
        cascadeKind: "claude-plugins",
        operations: [
          {
            type: "set-item-enabled",
            itemId: "owner-plugin",
            enabled: false,
          },
        ],
      }),
    );
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      operationId: "cap-acceptance-1",
      invalidationHints: {
        cascadeKind: "claude-plugins",
        operationId: "cap-acceptance-1",
      },
    });
    expect(writes).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent-capabilities-updated",
      cascadeKind: "claude-plugins",
      operationId: "cap-acceptance-1",
      invalidationHints: { operationId: "cap-acceptance-1" },
    });
    expect(applyClaudeRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeWrites).toHaveLength(1);

    const refreshedSkills = await handlers.GET(
      request(
        "GET",
        "http://cc.test/api/config/agent-capabilities?cascadeKind=claude-skills",
      ),
    );
    const refreshedBody = await refreshedSkills.json();
    const child = refreshedBody.view.items.find(
      (row: { itemId: string }) => row.itemId === "child-skill",
    );
    expect(child).toMatchObject({
      effectiveState: { enabled: false, originLayer: "global" },
      inheritedDisableReason: {
        pluginId: "owner-plugin",
        originLayer: "global",
      },
    });

    const claudeComposition = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: overrideChain(),
      discoveryByCascade: {
        "claude-plugins": { items: claudePlugins },
        "claude-skills": { items: claudeSkills },
      },
    });
    expect(claudeComposition.views["claude-skills"]?.items).toContainEqual(
      expect.objectContaining({
        itemId: "child-skill",
        effectiveState: { enabled: false, originLayer: "global" },
      }),
    );

    const codexComposition = composeConversationStartRuntime({
      backend: "codex",
      scope: { level: "conversation" },
      overrideChain: overrideChain(),
      discoveryByCascade: {
        "codex-skills": { items: codexSkills },
        "claude-skills": { items: claudeSkills },
      },
    });
    expect(codexComposition.views["claude-skills"]).toBeUndefined();
    expect(codexComposition.views["codex-skills"]).toBeDefined();

    const verificationGated = resolveView("codex-plugins");
    expect(verificationGated.metadata?.compositionSupport).toBe(
      "verification-gated",
    );
    expect(verificationGated.diagnostics[0]).toMatchObject({
      code: "codex-plugins-unavailable",
      backend: "codex",
    });

    const nonBlocking = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: overrideChain(),
      discoveryByCascade: {
        "claude-plugins": { items: claudePlugins },
        "claude-skills": {
          items: [],
          diagnostics: [
            {
              severity: "warning",
              code: "agent-capability-source-unreadable",
              message: "Skill source unreadable",
              cascadeKind: "claude-skills",
              backend: "claude",
            },
          ],
        },
      },
      failedCascadeKinds: ["claude-skills"],
    });
    expect(nonBlocking.claudeRuntime).toBeDefined();
    expect(nonBlocking.failedCascadeKinds).toEqual(["claude-skills"]);
    expect(nonBlocking.diagnostics).toContainEqual(
      expect.objectContaining({
        cascadeKind: "claude-skills",
        backend: "claude",
      }),
    );
  });
});
