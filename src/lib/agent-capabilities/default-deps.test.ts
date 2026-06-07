import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityDiagnostic,
  AgentCapabilityDiscoveredItem,
  AgentCapabilityOverrides,
  AgentCapabilityRuntimeApplicationState,
} from "./schemas";

import {
  createConversationStartCapabilityComposer,
  createProjectConversationCapabilityConfigComposer,
  mutationAffectsConversationRuntime,
} from "./default-deps";
import {
  composeConversationStartRuntime,
  type ComposeConversationStartInput,
  type ComposeConversationStartResult,
} from "./runtime-composer";

function overrides(items: Record<string, boolean>): AgentCapabilityOverrides {
  return overridesFor("claude-skills", items);
}

function overridesFor(
  cascadeKind: AgentCapabilityCascadeKind,
  items: Record<string, boolean>,
): AgentCapabilityOverrides {
  return {
    cascades: {
      [cascadeKind]: {
        items: Object.fromEntries(
          Object.entries(items).map(([itemId, enabled]) => [
            itemId,
            { enabled },
          ]),
        ),
      },
    },
  };
}

const NOW = "2026-06-07T12:00:00.000Z";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "plc-1",
    scope: "project",
    name: "Project chat",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  };
}

function codexSkill(itemId: string): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/repo/.codex/skills/${itemId}` },
    nativeDefault: { enabled: true },
    runtimeVisibility: "source-only",
  };
}

function emptyDiscovery<T extends AgentCapabilityCascadeKind>(cascadeKind: T) {
  return {
    cascadeKind,
    items: [] as AgentCapabilityDiscoveredItem[],
    diagnostics: [] as AgentCapabilityDiagnostic[],
    sourceSignature: `${cascadeKind}:empty`,
    refreshedAt: NOW,
  };
}

describe("agent-capabilities/default-deps fanout filtering", () => {
  it("excludes a conversation when narrower overrides mask every changed item", () => {
    expect(
      mutationAffectsConversationRuntime({
        scope: { level: "global" },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha"],
        overrideChain: {
          global: overrides({ alpha: false }),
          project: overrides({ alpha: true }),
        },
      }),
    ).toBe(false);
  });

  it("includes a conversation when any changed item can flow through the edited scope", () => {
    expect(
      mutationAffectsConversationRuntime({
        scope: { level: "global" },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha", "beta"],
        overrideChain: {
          global: overrides({ alpha: false, beta: false }),
          project: overrides({ alpha: true }),
        },
      }),
    ).toBe(true);
  });
});

describe("agent-capabilities/default-deps project conversation composition", () => {
  it("builds a PLC override chain from global, project, and project conversation records only", async () => {
    let captured: ComposeConversationStartInput | undefined;
    const composer = createConversationStartCapabilityComposer({
      readGlobalOverrides: async () =>
        overridesFor("codex-skills", { alpha: false }),
      readState: async () =>
        ({
          projects: {
            "/repo": {
              rootPath: "/repo",
              agentCapabilityOverrides: overridesFor("codex-skills", {
                alpha: false,
              }),
              sessions: {
                masked: {
                  sessionName: "masked",
                  worktreePath: "/repo/.worktrees/masked",
                  branchName: "masked",
                  createdAt: NOW,
                  lastActivityAt: NOW,
                  conversations: [],
                  agentCapabilityOverrides: overridesFor("codex-skills", {
                    alpha: false,
                  }),
                },
              },
            },
          },
          archivedProjects: [],
          pinnedProjects: [],
        }) as never,
      getProjectConversation: async () =>
        makeConversation({
          id: "plc-1",
          agentBackend: "codex",
          agentCapabilityOverrides: overridesFor("codex-skills", {
            alpha: true,
          }),
        }),
      discoverClaudeSkills: async () => emptyDiscovery("claude-skills"),
      discoverClaudePlugins: async () => ({
        ...emptyDiscovery("claude-plugins"),
        nativeRecords: [],
      }),
      discoverClaudeAgents: async () => emptyDiscovery("claude-agents"),
      discoverCodexSkillsCanonical: async (input) => {
        expect(input.worktreePath).toBe("/repo");
        return {
          ...emptyDiscovery("codex-skills"),
          items: [codexSkill("alpha")],
        };
      },
      discoverCodexPluginsCanonical: async () => ({
        ...emptyDiscovery("codex-plugins"),
        discoverySupport: "available",
      }),
      composeRuntime(input) {
        captured = input;
        return composeConversationStartRuntime(input);
      },
      homeDir: () => "/home/alex",
      getClaudeRuntimeProbe: () => undefined,
      logDiscoveryFailure: () => undefined,
    });

    const result = await composer({
      conversationScope: "project",
      projectPath: "/repo",
      projectName: "Repo",
      conversationId: "plc-1",
      worktreePath: "/repo",
      backend: "codex",
    });

    expect(captured?.overrideChain.map((entry) => entry.layer)).toEqual([
      "global",
      "project",
      "conversation",
    ]);
    expect(captured?.scope).toEqual({
      level: "conversation",
      projectName: "Repo",
      conversationScope: "project",
      conversationId: "plc-1",
    });
    expect(result.views["codex-skills"]?.items[0]?.effectiveState).toEqual({
      enabled: true,
      originLayer: "conversation",
    });
  });

  it("uses the stored PLC backend and repo root worktree for the public project-conversation helper", async () => {
    const calls: unknown[] = [];
    const runtimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "codex-skills": {
          pendingHash: "pending",
          pendingItemIds: ["alpha"],
          lastApplyStatus: "staged-next-turn",
        },
      },
    };
    const resultForCodex: ComposeConversationStartResult = {
      backend: "codex",
      codexRuntime: {
        config: { plugins: { "codex-owner": { enabled: false } } },
        applySemantics: "next-turn",
      },
      diagnostics: [],
      runtimeState,
      views: {},
      failedCascadeKinds: [],
    };
    const composer = createProjectConversationCapabilityConfigComposer({
      getProjectConversation: async () =>
        makeConversation({ id: "plc-1", agentBackend: "codex" }),
      getProjectDisplayName: () => "Repo",
      async composeForConversation(input) {
        calls.push(input);
        return resultForCodex;
      },
    });

    const inputWithIgnoredBackend = {
      projectPath: "/repo",
      conversationId: "plc-1",
      backend: "claude" as AgentBackendId,
    };
    const result = await composer(inputWithIgnoredBackend);

    expect(calls).toHaveLength(1);
    const call = calls[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      backend: "codex",
      conversationScope: "project",
      projectPath: "/repo",
      projectName: "Repo",
      conversationId: "plc-1",
      worktreePath: "/repo",
    });
    expect("sessionName" in call).toBe(false);
    expect(result).toEqual({
      backend: "codex",
      config: { config: resultForCodex.codexRuntime?.config },
      runtimeState,
    });
  });
});
