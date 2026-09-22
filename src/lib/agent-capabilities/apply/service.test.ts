import { describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createRuntimeStateAccessors } from "../default-deps";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import type { AgentCapabilityMetadataRegistry } from "../metadata";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ApplyConversationIdentity,
  type ApplyServiceDeps,
} from ".";
import type {
  ResolvedCapabilityCascade,
  ResolvedCapabilityKind,
  RuntimeConfigApplyResult,
} from "@/lib/agent-backends/runtime-config";
import { decodeCascadeKind } from "../schemas";
import type { ComposeConversationStartResult } from "../runtime-composer";
import { computeCascadeRuntimeHash } from "../runtime-hashes";

type ApplyRuntimeConfigInput = {
  conversation: ApplyConversationIdentity;
  resolved: ResolvedCapabilityCascade;
};
type ApplyRuntimeConfigPort = (
  input: ApplyRuntimeConfigInput,
) => Promise<RuntimeConfigApplyResult>;

type CascadeRows = Partial<
  Record<
    AgentCapabilityCascadeKind,
    { rows: readonly { itemId: string; enabled: boolean }[] }
  >
>;

function capabilitiesFromCascades(
  backend: AgentBackendId,
  cascades: CascadeRows,
): ResolvedCapabilityCascade {
  const kinds: ResolvedCapabilityKind[] = [];
  for (const [cascadeKind, val] of Object.entries(cascades) as [
    AgentCapabilityCascadeKind,
    { rows: readonly { itemId: string; enabled: boolean }[] } | undefined,
  ][]) {
    if (!val) continue;
    kinds.push({
      kind: decodeCascadeKind(cascadeKind).kind,
      items: val.rows.map((row) => ({
        itemId: row.itemId,
        enabled: row.enabled,
        originLayer: "global" as const,
      })),
    });
  }
  return { backend, kinds };
}

const claudeConversation = (
  overrides: Partial<AffectedConversation> = {},
): AffectedConversation => ({
  projectPath: "/repo",
  projectName: "repo",
  sessionName: "session-a",
  conversationId: "conv-1",
  worktreePath: "/repo/.worktrees/session-a",
  backend: "claude",

  ...overrides,
});

const codexConversation = (
  overrides: Partial<AffectedConversation> = {},
): AffectedConversation => ({
  projectPath: "/repo",
  projectName: "repo",
  sessionName: "session-c",
  conversationId: "conv-c1",
  worktreePath: "/repo/.worktrees/session-c",
  backend: "codex",

  ...overrides,
});

const projectConversation = (
  overrides: Partial<AffectedConversation> = {},
): AffectedConversation =>
  ({
    conversationScope: "project",
    projectPath: "/repo",
    projectName: "repo",
    conversationId: "plc-1",
    worktreePath: "/repo",
    backend: "claude",

    ...overrides,
  }) as AffectedConversation;

const buildClaudeComposition = (input: {
  cascades: CascadeRows;
  failedCascadeKinds?: readonly AgentCapabilityCascadeKind[];
}): ComposeConversationStartResult => {
  const cascades: AgentCapabilityRuntimeApplicationState["cascades"] = {};
  for (const [cascadeKind, val] of Object.entries(input.cascades) as [
    AgentCapabilityCascadeKind,
    { rows: readonly { itemId: string; enabled: boolean }[] } | undefined,
  ][]) {
    if (!val) continue;
    cascades[cascadeKind] = {
      pendingHash: computeCascadeRuntimeHash({
        cascadeKind,
        rows: val.rows,
      }),
      pendingItemIds: val.rows.map((r) => r.itemId),
      lastApplyStatus: "staged-next-turn",
    };
  }
  return {
    backend: "claude",
    capabilities: capabilitiesFromCascades("claude", input.cascades),
    diagnostics: [],
    runtimeState: { cascades },
    views: {},
    failedCascadeKinds: input.failedCascadeKinds ?? [],
  };
};

const buildCodexComposition = (input: {
  cascades: CascadeRows;
  failedCascadeKinds?: readonly AgentCapabilityCascadeKind[];
}): ComposeConversationStartResult => {
  const cascades: AgentCapabilityRuntimeApplicationState["cascades"] = {};
  for (const [cascadeKind, val] of Object.entries(input.cascades) as [
    AgentCapabilityCascadeKind,
    { rows: readonly { itemId: string; enabled: boolean }[] } | undefined,
  ][]) {
    if (!val) continue;
    cascades[cascadeKind] = {
      pendingHash: computeCascadeRuntimeHash({
        cascadeKind,
        rows: val.rows,
      }),
      pendingItemIds: val.rows.map((r) => r.itemId),
      lastApplyStatus: "staged-next-turn",
    };
  }
  return {
    backend: "codex",
    capabilities: capabilitiesFromCascades("codex", input.cascades),
    diagnostics: [],
    runtimeState: { cascades },
    views: {},
    failedCascadeKinds: input.failedCascadeKinds ?? [],
  };
};

interface FakeDepsOptions {
  metadataRegistry?: AgentCapabilityMetadataRegistry;
  affected?: readonly AffectedConversation[];
  composeForConversation?: (input: {
    conversationScope?: "session" | "project";
    backend: AgentBackendId;
    conversationId: string;
    sessionName?: string;
  }) => Promise<ComposeConversationStartResult>;
  readRuntimeState?: () => Promise<
    AgentCapabilityRuntimeApplicationState | undefined
  >;
  applyRuntimeConfig?: ApplyRuntimeConfigPort;
}

interface FakeDepsHandles {
  deps: ApplyServiceDeps;
  writes: {
    conversationScope?: "session" | "project";
    conversationId: string;
    sessionName?: string;
    state: AgentCapabilityRuntimeApplicationState;
  }[];
  composeCalls: unknown[];
  readCalls: unknown[];
  writeCalls: unknown[];
}

const buildDeps = (opts: FakeDepsOptions = {}): FakeDepsHandles => {
  const writes: FakeDepsHandles["writes"] = [];
  const states = new Map<string, AgentCapabilityRuntimeApplicationState>();
  const composeCalls: unknown[] = [];
  const readCalls: unknown[] = [];
  const writeCalls: unknown[] = [];
  return {
    deps: {
      listAffectedConversations: vi.fn(async () => opts.affected ?? []),
      async composeForConversation(input) {
        composeCalls.push(input);
        if (opts.composeForConversation) {
          return opts.composeForConversation(input);
        }
        return input.backend === "claude"
          ? buildClaudeComposition({
              cascades: {
                "claude-skills": {
                  rows: [{ itemId: "alpha", enabled: false }],
                },
              },
            })
          : buildCodexComposition({
              cascades: { "codex-skills": { rows: [] } },
            });
      },
      readRuntimeState: vi.fn(async (input) => {
        readCalls.push(input);
        return (
          states.get(input.conversationId) ??
          opts.readRuntimeState?.() ??
          undefined
        );
      }),
      updateRuntimeState: vi.fn(async (identity, updater) => {
        const input = {
          ...identity,
          state: updater(
            states.get(identity.conversationId) ??
              (await opts.readRuntimeState?.()),
          ),
        };
        writeCalls.push(input);
        states.set(input.conversationId, input.state);
        writes.push({
          conversationScope: input.conversationScope,
          conversationId: input.conversationId,
          sessionName:
            input.conversationScope === "project"
              ? undefined
              : input.sessionName,
          state: input.state,
        });
      }),
      applyRuntimeConfig: opts.applyRuntimeConfig,
      metadataRegistry: opts.metadataRegistry,
    },
    writes,
    composeCalls,
    readCalls,
    writeCalls,
  };
};

async function applyMutationAtNextTurn(
  deps: ApplyServiceDeps,
  input: Parameters<
    ReturnType<
      typeof createCapabilityRuntimeApplyService
    >["applyAfterOverrideChange"]
  >[0],
) {
  const service = createCapabilityRuntimeApplyService(deps);
  await service.applyAfterOverrideChange(input);
  const affected = await deps.listAffectedConversations(input);
  const conversations = [];
  for (const conversation of affected)
    conversations.push(await service.applyAtTurnStart(conversation));
  return { conversations };
}

describe("apply-after-mutation", () => {
  it("keeps a newer pending selection durably when an earlier turn-start delivery settles", async () => {
    const fixture = createPersistenceFixture();
    try {
      const identity: ApplyConversationIdentity = {
        conversationScope: "project",
        projectName: "repo",
        projectPath: "/repo",
        conversationId: "conv-1",
        worktreePath: "/repo",
        backend: "claude",
      };
      const firstRows = [{ itemId: "alpha", enabled: false }];
      const secondRows = [{ itemId: "alpha", enabled: true }];
      const firstHash = computeCascadeRuntimeHash({
        cascadeKind: "claude-skills",
        rows: firstRows,
      });
      const secondHash = computeCascadeRuntimeHash({
        cascadeKind: "claude-skills",
        rows: secondRows,
      });
      fixture.seedProject("/repo");
      await fixture.seedProjectConversation(
        "/repo",
        makeConversationState({
          id: identity.conversationId,
          scope: "project",
          agentCapabilitiesRuntime: {
            cascades: {
              "claude-skills": {
                pendingHash: firstHash,
                pendingItemIds: ["alpha"],
                lastApplyStatus: "staged-next-turn",
              },
              "claude-plugins": {
                appliedHash: "plugins-unchanged",
                lastApplyStatus: "applied",
              },
            },
          },
        }),
      );
      const accessors = createRuntimeStateAccessors(fixture.store);
      let rows = firstRows;
      let startApply: (() => void) | undefined;
      let finishApply: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        startApply = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finishApply = resolve;
      });
      const { deps } = buildDeps({
        affected: [identity],
        composeForConversation: async () =>
          buildClaudeComposition({ cascades: { "claude-skills": { rows } } }),
        applyRuntimeConfig: async () => {
          startApply?.();
          await gate;
          return { status: "applied" };
        },
      });
      // Save and workflow delivery have independent service instances over the same store.
      const turnService = createCapabilityRuntimeApplyService({
        ...deps,
        ...accessors,
      });
      const saveService = createCapabilityRuntimeApplyService({
        ...deps,
        ...accessors,
      });
      const earlier = turnService.applyAtTurnStart(identity);
      await started;
      rows = secondRows;
      await saveService.applyAfterOverrideChange({
        scope: { level: "global" },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha"],
      });
      finishApply?.();
      await earlier;
      const reloaded = await fixture
        .recreateStore()
        .getProjectConversation("/repo", identity.conversationId);
      expect(
        reloaded?.agentCapabilitiesRuntime?.cascades["claude-skills"],
      ).toMatchObject({
        appliedHash: firstHash,
        pendingHash: secondHash,
        lastApplyStatus: "staged-next-turn",
      });
      expect(
        reloaded?.agentCapabilitiesRuntime?.cascades["claude-plugins"],
      ).toEqual({
        appliedHash: "plugins-unchanged",
        lastApplyStatus: "applied",
      });
    } finally {
      fixture.close();
    }
  });

  it("saving preferences only stages the change even while the runtime is idle", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      applyRuntimeConfig: port,
    });
    await createCapabilityRuntimeApplyService(deps).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      lastApplyStatus: "staged-next-turn",
      pendingItemIds: ["alpha"],
    });
    expect(
      writes[0]?.state.cascades["claude-skills"]?.appliedHash,
    ).toBeUndefined();
  });

  it("fans out to every affected conversation", async () => {
    const a = claudeConversation({ conversationId: "conv-1" });
    const b = claudeConversation({
      conversationId: "conv-2",
      sessionName: "session-b",
    });
    const { deps, writes } = buildDeps({
      affected: [a, b],
      applyRuntimeConfig: vi.fn(
        async (): Promise<RuntimeConfigApplyResult> => ({ status: "applied" }),
      ),
    });
    const service = createCapabilityRuntimeApplyService(deps);
    const result = await service.applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations.map((c) => c.conversationId).sort()).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(writes).toHaveLength(2);
  });

  it("passes changed item ids to affected conversation enumeration", async () => {
    const { deps } = buildDeps({
      affected: [claudeConversation()],
      applyRuntimeConfig: vi.fn(
        async (): Promise<RuntimeConfigApplyResult> => ({ status: "applied" }),
      ),
    });
    await createCapabilityRuntimeApplyService(deps).applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha", "beta"],
    });
    expect(deps.listAffectedConversations).toHaveBeenCalledWith({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha", "beta"],
    });
  });

  it("Claude applies at turn start and records applied", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],

      applyRuntimeConfig: port,
    });
    const result = await applyMutationAtNextTurn(deps, {
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades).toEqual([
      expect.objectContaining({
        cascadeKind: "claude-skills",
        disposition: "applied",
      }),
    ]);
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0].resolved).toEqual({
      backend: "claude",
      kinds: [
        {
          kind: "skills",
          items: [{ itemId: "alpha", enabled: false, originLayer: "global" }],
        },
      ],
    });
    expect(writes.at(-1)?.state.cascades["claude-skills"]).toMatchObject({
      appliedHash: expect.any(String),
      lastApplyStatus: "applied",
    });
  });

  it("Claude PLC applies at turn start without synthetic session runtime state", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes, composeCalls, readCalls, writeCalls } = buildDeps({
      affected: [projectConversation()],

      applyRuntimeConfig: port,
    });

    const result = await applyMutationAtNextTurn(deps, {
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(result.conversations[0]).toMatchObject({
      conversationScope: "project",
      conversationId: "plc-1",
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "applied",
    });
    expect(port).toHaveBeenCalledTimes(1);
    for (const call of [composeCalls[0], readCalls[0], writeCalls[0]] as Record<
      string,
      unknown
    >[]) {
      expect(call).toMatchObject({
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      });
      expect("sessionName" in call).toBe(false);
    }
    expect(writes.at(-1)).toMatchObject({
      conversationScope: "project",
      conversationId: "plc-1",
      state: {
        cascades: {
          "claude-skills": expect.objectContaining({
            lastApplyStatus: "applied",
          }),
        },
      },
    });
  });

  it("routes each write to its own identity when a PLC and a session conversation are both affected (Req 17.4, 18.3)", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [
        projectConversation({ conversationId: "plc-1" }),
        claudeConversation({
          conversationId: "session-conv",
          sessionName: "session-a",
        }),
      ],

      applyRuntimeConfig: port,
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(result.conversations).toHaveLength(2);
    expect(writes).toHaveLength(2);

    const plcWrite = writes.find((w) => w.conversationId === "plc-1")!;
    const sessionWrite = writes.find(
      (w) => w.conversationId === "session-conv",
    )!;

    // The PLC write is keyed by its project-conversation identity and never
    // borrows the session conversation's session identity.
    expect(plcWrite.conversationScope).toBe("project");
    expect(plcWrite.sessionName).toBeUndefined();
    // The session conversation's write stays keyed to its own session, proving
    // the PLC apply did not redirect onto the session-conversation record.
    expect(sessionWrite.sessionName).toBe("session-a");
    expect(sessionWrite.conversationScope).not.toBe("project");

    const plcOutcome = result.conversations.find(
      (c) => c.conversationId === "plc-1",
    )!;
    expect(plcOutcome.conversationScope).toBe("project");
    expect(plcOutcome.sessionName).toBeUndefined();
  });

  it("Claude PLC with turn active records staged-next-turn", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [projectConversation()],

      applyRuntimeConfig: port,
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "staged-next-turn",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.conversationScope).toBe("project");
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      lastApplyStatus: "staged-next-turn",
      pendingItemIds: ["alpha"],
    });
  });

  it("Codex PLC stages cascade changes for next turn", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [
        projectConversation({
          conversationId: "plc-codex",
          backend: "codex",
        }),
      ],
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": {
              rows: [{ itemId: "spec-init", enabled: false }],
            },
          },
        }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "codex-skills",
      changedItemIds: ["spec-init"],
    });

    expect(result.conversations[0]).toMatchObject({
      conversationScope: "project",
      conversationId: "plc-codex",
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "codex-skills",
      disposition: "staged-next-turn",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.conversationScope).toBe("project");
    expect(writes[0]?.state.cascades["codex-skills"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
  });

  it("does not live-apply or write when the recomposed runtime hash is already applied", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],

      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: composedHash,
            lastApplyStatus: "applied",
          },
        },
      }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("Claude with turn active records staged-next-turn without calling the port", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],

      applyRuntimeConfig: port,
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "staged-next-turn",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      lastApplyStatus: "staged-next-turn",
      pendingItemIds: ["alpha"],
    });
  });

  it("stages codex-plugins changes for next turn without calling the runtime port", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [codexConversation()],
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-plugins": { rows: [{ itemId: "plugin:p", enabled: false }] },
          },
        }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "codex-plugins",
      changedItemIds: ["plugin:p"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "codex-plugins",
      disposition: "staged-next-turn",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.state.cascades["codex-plugins"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
  });

  it("stages Codex cascade changes for next turn without calling the runtime port during mutation fanout", async () => {
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [codexConversation()],
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": {
              rows: [{ itemId: "spec-init", enabled: false }],
            },
          },
        }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "codex-skills",
      changedItemIds: ["spec-init"],
    });

    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "codex-skills",
      disposition: "staged-next-turn",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.state.cascades["codex-skills"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
  });

  it("claude-agents defer to next conversation", async () => {
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-agents": {
              rows: [{ itemId: "doc-writer", enabled: false }],
            },
          },
        }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-agents",
      changedItemIds: ["doc-writer"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-agents",
      disposition: "deferred-next-conversation",
    });
    expect(writes[0]?.state.cascades["claude-agents"]?.lastApplyStatus).toBe(
      "deferred-next-conversation",
    );
  });

  it("preserves previous appliedHash when Claude apply is rejected", async () => {
    const prevAppliedHash = "prev-applied-hash";
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "rejected",
        error: "sdk reload failed",
      }),
    );
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: prevAppliedHash,
            lastApplyStatus: "applied",
          },
        },
      }),
    });
    const result = await applyMutationAtNextTurn(deps, {
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
    });
    expect(result.conversations[0]?.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "agent-capability-apply-failed",
      cascadeKind: "claude-skills",
    });
    const state = writes.at(-1)?.state.cascades["claude-skills"];
    expect(state?.appliedHash).toBe(prevAppliedHash);
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).toContain("sdk reload failed");
  });

  it("records a rejected disposition with retryable diagnostic when compose throws for the affected conversation", async () => {
    const good = claudeConversation({ conversationId: "good" });
    const bad = claudeConversation({ conversationId: "bad" });
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "applied",
      }),
    );
    const { deps, writes } = buildDeps({
      affected: [good, bad],
      applyRuntimeConfig: port,
      composeForConversation: async (input) => {
        if (input.conversationId === "bad") {
          throw new Error("compose blew up");
        }
        return buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
          },
        });
      },
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations).toHaveLength(2);
    const goodOutcome = result.conversations.find(
      (c) => c.conversationId === "good",
    );
    const badOutcome = result.conversations.find(
      (c) => c.conversationId === "bad",
    );
    expect(goodOutcome?.cascades[0]?.disposition).toBe("staged-next-turn");
    expect(badOutcome?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
    });
    expect(badOutcome?.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "agent-capability-apply-failed",
      cascadeKind: "claude-skills",
    });
    const badWrite = writes.find((w) => w.conversationId === "bad");
    expect(badWrite?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "rejected",
    );
    expect(badWrite?.state.cascades["claude-skills"]?.lastApplyError).toContain(
      "compose blew up",
    );
  });

  it("stores a sanitized retryable rejected state when post-mutation composition throws", async () => {
    const previousAppliedHash = "previous-live-hash";
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      composeForConversation: async () => {
        throw new Error(
          "compose failed in /home/alex/projects/repo with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        );
      },
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: previousAppliedHash,
            lastApplyStatus: "applied",
          },
        },
      }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    const state = writes[0]?.state.cascades["claude-skills"];
    expect(result.conversations[0]?.cascades[0]?.disposition).toBe("rejected");
    expect(state?.appliedHash).toBe(previousAppliedHash);
    expect(state?.pendingHash).toBe(previousAppliedHash);
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).toContain("~/projects/repo");
    expect(state?.lastApplyError).toContain("<redacted>");
    expect(state?.lastApplyError).not.toContain("/home/alex");
    expect(state?.lastApplyError).not.toContain(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    );
  });

  it("records a rejected disposition when target cascade discovery failed", async () => {
    const previousAppliedHash = "previous-live-hash";
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {},
          failedCascadeKinds: ["claude-skills"],
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: previousAppliedHash,
            lastApplyStatus: "applied",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
    });
    expect(result.conversations[0]?.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "agent-capability-apply-failed",
      cascadeKind: "claude-skills",
    });
    expect(writes[0]?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "rejected",
    );
    expect(writes[0]?.state.cascades["claude-skills"]?.appliedHash).toBe(
      previousAppliedHash,
    );
    expect(writes[0]?.state.cascades["claude-skills"]?.pendingHash).toBe(
      previousAppliedHash,
    );
    expect(
      writes[0]?.state.cascades["claude-skills"]?.lastApplyError,
    ).toContain("discovery failed");
  });

  it("records a rejected disposition when the mutated target cascade is missing after composition", async () => {
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {},
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "prev-applied",
            lastApplyStatus: "applied",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
      attemptedHash: "prev-applied",
    });
    expect(result.conversations[0]?.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "agent-capability-apply-failed",
      cascadeKind: "claude-skills",
    });
    expect(writes[0]?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "rejected",
    );
    expect(
      writes[0]?.state.cascades["claude-skills"]?.lastApplyError,
    ).toContain("did not emit");
  });

  it("stages without an error when the runtime port is unavailable during save", async () => {
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "staged-next-turn",
    });
    expect(result.conversations[0]?.diagnostics).toEqual([]);
    expect(writes[0]?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
  });

  it("surfaces a retryable, sanitized apply-failure diagnostic on a PLC outcome tagged project scope (Req 19.3, 16.2, 9.5)", async () => {
    const previousAppliedHash = "previous-live-hash";
    const port = vi.fn(async () => {
      throw new Error(
        "reload failed in /home/alex/projects/repo with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      );
    });
    const { deps, writes } = buildDeps({
      affected: [projectConversation({ conversationId: "plc-1" })],
      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: previousAppliedHash,
            lastApplyStatus: "applied",
          },
        },
      }),
    });

    const result = await applyMutationAtNextTurn(deps, {
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });

    const plcOutcome = result.conversations[0];
    expect(plcOutcome?.conversationScope).toBe("project");
    expect(plcOutcome?.conversationId).toBe("plc-1");
    expect(plcOutcome).not.toHaveProperty("sessionName");
    expect(plcOutcome?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
    });
    const message = plcOutcome?.diagnostics[0]?.message ?? "";
    expect(message).toContain("<redacted>");
    expect(message).not.toContain("/home/alex");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");
    // Retryable: the previously-applied hash is preserved and re-staged so a
    // later turn-start can retry without losing operator intent.
    const state = writes.at(-1)?.state.cascades["claude-skills"];
    expect(state?.appliedHash).toBe(previousAppliedHash);
    expect(state?.pendingHash).toBeDefined();
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).not.toContain("/home/alex");
  });

  it("falls back for only the failed cascade on a PLC and does not block the healthy cascade (Req 19.5, 8.3)", async () => {
    const composedPluginHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-plugins",
      rows: [{ itemId: "plugin:p", enabled: false }],
    });
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      affected: [projectConversation({ conversationId: "plc-1" })],
      applyRuntimeConfig: port,
      // claude-skills discovery failed for this composition; claude-plugins
      // composed cleanly. Only the failed cascade should fall back.
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-plugins": {
              rows: [{ itemId: "plugin:p", enabled: false }],
            },
          },
          failedCascadeKinds: ["claude-skills"],
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "skills-applied",
            lastApplyStatus: "applied",
          },
          "claude-plugins": {
            pendingHash: composedPluginHash,
            pendingItemIds: ["plugin:p"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });

    const plcIdentity: ApplyConversationIdentity = {
      conversationScope: "project",
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      worktreePath: "/repo",
      backend: "claude",
    };
    const result =
      await createCapabilityRuntimeApplyService(deps).applyAtTurnStart(
        plcIdentity,
      );

    expect(result.conversationScope).toBe("project");
    expect(result).not.toHaveProperty("sessionName");

    const skillsCascade = result.cascades.find(
      (c) => c.cascadeKind === "claude-skills",
    );
    const pluginsCascade = result.cascades.find(
      (c) => c.cascadeKind === "claude-plugins",
    );
    // The failed cascade is rejected and surfaces a user-visible diagnostic.
    expect(skillsCascade?.disposition).toBe("rejected");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "agent-capability-apply-failed",
        cascadeKind: "claude-skills",
      }),
    );
    // The healthy cascade is NOT blocked by the failed one: it still applies.
    expect(pluginsCascade?.disposition).toBe("applied");
    expect(port).toHaveBeenCalledTimes(1);
    expect(writes[0]?.state.cascades["claude-plugins"]?.lastApplyStatus).toBe(
      "applied",
    );
    expect(writes[0]?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "rejected",
    );
  });
});

describe("apply-claude-turn-start", () => {
  it("promotes staged-next-turn to applied on successful delivery", async () => {
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "applied",
      }),
    );
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades).toEqual([
      expect.objectContaining({
        cascadeKind: "claude-skills",
        disposition: "applied",
      }),
    ]);
    expect(port).toHaveBeenCalledTimes(1);
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      appliedHash: composedHash,
      lastApplyStatus: "applied",
    });
  });

  it("keeps pending hash + items on failure and retains previous applied hash", async () => {
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "rejected",
        error: "boom",
      }),
    );
    const prevApplied = "prev";
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: prevApplied,
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "rejected",
    });
    const state = writes[0]?.state.cascades["claude-skills"];
    expect(state?.appliedHash).toBe(prevApplied);
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.pendingItemIds).toEqual(["alpha"]);
  });

  it("preserves the staged record without calling the port when composed hash drifts from pendingHash", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const driftedComposedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "beta", enabled: false }],
    });
    expect(stagedHash).not.toEqual(driftedComposedHash);
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "beta", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("is a no-op when no cascades are staged-next-turn", async () => {
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "h",
            lastApplyStatus: "applied",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("removes an obsolete pending cascade record instead of persisting an undefined entry", async () => {
    const { deps, writes } = buildDeps({
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {},
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: "obsolete",
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
          "claude-plugins": {
            appliedHash: "still-applied",
            lastApplyStatus: "applied",
          },
        },
      }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });

    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(Object.hasOwn(writes[0]!.state.cascades, "claude-skills")).toBe(
      false,
    );
    expect(writes[0]!.state.cascades["claude-plugins"]).toMatchObject({
      appliedHash: "still-applied",
    });
  });

  it("retries a previously-rejected pending hash on the next turn start", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "applied",
      }),
    );
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "prev-applied",
            pendingHash: composedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "rejected",
            lastApplyError: "earlier transient failure",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "applied",
    });
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      appliedHash: composedHash,
      lastApplyStatus: "applied",
    });
  });

  it("persists rejected pending state when turn-start composition throws", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () => {
        throw new Error(
          "turn-start compose failed in /home/alex/projects/repo with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        );
      },
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "prev-applied",
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
          "claude-plugins": {
            appliedHash: "plugin-applied",
            lastApplyStatus: "applied",
          },
        },
      }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });

    expect(port).not.toHaveBeenCalled();
    expect(result.cascades).toEqual([
      expect.objectContaining({
        cascadeKind: "claude-skills",
        disposition: "rejected",
        attemptedHash: stagedHash,
      }),
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "agent-capability-apply-failed",
        cascadeKind: "claude-skills",
      }),
    );
    const state = writes[0]?.state.cascades["claude-skills"];
    expect(state?.appliedHash).toBe("prev-applied");
    expect(state?.pendingHash).toBe(stagedHash);
    expect(state?.pendingItemIds).toEqual(["alpha"]);
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).toContain("~/projects/repo");
    expect(state?.lastApplyError).toContain("<redacted>");
    expect(state?.lastApplyError).not.toContain("/home/alex");
    expect(writes[0]?.state.cascades["claude-plugins"]).toMatchObject({
      appliedHash: "plugin-applied",
    });
  });

  it("preserves a rejected record without calling the port when composed hash drifts from pendingHash", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const driftedComposedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "beta", enabled: false }],
    });
    expect(stagedHash).not.toEqual(driftedComposedHash);
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "beta", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "rejected",
            lastApplyError: "earlier transient failure",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("apply-at-turn-start", () => {
  it("requires acceptance before promoting creation input at turn start", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: async () => ({
        status: "deferred",
        reason: "next_turn",
      }),
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "claude-skills"),
    ).toMatchObject({
      disposition: "staged-next-turn",
    });
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      pendingHash: composedHash,
      lastApplyStatus: "staged-next-turn",
    });
  });

  it("preserves deferred-next-conversation at turn boundary", async () => {
    const { deps, writes } = buildDeps({
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-agents": {
              rows: [{ itemId: "doc-writer", enabled: false }],
            },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-agents": {
            pendingHash: "h",
            pendingItemIds: ["doc-writer"],
            lastApplyStatus: "deferred-next-conversation",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "claude-agents"),
    ).toMatchObject({
      disposition: "deferred-next-conversation",
    });
    expect(writes).toHaveLength(0);
  });

  it("Codex turn-start pushes recomposed config to the live runtime before promoting to applied", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0]).toEqual({
      conversation: expect.objectContaining({ conversationId: "conv-c1" }),
      resolved: {
        backend: "codex",
        kinds: [
          {
            kind: "skills",
            items: [
              { itemId: "spec-init", enabled: false, originLayer: "global" },
            ],
          },
        ],
      },
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "codex-skills"),
    ).toMatchObject({
      disposition: "applied",
    });
    expect(writes[0]?.state.cascades["codex-skills"]).toMatchObject({
      appliedHash: composedHash,
      lastApplyStatus: "applied",
    });
  });

  it("Codex turn-start records rejected when runtime delivery fails", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const port = vi.fn(
      async (): Promise<RuntimeConfigApplyResult> => ({
        status: "rejected",
        error: "codex runtime is closed",
      }),
    );
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(
      result.cascades.find((c) => c.cascadeKind === "codex-skills"),
    ).toMatchObject({
      disposition: "rejected",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "agent-capability-apply-failed",
        backend: "codex",
        cascadeKind: "codex-skills",
      }),
    );
    const state = writes[0]?.state.cascades["codex-skills"];
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).toContain("codex runtime is closed");
  });

  it("Codex turn-start records rejected when runtime port is unavailable", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const { deps, writes } = buildDeps({
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "codex-skills"),
    ).toMatchObject({
      disposition: "rejected",
    });
    expect(writes[0]?.state.cascades["codex-skills"]?.lastApplyStatus).toBe(
      "rejected",
    );
  });

  it("does not promote staged-next-turn (those wait for turn-start)", async () => {
    const { deps, writes } = buildDeps({
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: "h",
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "idempotent-no-op",
    });
    expect(writes).toHaveLength(0);
  });

  it("retries a previously-rejected Codex pending hash on the next turn start", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            appliedHash: "prev-applied",
            pendingHash: composedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "rejected",
            lastApplyError: "earlier transient delivery failure",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0]).toEqual({
      conversation: expect.objectContaining({ conversationId: "conv-c1" }),
      resolved: {
        backend: "codex",
        kinds: [
          {
            kind: "skills",
            items: [
              { itemId: "spec-init", enabled: false, originLayer: "global" },
            ],
          },
        ],
      },
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "codex-skills"),
    ).toMatchObject({
      disposition: "applied",
    });
    expect(writes[0]?.state.cascades["codex-skills"]).toMatchObject({
      appliedHash: composedHash,
      lastApplyStatus: "applied",
    });
  });

  it("preserves staged Codex work without runtime delivery when the turn-start hash drifted", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const driftedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "other-skill", enabled: false }],
    });
    expect(stagedHash).not.toBe(driftedHash);
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": {
              rows: [{ itemId: "other-skill", enabled: false }],
            },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            pendingHash: stagedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });
    expect(
      result.cascades.find((c) => c.cascadeKind === "codex-skills"),
    ).toMatchObject({
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("persists rejected pending state when turn-start composition throws", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "spec-init", enabled: false }],
    });
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () => {
        throw new Error("turn-start composition crashed");
      },
      readRuntimeState: async () => ({
        cascades: {
          "codex-skills": {
            appliedHash: "prev-applied",
            pendingHash: stagedHash,
            pendingItemIds: ["spec-init"],
            lastApplyStatus: "staged-next-turn",
          },
          "codex-plugins": {
            pendingHash: "unsupported-pending",
            pendingItemIds: ["plugin-a"],
            lastApplyStatus: "staged-next-turn",
          },
        },
      }),
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-c",
      conversationId: "conv-c1",
      worktreePath: "/repo/.worktrees/session-c",
      backend: "codex",
    });

    expect(port).not.toHaveBeenCalled();
    expect(result.cascades).toEqual([
      expect.objectContaining({
        cascadeKind: "codex-skills",
        disposition: "rejected",
        attemptedHash: stagedHash,
      }),
      expect.objectContaining({
        cascadeKind: "codex-plugins",
        disposition: "rejected",
      }),
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "agent-capability-apply-failed",
        cascadeKind: "codex-skills",
      }),
    );
    expect(writes[0]?.state.cascades["codex-skills"]).toMatchObject({
      appliedHash: "prev-applied",
      pendingHash: stagedHash,
      pendingItemIds: ["spec-init"],
      lastApplyStatus: "rejected",
      lastApplyError: "turn-start composition crashed",
    });
    expect(writes[0]?.state.cascades["codex-plugins"]).toMatchObject({
      lastApplyStatus: "rejected",
      lastApplyError: "turn-start composition crashed",
    });
  });

  it("retries a rejected Claude pending hash at turn start", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps, writes } = buildDeps({
      applyRuntimeConfig: port,
      composeForConversation: async () =>
        buildClaudeComposition({
          cascades: {
            "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
          },
        }),
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "prev-applied",
            pendingHash: composedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "rejected",
            lastApplyError: "earlier transient failure",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAtTurnStart({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });
    expect(result.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "applied",
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });
});

describe("runtime-config apply seam", () => {
  it("records staged-next-turn when the adapter declares deferred/turn_active mid-race", async () => {
    // The pre-check said idle, but a turn started before the adapter ran; the
    // declared result must land exactly where skipped-turn-active used to.
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "deferred",
      reason: "turn_active",
    }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],

      applyRuntimeConfig: port,
    });
    const result = await applyMutationAtNextTurn(deps, {
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(result.conversations[0]?.cascades[0]).toMatchObject({
      cascadeKind: "claude-skills",
      disposition: "staged-next-turn",
    });
    expect(
      writes.at(-1)?.state.cascades["claude-skills"]?.lastApplyStatus,
    ).toBe("staged-next-turn");
  });

  it("re-applies exactly once when a persisted appliedHash predates the neutral hash basis, then no-ops", async () => {
    // Simulates the upgrade path: the conversation's appliedHash was computed
    // from translator emissions; the neutral basis produces a different hash,
    // so the first post-upgrade mutation re-applies, after which repeats are
    // idempotent.
    const legacyEmissionsHash = "legacy-emissions-basis-hash";
    const neutralHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    expect(neutralHash).not.toBe(legacyEmissionsHash);

    let persisted: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "claude-skills": {
          appliedHash: legacyEmissionsHash,
          lastApplyStatus: "applied",
        },
      },
    };
    const port = vi.fn<ApplyRuntimeConfigPort>(async () => ({
      status: "applied",
    }));
    const { deps } = buildDeps({
      affected: [claudeConversation()],
      applyRuntimeConfig: port,
      readRuntimeState: async () => persisted,
    });
    deps.updateRuntimeState = async (_identity, updater) => {
      persisted = updater(persisted);
    };
    const service = createCapabilityRuntimeApplyService(deps);

    const first = await service.applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(first.conversations[0]?.cascades[0]).toMatchObject({
      disposition: "staged-next-turn",
      attemptedHash: neutralHash,
    });
    await service.applyAtTurnStart(claudeConversation());
    expect(port).toHaveBeenCalledTimes(1);
    expect(persisted.cascades["claude-skills"]?.appliedHash).toBe(neutralHash);

    const second = await service.applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
    });
    expect(second.conversations[0]?.cascades[0]).toMatchObject({
      disposition: "idempotent-no-op",
    });
    expect(port).toHaveBeenCalledTimes(1);
  });
});
