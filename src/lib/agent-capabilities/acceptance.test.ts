import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityCascadeKind,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityInventory,
  AgentCapabilityOverrides,
  AgentCapabilityViewResponse,
} from "./schemas";

import { applyCapabilityOperations } from "./patch";
import {
  createCapabilityMutationService,
  type MutationScope,
} from "./mutation-service";
import {
  createGlobalCapabilityHandlers,
  createProjectConversationCapabilityHandlers,
} from "./route-handlers";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ClaudeApplyPortInput,
  type ClaudeApplyPortResult,
  type CodexApplyPortInput,
  type CodexApplyPortResult,
} from "./apply";
import { composeConversationStartRuntime } from "./runtime-composer";
import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  defaultAgentCapabilityMetadataRegistry,
} from "./metadata";
import { resolveCascadeView, resolvePluginEnablement } from "./resolver";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

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
  it("covers discovery, toggle, inheritance, apply, SSE, isolation, and non-blocking diagnostics", async () => {
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
        discoveryDiagnostics: [],
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
        async patchProjectConversation() {
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

    const codexPluginsView = resolveView("codex-plugins");
    expect(codexPluginsView.metadata?.compositionSupport).toBe("translator");
    expect(codexPluginsView.metadata?.discoverySupport).toBe("available");

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

const PLC_PROJECT_NAME = "repo";
const PLC_PROJECT_PATH = "/repo";
const PLC_CONVERSATION_ID = "plc-1";

function plcResolverScope() {
  return {
    level: "conversation" as const,
    projectName: PLC_PROJECT_NAME,
    conversationScope: "project" as const,
    conversationId: PLC_CONVERSATION_ID,
  };
}

describe("project-level conversation capability end-to-end acceptance", () => {
  it("inherits project, sets/clears a conversation override, applies per-backend, broadcasts, and stays inside the five-cascade boundary", async () => {
    // ---- Backend I/O boundary fakes (stores, ports, broadcast) only. ----
    // Two independent override stores so the PLC conversation layer persists in
    // isolation from the project layer that it inherits from.
    const globalOverrides = emptyOverrides();
    let projectOverrides = emptyOverrides();
    let plcOverrides = emptyOverrides();

    const events: AgentCapabilitiesUpdatedEvent[] = [];
    const claudeRuntimeWrites: Array<{
      conversationScope?: "session" | "project";
      conversationId: string;
      sessionName?: string;
      state: unknown;
    }> = [];
    const codexRuntimeWrites: Array<{
      conversationScope?: "session" | "project";
      conversationId: string;
      sessionName?: string;
      state: unknown;
    }> = [];

    const claudeSkills = [
      discoveredSkill("alpha-skill"),
      discoveredSkill("beta-skill"),
    ];
    const codexSkills = [codexSkill("codex-skill")];

    // global -> project -> conversation; NO session entry for a PLC. The
    // resolver drops any session layer for a project conversation, but a PLC
    // chain never even produces one.
    const plcOverrideChain = () => [
      { layer: "global" as const, overrides: globalOverrides },
      { layer: "project" as const, overrides: projectOverrides },
      { layer: "conversation" as const, overrides: plcOverrides },
    ];

    const resolvePlcView = (
      cascadeKind: AgentCapabilityCascadeKind,
    ): AgentCapabilityViewResponse => {
      const discoveredItems =
        cascadeKind === "claude-skills"
          ? claudeSkills
          : cascadeKind === "codex-skills"
            ? codexSkills
            : [];
      return resolveCascadeView({
        cascadeKind,
        scope: plcResolverScope(),
        overrideChain: plcOverrideChain(),
        discoveredItems,
        metadata: defaultAgentCapabilityMetadataRegistry.get(cascadeKind),
        discoveryDiagnostics: [],
      });
    };

    // ===== Step 1 — Open / inherit (Req 17.1, 17.3, 18.2). =====
    // Seed a PROJECT-layer disable for alpha-skill with NO conversation
    // override. The PLC must inherit the project value, and the view envelope
    // must carry the project conversation identity and never a session name.
    projectOverrides = applyCapabilityOperations({
      current: projectOverrides,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "alpha-skill", enabled: false },
      ],
    }).overrides;

    const inheritedView = resolvePlcView("claude-skills");
    expect(inheritedView.level).toBe("conversation");
    expect(inheritedView.conversationScope).toBe("project");
    expect(inheritedView.sessionName).toBeUndefined();
    const inheritedAlpha = inheritedView.items.find(
      (row) => row.itemId === "alpha-skill",
    );
    // Inherited from PROJECT layer because the PLC has no narrower override yet.
    expect(inheritedAlpha?.effectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
    // No direct value at the conversation layer yet; the row is inherited.
    expect(inheritedAlpha?.currentLayerValue).toBeUndefined();
    expect(inheritedAlpha?.inheritedEffectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });

    // ---- Wire the REAL mutation + apply services for the PLC route. ----
    // The apply service fans out to the single affected PLC. The conversation
    // is enumerated with a project-conversation identity (no sessionName) and
    // composes from the SAME override chain the resolver reads.
    const affectedPlc: AffectedConversation = {
      conversationScope: "project",
      projectPath: PLC_PROJECT_PATH,
      projectName: PLC_PROJECT_NAME,
      conversationId: PLC_CONVERSATION_ID,
      worktreePath: PLC_PROJECT_PATH,
      backend: "claude",
      isTurnActive: false,
    };

    const applyClaudeRuntime = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));

    const claudeApplyService = createCapabilityRuntimeApplyService({
      listAffectedConversations: async () => [affectedPlc],
      isTurnActive: () => false,
      composeForConversation: async (conversation) =>
        composeConversationStartRuntime({
          backend: "claude",
          scope: {
            level: "conversation",
            projectName: PLC_PROJECT_NAME,
            conversationScope: "project",
            conversationId: conversation.conversationId,
          },
          overrideChain: plcOverrideChain(),
          discoveryByCascade: {
            "claude-skills": { items: claudeSkills },
          },
        }),
      readRuntimeState: async () => undefined,
      writeRuntimeState: async (input) => {
        claudeRuntimeWrites.push({
          conversationScope: input.conversationScope,
          conversationId: input.conversationId,
          sessionName: "sessionName" in input ? input.sessionName : undefined,
          state: input.state,
        });
      },
      applyClaudeRuntime,
    });

    const plcMutationService = createCapabilityMutationService({
      globalStore: {
        async read() {
          return globalOverrides;
        },
        async patch() {
          throw new Error("PLC flow does not patch the global layer");
        },
      },
      scopeStore: {
        async patchProject() {
          throw new Error("PLC flow does not patch the project layer");
        },
        async patchSession() {
          throw new Error("PLC flow must never touch a session layer");
        },
        async patchConversation() {
          throw new Error(
            "PLC flow must never touch a session-conversation layer",
          );
        },
        // The PLC route drives ONLY this store method; it persists to the
        // selected project conversation's override record.
        async patchProjectConversation(_projectPath, conversationId, input) {
          expect(conversationId).toBe(PLC_CONVERSATION_ID);
          const result = applyCapabilityOperations({
            current: plcOverrides,
            cascadeKind: input.cascadeKind,
            operations: input.operations,
          });
          plcOverrides = result.overrides;
          return result;
        },
      },
      computeEffectiveHash: async (
        _scope: MutationScope,
        cascadeKind: AgentCapabilityCascadeKind,
      ) => resolvePlcView(cascadeKind).effectiveHash,
      computeView: async (
        _scope: MutationScope,
        cascadeKind: AgentCapabilityCascadeKind,
      ) => resolvePlcView(cascadeKind),
      createOperationId: () => "cap-plc-acceptance-1",
      async applyAfterMutation(input) {
        await claudeApplyService.applyAfterOverrideChange(input);
      },
    });

    const plcHandlers = createProjectConversationCapabilityHandlers({
      resolveView: async (input) => resolvePlcView(input.cascadeKind),
      mutate: (input) => plcMutationService.mutate(input),
      refreshDiscovery: async (input) => {
        const view = resolvePlcView(input.cascadeKind);
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
      resolveProjectPath: async () => PLC_PROJECT_PATH,
      broadcast(event) {
        if (event.type === "agent-capabilities-updated") {
          events.push(event);
        }
      },
    });

    const plcRouteContext = {
      params: Promise.resolve({
        name: PLC_PROJECT_NAME,
        conversationId: PLC_CONVERSATION_ID,
      }),
    };

    // ===== Step 2 — Set a conversation override that wins (Req 17.2, 18.3). =====
    // Disable beta-skill directly on the PLC conversation layer.
    const setResponse = await plcHandlers.PATCH(
      request(
        "PATCH",
        "http://cc.test/api/projects/repo/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "beta-skill", enabled: false },
          ],
        },
      ),
      plcRouteContext,
    );
    expect(setResponse.status).toBe(200);
    const setBody = await setResponse.json();
    expect(setBody).toMatchObject({
      changedItemIds: ["beta-skill"],
      operationId: "cap-plc-acceptance-1",
      view: {
        level: "conversation",
        conversationScope: "project",
        conversationId: PLC_CONVERSATION_ID,
      },
    });
    expect(setBody.view).not.toHaveProperty("sessionName");
    // Persistence landed on the PLC store ONLY (project untouched).
    expect(
      projectOverrides.cascades["claude-skills"]?.items,
    ).not.toHaveProperty("beta-skill");

    const afterSetView = resolvePlcView("claude-skills");
    const betaAfterSet = afterSetView.items.find(
      (row) => row.itemId === "beta-skill",
    );
    // The conversation override is the narrowest layer, so it wins.
    expect(betaAfterSet?.effectiveState).toEqual({
      enabled: false,
      originLayer: "conversation",
    });
    expect(betaAfterSet?.currentLayerValue).toEqual({
      enabled: false,
      originLayer: "conversation",
    });

    // Apply fanned out to the single PLC: idle Claude live-applies immediately.
    expect(applyClaudeRuntime).toHaveBeenCalledTimes(1);
    expect(claudeRuntimeWrites).toHaveLength(1);
    expect(claudeRuntimeWrites[0]).toMatchObject({
      conversationScope: "project",
      conversationId: PLC_CONVERSATION_ID,
    });
    expect(claudeRuntimeWrites[0]?.sessionName).toBeUndefined();

    // ===== Step 3 — Clear the override; fall back to inherited project (Req 17.3, 18.4). =====
    const clearResponse = await plcHandlers.PATCH(
      request(
        "PATCH",
        "http://cc.test/api/projects/repo/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "beta-skill" }],
        },
      ),
      plcRouteContext,
    );
    expect(clearResponse.status).toBe(200);

    const afterClearView = resolvePlcView("claude-skills");
    const betaAfterClear = afterClearView.items.find(
      (row) => row.itemId === "beta-skill",
    );
    // beta-skill has no project/global override, so clearing the conversation
    // override falls back to the native default — NOT a session layer.
    expect(betaAfterClear?.currentLayerValue).toBeUndefined();
    expect(betaAfterClear?.effectiveState).toEqual({
      enabled: true,
      originLayer: "native",
    });
    // alpha-skill still inherits the project disable through the PLC chain.
    const alphaAfterClear = afterClearView.items.find(
      (row) => row.itemId === "alpha-skill",
    );
    expect(alphaAfterClear?.effectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });

    // ===== Step 4 — Apply semantics parity (Req 19.1, 19.3, 19.4). =====
    // (a) Idle Claude PLC live-applies (already asserted via the set patch; here
    // we assert the per-conversation outcome carries the PLC identity with no
    // synthetic session identity and disposition "applied").
    applyClaudeRuntime.mockClear();
    claudeRuntimeWrites.length = 0;
    const claudeApplyResult = await claudeApplyService.applyAfterOverrideChange(
      {
        scope: {
          level: "conversation",
          projectPath: PLC_PROJECT_PATH,
          conversationScope: "project",
          conversationId: PLC_CONVERSATION_ID,
        },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha-skill"],
      },
    );
    expect(claudeApplyResult.conversations).toHaveLength(1);
    const claudeOutcome = claudeApplyResult.conversations[0]!;
    expect(claudeOutcome).toMatchObject({
      conversationScope: "project",
      conversationId: PLC_CONVERSATION_ID,
      backend: "claude",
    });
    expect(claudeOutcome.sessionName).toBeUndefined();
    expect(claudeOutcome.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "applied",
    });
    expect(applyClaudeRuntime).toHaveBeenCalledTimes(1);

    // (b) A turn-active Claude PLC stages for idle rather than applying mid-turn
    // — matching session-conversation user-visible semantics.
    const claudeTurnActivePort = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const claudeBusyApplyService = createCapabilityRuntimeApplyService({
      listAffectedConversations: async () => [
        { ...affectedPlc, isTurnActive: true },
      ],
      isTurnActive: () => true,
      composeForConversation: async () =>
        composeConversationStartRuntime({
          backend: "claude",
          scope: {
            level: "conversation",
            projectName: PLC_PROJECT_NAME,
            conversationScope: "project",
            conversationId: PLC_CONVERSATION_ID,
          },
          overrideChain: plcOverrideChain(),
          discoveryByCascade: { "claude-skills": { items: claudeSkills } },
        }),
      readRuntimeState: async () => undefined,
      writeRuntimeState: async (input) => {
        claudeRuntimeWrites.push({
          conversationScope: input.conversationScope,
          conversationId: input.conversationId,
          sessionName: "sessionName" in input ? input.sessionName : undefined,
          state: input.state,
        });
      },
      applyClaudeRuntime: claudeTurnActivePort,
    });
    const busyResult = await claudeBusyApplyService.applyAfterOverrideChange({
      scope: {
        level: "conversation",
        projectPath: PLC_PROJECT_PATH,
        conversationScope: "project",
        conversationId: PLC_CONVERSATION_ID,
      },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha-skill"],
    });
    // Mid-turn change is NOT applied; it is staged for idle (no port call).
    expect(claudeTurnActivePort).not.toHaveBeenCalled();
    expect(busyResult.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "staged-idle",
    });

    // (c) Codex PLC stages for next turn rather than applying mid-turn.
    const codexApplyPort = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const codexPlc: AffectedConversation = {
      conversationScope: "project",
      projectPath: PLC_PROJECT_PATH,
      projectName: PLC_PROJECT_NAME,
      conversationId: "plc-codex",
      worktreePath: PLC_PROJECT_PATH,
      backend: "codex",
      isTurnActive: false,
    };
    const codexApplyService = createCapabilityRuntimeApplyService({
      listAffectedConversations: async () => [codexPlc],
      isTurnActive: () => false,
      composeForConversation: async () =>
        composeConversationStartRuntime({
          backend: "codex",
          scope: {
            level: "conversation",
            projectName: PLC_PROJECT_NAME,
            conversationScope: "project",
            conversationId: "plc-codex",
          },
          overrideChain: plcOverrideChain(),
          discoveryByCascade: { "codex-skills": { items: codexSkills } },
        }),
      readRuntimeState: async () => undefined,
      writeRuntimeState: async (input) => {
        codexRuntimeWrites.push({
          conversationScope: input.conversationScope,
          conversationId: input.conversationId,
          sessionName: "sessionName" in input ? input.sessionName : undefined,
          state: input.state,
        });
      },
      applyCodexRuntime: codexApplyPort,
    });
    const codexResult = await codexApplyService.applyAfterOverrideChange({
      scope: {
        level: "conversation",
        projectPath: PLC_PROJECT_PATH,
        conversationScope: "project",
        conversationId: "plc-codex",
      },
      cascadeKind: "codex-skills",
      changedItemIds: ["codex-skill"],
    });
    expect(codexResult.conversations[0]).toMatchObject({
      conversationScope: "project",
      conversationId: "plc-codex",
      backend: "codex",
    });
    expect(codexResult.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "codex-skills",
      disposition: "staged-next-turn",
    });
    expect(codexApplyPort).not.toHaveBeenCalled();
    expect(codexRuntimeWrites[0]).toMatchObject({
      conversationScope: "project",
      conversationId: "plc-codex",
    });
    expect(codexRuntimeWrites[0]?.sessionName).toBeUndefined();

    // ===== Step 5 — SSE / cross-client convergence + sentinel isolation (Req 15.x, 18, 20.2). =====
    // The set patch broadcast carries project-conversation identity, NO session
    // name, and the event/response serializations contain NO sentinel.
    expect(events).toHaveLength(2); // one for the set, one for the clear
    const updatedEvent = events[0]!;
    expect(updatedEvent).toMatchObject({
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: PLC_PROJECT_NAME,
      conversationScope: "project",
      conversationId: PLC_CONVERSATION_ID,
      cascadeKind: "claude-skills",
      changedItemIds: ["beta-skill"],
      operationId: "cap-plc-acceptance-1",
      invalidationHints: {
        conversationScope: "project",
        conversationId: PLC_CONVERSATION_ID,
      },
    });
    expect(updatedEvent).not.toHaveProperty("sessionName");
    expect(updatedEvent.invalidationHints).not.toHaveProperty("sessionName");

    // Two clients editing the same PLC cascade converge: re-resolving the view
    // after both edits yields a single deterministic effective hash and the
    // hash advertised by the latest event identifies the cascade to refresh.
    const convergedHash = resolvePlcView("claude-skills").effectiveHash;
    expect(events[1]?.effectiveHash).toBe(convergedHash);
    expect(events[1]?.invalidationHints.effectiveHash).toBe(convergedHash);

    // Sentinel isolation: the adapter-internal "__project__" sentinel must never
    // surface in any serialized SSE payload or PATCH response body.
    const serializedSurface = JSON.stringify({
      events,
      setBody,
      clearBody: await clearResponse
        .clone()
        .json()
        .catch(() => undefined),
    });
    expect(serializedSurface).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(serializedSurface).not.toContain("sessionName");

    // ===== Step 6 — Backend isolation + five-cascade boundary (Req 20.1, 20.3). =====
    // A Codex PLC composition omits Claude cascades, and a Claude PLC
    // composition omits Codex cascades — no cross-backend mirroring.
    const codexComposition = composeConversationStartRuntime({
      backend: "codex",
      scope: plcResolverScope(),
      overrideChain: plcOverrideChain(),
      discoveryByCascade: {
        "codex-skills": { items: codexSkills },
        "claude-skills": { items: claudeSkills },
      },
    });
    expect(codexComposition.views["codex-skills"]).toBeDefined();
    expect(codexComposition.views["claude-skills"]).toBeUndefined();
    expect(codexComposition.views["codex-skills"]?.conversationScope).toBe(
      "project",
    );
    expect(codexComposition.views["codex-skills"]?.sessionName).toBeUndefined();

    const claudeComposition = composeConversationStartRuntime({
      backend: "claude",
      scope: plcResolverScope(),
      overrideChain: plcOverrideChain(),
      discoveryByCascade: {
        "claude-skills": { items: claudeSkills },
        "codex-skills": { items: codexSkills },
      },
    });
    expect(claudeComposition.views["claude-skills"]).toBeDefined();
    expect(claudeComposition.views["codex-skills"]).toBeUndefined();
    expect(claudeComposition.views["claude-skills"]?.conversationScope).toBe(
      "project",
    );

    // The registry exposes EXACTLY the five cascade kinds and NO sixth
    // PLC-specific kind. PLC discrimination is conversationScope, not a cascade.
    expect([...AGENT_CAPABILITY_CASCADE_KINDS].sort()).toEqual(
      [
        "claude-agents",
        "claude-plugins",
        "claude-skills",
        "codex-plugins",
        "codex-skills",
      ].sort(),
    );
    for (const cascadeKind of AGENT_CAPABILITY_CASCADE_KINDS) {
      const metadata = defaultAgentCapabilityMetadataRegistry.get(cascadeKind);
      expect(metadata.cascadeKind).toBe(cascadeKind);
    }
    // Claude registry omits Codex cascades and vice versa (no cross-backend
    // mirroring at the metadata layer either).
    const claudeKinds = defaultAgentCapabilityMetadataRegistry
      .listForBackend("claude")
      .map((m) => m.cascadeKind);
    const codexKinds = defaultAgentCapabilityMetadataRegistry
      .listForBackend("codex")
      .map((m) => m.cascadeKind);
    expect(claudeKinds.sort()).toEqual(
      ["claude-agents", "claude-plugins", "claude-skills"].sort(),
    );
    expect(codexKinds.sort()).toEqual(["codex-plugins", "codex-skills"].sort());

    // Guard: nothing in this PLC flow ever routed through a session-keyed store
    // method (those throw), and no PLC write borrowed a session identity.
    expect(
      [...claudeRuntimeWrites, ...codexRuntimeWrites].every(
        (write) =>
          write.conversationScope === "project" &&
          write.sessionName === undefined,
      ),
    ).toBe(true);
  });
});
