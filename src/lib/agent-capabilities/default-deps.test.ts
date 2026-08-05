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
  createAffectedConversationLister,
  createConversationStartCapabilityComposer,
  createProjectConversationCapabilityConfigComposer,
  createRuntimeStateAccessors,
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
    nameOrigin: "default",
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
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
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

interface FanoutSessionFixture {
  sessionName: string;
  worktreePath: string;
  agentCapabilityOverrides?: AgentCapabilityOverrides;
  conversations: ConversationState[];
}

/**
 * Builds the affected-conversation lister's focused project reads from a plain
 * project fixture, mirroring the production wiring
 * (`listProjectPaths` + per-project `getProjectSessions` +
 * `getProjectAgentCapabilityOverrides`) that replaced the whole-state read.
 */
function focusedProjectFanoutDeps(
  projects: Record<
    string,
    {
      agentCapabilityOverrides?: AgentCapabilityOverrides;
      sessions?: Record<string, FanoutSessionFixture>;
    }
  >,
) {
  return {
    listProjectPaths: async () => Object.keys(projects),
    getProjectSessions: async (projectPath: string) =>
      Object.values(projects[projectPath]?.sessions ?? {}),
    getProjectAgentCapabilityOverrides: async (projectPath: string) =>
      projects[projectPath]?.agentCapabilityOverrides,
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

  it("includes active PLCs affected by project-level override changes", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({
        "/repo": {
          sessions: {
            "session-a": {
              sessionName: "session-a",
              worktreePath: "/repo/.worktrees/session-a",
              conversations: [
                makeConversation({
                  id: "session-conv",
                  scope: "session",
                  agentBackend: "claude",
                }),
              ],
            },
          },
        },
      }),
      readGlobalOverrides: async () => undefined,
      listAllProjectConversations: async () => [
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-1",
            agentBackend: "claude",
          }),
        },
      ],
      getRuntime: (conversationId) =>
        ({
          "session-conv": { status: "alive", backend: "claude" },
          "plc-1": { status: "alive", backend: "claude" },
        })[conversationId] as
          | { status: "alive"; backend: "claude" }
          | undefined,
      getProjectDisplayName: () => "Repo",
    });

    const affected = await lister({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "session",
        sessionName: "session-a",
        conversationId: "session-conv",
        worktreePath: "/repo/.worktrees/session-a",
      }),
      expect.objectContaining({
        conversationScope: "project",
        conversationId: "plc-1",
        worktreePath: "/repo",
      }),
    ]);
    expect(
      "sessionName" in
        affected.find((conv) => conv.conversationId === "plc-1")!,
    ).toBe(false);
  });

  it("includes active PLCs affected by global override changes", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({ "/repo": { sessions: {} } }),
      readGlobalOverrides: async () => overrides({ alpha: false }),
      listAllProjectConversations: async () => [
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-1",
            agentBackend: "claude",
          }),
        },
      ],
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: () => "Repo",
    });

    const affected = await lister({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      }),
    ]);
  });

  it("enumerates an active PLC alongside a session conversation for a global override change (Req 15.3, 17.4)", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({
        "/repo": {
          sessions: {
            "session-a": {
              sessionName: "session-a",
              worktreePath: "/repo/.worktrees/session-a",
              conversations: [
                makeConversation({
                  id: "session-conv",
                  scope: "session",
                  agentBackend: "claude",
                }),
              ],
            },
          },
        },
      }),
      readGlobalOverrides: async () => overrides({ alpha: false }),
      listAllProjectConversations: async () => [
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-1",
            agentBackend: "claude",
          }),
        },
      ],
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: () => "Repo",
    });

    const affected = await lister({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    // Global fanout must reach both the session conversation and the PLC.
    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "session",
        sessionName: "session-a",
        conversationId: "session-conv",
      }),
      expect.objectContaining({
        conversationScope: "project",
        conversationId: "plc-1",
        worktreePath: "/repo",
      }),
    ]);
    // The PLC target carries no synthetic session identity.
    const plc = affected.find((conv) => conv.conversationId === "plc-1")!;
    expect("sessionName" in plc).toBe(false);
  });

  it("does not read PLC records for session-scoped override changes", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({
        "/repo": {
          sessions: {
            "session-a": {
              sessionName: "session-a",
              worktreePath: "/repo/.worktrees/session-a",
              conversations: [
                makeConversation({
                  id: "session-conv",
                  scope: "session",
                  agentBackend: "claude",
                }),
              ],
            },
          },
        },
      }),
      readGlobalOverrides: async () => undefined,
      listAllProjectConversations: async () => {
        throw new Error("session fanout must not read PLC records");
      },
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: () => "Repo",
    });

    const affected = await lister({
      scope: {
        level: "session",
        projectPath: "/repo",
        sessionName: "session-a",
      },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "session",
        sessionName: "session-a",
        conversationId: "session-conv",
      }),
    ]);
  });

  it("keeps global session fanout when PLC enumeration fails", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({
        "/repo": {
          sessions: {
            "session-a": {
              sessionName: "session-a",
              worktreePath: "/repo/.worktrees/session-a",
              conversations: [
                makeConversation({
                  id: "session-conv",
                  scope: "session",
                  agentBackend: "claude",
                }),
              ],
            },
          },
        },
      }),
      readGlobalOverrides: async () => undefined,
      listAllProjectConversations: async () => {
        throw new Error("project conversation repo unavailable");
      },
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: () => "Repo",
    });

    const affected = await lister({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "session",
        sessionName: "session-a",
        conversationId: "session-conv",
      }),
    ]);
  });

  it("isolates project-conversation override fanout to the selected active PLC", async () => {
    const lister = createAffectedConversationLister({
      ...focusedProjectFanoutDeps({
        "/repo": {
          sessions: {
            "session-a": {
              sessionName: "session-a",
              worktreePath: "/repo/.worktrees/session-a",
              conversations: [
                makeConversation({
                  id: "session-conv",
                  scope: "session",
                  agentBackend: "claude",
                }),
              ],
            },
          },
        },
        "/other": { sessions: {} },
      }),
      readGlobalOverrides: async () => undefined,
      listAllProjectConversations: async () => [
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-1",
            agentBackend: "claude",
            agentCapabilityOverrides: overrides({ alpha: false }),
          }),
        },
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-2",
            agentBackend: "claude",
            agentCapabilityOverrides: overrides({ alpha: false }),
          }),
        },
        {
          projectPath: "/other",
          conversation: makeConversation({
            id: "other-plc",
            agentBackend: "claude",
            agentCapabilityOverrides: overrides({ alpha: false }),
          }),
        },
      ],
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: (projectPath) =>
        projectPath === "/repo" ? "Repo" : "Other",
    });

    const affected = await lister({
      scope: {
        level: "conversation",
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(affected).toEqual([
      expect.objectContaining({
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      }),
    ]);
  });

  it("re-reads project overrides on every fanout so a later change is not masked by a stale rule", async () => {
    const repoProject: {
      agentCapabilityOverrides?: AgentCapabilityOverrides;
      sessions?: Record<string, FanoutSessionFixture>;
    } = {
      agentCapabilityOverrides: overrides({ alpha: true }),
      sessions: {},
    };
    const projects: Record<string, typeof repoProject> = {
      "/repo": repoProject,
    };

    let projectOverrideReads = 0;
    const lister = createAffectedConversationLister({
      listProjectPaths: async () => Object.keys(projects),
      getProjectSessions: async (projectPath: string) =>
        Object.values(projects[projectPath]?.sessions ?? {}),
      getProjectAgentCapabilityOverrides: async (projectPath: string) => {
        projectOverrideReads += 1;
        return projects[projectPath]?.agentCapabilityOverrides;
      },
      readGlobalOverrides: async () => overrides({ alpha: false }),
      listAllProjectConversations: async () => [
        {
          projectPath: "/repo",
          conversation: makeConversation({
            id: "plc-1",
            agentBackend: "claude",
          }),
        },
      ],
      getRuntime: () => ({ status: "alive", backend: "claude" }),
      getProjectDisplayName: () => "Repo",
    });

    // First fanout: the project's explicit `alpha` override masks the global change.
    const firstFanout = await lister({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(firstFanout).toEqual([]);

    // A later mutation removes the project's masking rule for `alpha`.
    repoProject.agentCapabilityOverrides = undefined;

    // Second fanout must reflect the new project rules: the global change now
    // reaches the PLC. A lister that memoized overrides across fanouts would
    // reuse the stale masking rule and wrongly exclude it.
    const secondFanout = await lister({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(secondFanout).toEqual([
      expect.objectContaining({
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      }),
    ]);

    // Dedup is per fanout (session + PLC fanout share one read each invocation),
    // so exactly one read per fanout — two across both, never one cached forever.
    expect(projectOverrideReads).toBe(2);
  });
});

describe("agent-capabilities/default-deps runtime state accessors", () => {
  it("reads and writes PLC runtime state on the project-conversation record", async () => {
    const writes: AgentCapabilityRuntimeApplicationState[] = [];
    const accessors = createRuntimeStateAccessors({
      getSession: async () => {
        throw new Error("session state must not be read for PLC runtime state");
      },
      mutateConversation: async () => {
        throw new Error(
          "session state must not be written for PLC runtime state",
        );
      },
      getProjectConversation: async () =>
        makeConversation({
          id: "plc-1",
          agentCapabilitiesRuntime: {
            cascades: {
              "claude-skills": {
                appliedHash: "applied",
                lastApplyStatus: "applied",
              },
            },
          },
        }),
      mutateProjectConversation: async (
        _projectPath,
        _conversationId,
        _label,
        mutate,
      ) => {
        const conversation = makeConversation({ id: "plc-1" });
        const result = await mutate(conversation);
        writes.push(conversation.agentCapabilitiesRuntime!);
        return result;
      },
    });

    await expect(
      accessors.readRuntimeState({
        conversationScope: "project",
        projectPath: "/repo",
        projectName: "Repo",
        conversationId: "plc-1",
        worktreePath: "/repo",
        backend: "claude",
      }),
    ).resolves.toEqual({
      cascades: {
        "claude-skills": {
          appliedHash: "applied",
          lastApplyStatus: "applied",
        },
      },
    });

    await accessors.writeRuntimeState({
      conversationScope: "project",
      projectPath: "/repo",
      projectName: "Repo",
      conversationId: "plc-1",
      worktreePath: "/repo",
      backend: "claude",
      state: {
        cascades: {
          "claude-skills": {
            pendingHash: "pending",
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-idle",
          },
        },
      },
    });

    expect(writes).toEqual([
      {
        cascades: {
          "claude-skills": {
            pendingHash: "pending",
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-idle",
          },
        },
      },
    ]);
  });
});

describe("agent-capabilities/default-deps project conversation composition", () => {
  it("builds a PLC override chain from global, project, and project conversation records only", async () => {
    let captured: ComposeConversationStartInput | undefined;
    const requestedCascades: AgentCapabilityCascadeKind[] = [];
    const composer = createConversationStartCapabilityComposer({
      readGlobalOverrides: async () =>
        overridesFor("codex-skills", { alpha: false }),
      getProjectAgentCapabilityOverrides: async () =>
        overridesFor("codex-skills", { alpha: false }),
      getSession: async () => {
        throw new Error(
          "project-conversation compose must not read session state",
        );
      },
      getProjectConversation: async () =>
        makeConversation({
          id: "plc-1",
          agentBackend: "codex",
          agentCapabilityOverrides: overridesFor("codex-skills", {
            alpha: true,
          }),
        }),
      getDiscoveryProvider: (cascadeKind) => {
        requestedCascades.push(cascadeKind);
        if (cascadeKind === "codex-skills") {
          return {
            discover: async (input) => {
              expect(input.worktreePath).toBe("/repo");
              return {
                ...emptyDiscovery("codex-skills"),
                items: [codexSkill("alpha")],
              };
            },
          };
        }
        return {
          discover: async () => emptyDiscovery(cascadeKind),
        };
      },
      composeRuntime(input) {
        captured = input;
        return composeConversationStartRuntime(input);
      },
      homeDir: () => "/home/alex",
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
    // Discovery selection walks the backend's descriptor-declared cascades
    // (plugin cascade first) — never a Claude-vs-Codex identity branch.
    expect(requestedCascades).toEqual(["codex-plugins", "codex-skills"]);
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
    const codexCapabilities = {
      backend: "codex" as const,
      kinds: [
        {
          kind: "plugins" as const,
          items: [
            {
              itemId: "codex-owner",
              enabled: false,
              originLayer: "global" as const,
            },
          ],
        },
      ],
    };
    const resultForCodex: ComposeConversationStartResult = {
      backend: "codex",
      capabilities: codexCapabilities,
      diagnostics: [
        {
          severity: "warning",
          code: "codex-skill-discovery-warning",
          message: "Codex skill discovery warning",
          cascadeKind: "codex-skills",
          backend: "codex",
        },
      ],
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
      capabilities: codexCapabilities,
      diagnostics: resultForCodex.diagnostics,
      runtimeState,
    });
  });

  it("returns diagnostics-only PLC composition results when Codex has no runtime emission", async () => {
    const diagnostics: AgentCapabilityDiagnostic[] = [
      {
        severity: "error",
        code: "codex-skill-discovery-failed",
        message: "Codex skill discovery failed",
        cascadeKind: "codex-skills",
        backend: "codex",
      },
    ];
    const resultForCodex: ComposeConversationStartResult = {
      backend: "codex",
      capabilities: { backend: "codex", kinds: [] },
      diagnostics,
      runtimeState: { cascades: {} },
      views: {},
      failedCascadeKinds: ["codex-skills"],
    };
    const composer = createProjectConversationCapabilityConfigComposer({
      getProjectConversation: async () =>
        makeConversation({ id: "plc-1", agentBackend: "codex" }),
      getProjectDisplayName: () => "Repo",
      async composeForConversation() {
        return resultForCodex;
      },
    });

    const result = await composer({
      projectPath: "/repo",
      conversationId: "plc-1",
    });

    expect(result).toEqual({
      kind: "diagnostics-only",
      backend: "codex",
      diagnostics,
    });
  });
});
