import { describe, expect, it, vi } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import type { AgentCapabilityMetadataRegistry } from "../metadata";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ApplyServiceDeps,
  type ClaudeApplyPortInput,
  type ClaudeApplyPortResult,
  type CodexApplyPortInput,
  type CodexApplyPortResult,
} from ".";
import type { ClaudeRuntimeCapabilityConfig } from "../claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "../codex-runtime-translator";
import type { ComposeConversationStartResult } from "../runtime-composer";
import { CLAUDE_AGENT_SUPPRESSION_STRATEGY } from "../claude-agent-suppression";
import { computeCascadeRuntimeHash } from "../runtime-hashes";

const claudeConversation = (
  overrides: Partial<AffectedConversation> = {},
): AffectedConversation => ({
  projectPath: "/repo",
  projectName: "repo",
  sessionName: "session-a",
  conversationId: "conv-1",
  worktreePath: "/repo/.worktrees/session-a",
  backend: "claude",
  isTurnActive: false,
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
  isTurnActive: false,
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
    isTurnActive: false,
    ...overrides,
  }) as AffectedConversation;

const defaultClaudeRuntime = (): ClaudeRuntimeCapabilityConfig => ({
  enabledPlugins: {},
  skillOverrides: { alpha: "off" },
  disabledAgentNames: [],
  agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
});

const buildClaudeComposition = (input: {
  cascades: Partial<
    Record<
      AgentCapabilityCascadeKind,
      { rows: readonly { itemId: string; enabled: boolean }[] }
    >
  >;
  claudeRuntime?: ClaudeRuntimeCapabilityConfig;
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
    claudeRuntime: input.claudeRuntime ?? defaultClaudeRuntime(),
    diagnostics: [],
    runtimeState: { cascades },
    views: {},
    failedCascadeKinds: input.failedCascadeKinds ?? [],
  };
};

const buildCodexComposition = (input: {
  cascades: Partial<
    Record<
      AgentCapabilityCascadeKind,
      { rows: readonly { itemId: string; enabled: boolean }[] }
    >
  >;
  codexConfig?: CodexRuntimeCapabilityConfig["config"];
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
    codexRuntime: {
      config:
        input.codexConfig ?? ({} as CodexRuntimeCapabilityConfig["config"]),
      applySemantics: "next-turn",
    },
    diagnostics: [],
    runtimeState: { cascades },
    views: {},
    failedCascadeKinds: input.failedCascadeKinds ?? [],
  };
};

interface FakeDepsOptions {
  metadataRegistry?: AgentCapabilityMetadataRegistry;
  affected?: readonly AffectedConversation[];
  isTurnActive?: (input: {
    conversationScope?: "session" | "project";
    projectPath: string;
    sessionName?: string;
    conversationId: string;
  }) => boolean;
  composeForConversation?: (input: {
    conversationScope?: "session" | "project";
    backend: AgentBackendId;
    conversationId: string;
    sessionName?: string;
  }) => Promise<ComposeConversationStartResult>;
  readRuntimeState?: () => Promise<
    AgentCapabilityRuntimeApplicationState | undefined
  >;
  applyClaudeRuntime?: (
    input: ClaudeApplyPortInput,
  ) => Promise<ClaudeApplyPortResult>;
  applyCodexRuntime?: (
    input: CodexApplyPortInput,
  ) => Promise<CodexApplyPortResult>;
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
  turnActiveCalls: unknown[];
}

const buildDeps = (opts: FakeDepsOptions = {}): FakeDepsHandles => {
  const writes: FakeDepsHandles["writes"] = [];
  const composeCalls: unknown[] = [];
  const readCalls: unknown[] = [];
  const writeCalls: unknown[] = [];
  const turnActiveCalls: unknown[] = [];
  return {
    deps: {
      listAffectedConversations: vi.fn(async () => opts.affected ?? []),
      isTurnActive(input) {
        turnActiveCalls.push(input);
        return opts.isTurnActive?.(input) ?? false;
      },
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
        return opts.readRuntimeState?.() ?? undefined;
      }),
      writeRuntimeState: vi.fn(async (input) => {
        writeCalls.push(input);
        writes.push({
          conversationScope: input.conversationScope,
          conversationId: input.conversationId,
          sessionName: input.sessionName,
          state: input.state,
        });
      }),
      applyClaudeRuntime: opts.applyClaudeRuntime,
      applyCodexRuntime: opts.applyCodexRuntime,
      metadataRegistry: opts.metadataRegistry,
    },
    writes,
    composeCalls,
    readCalls,
    writeCalls,
    turnActiveCalls,
  };
};

describe("apply-after-mutation", () => {
  it("fans out to every affected conversation", async () => {
    const a = claudeConversation({ conversationId: "conv-1" });
    const b = claudeConversation({
      conversationId: "conv-2",
      sessionName: "session-b",
    });
    const { deps, writes } = buildDeps({
      affected: [a, b],
      applyClaudeRuntime: vi.fn(
        async (): Promise<ClaudeApplyPortResult> => ({ status: "applied" }),
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
      applyClaudeRuntime: vi.fn(
        async (): Promise<ClaudeApplyPortResult> => ({ status: "applied" }),
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

  it("Claude live-applies when idle and records applied", async () => {
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      isTurnActive: () => false,
      applyClaudeRuntime: port,
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
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
    expect(port.mock.calls[0]?.[0].config.skillOverrides).toEqual({
      alpha: "off",
    });
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      appliedHash: expect.any(String),
      lastApplyStatus: "applied",
    });
  });

  it("Claude PLC live-applies when idle without synthetic session runtime state", async () => {
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const {
      deps,
      writes,
      composeCalls,
      readCalls,
      writeCalls,
      turnActiveCalls,
    } = buildDeps({
      affected: [projectConversation()],
      isTurnActive: () => false,
      applyClaudeRuntime: port,
    });

    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyAfterOverrideChange({
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
    for (const call of [
      composeCalls[0],
      readCalls[0],
      writeCalls[0],
      turnActiveCalls[0],
    ] as Record<string, unknown>[]) {
      expect(call).toMatchObject({
        conversationScope: "project",
        projectPath: "/repo",
        conversationId: "plc-1",
      });
      expect("sessionName" in call).toBe(false);
    }
    expect(writes[0]).toMatchObject({
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
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [
        projectConversation({ conversationId: "plc-1" }),
        claudeConversation({
          conversationId: "session-conv",
          sessionName: "session-a",
        }),
      ],
      isTurnActive: () => false,
      applyClaudeRuntime: port,
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

  it("Claude PLC with turn active records staged-idle", async () => {
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [projectConversation({ isTurnActive: true })],
      isTurnActive: () => true,
      applyClaudeRuntime: port,
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
      disposition: "staged-idle",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.conversationScope).toBe("project");
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      lastApplyStatus: "staged-idle",
      pendingItemIds: ["alpha"],
    });
  });

  it("Codex PLC stages cascade changes for next turn", async () => {
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [
        projectConversation({
          conversationId: "plc-codex",
          backend: "codex",
        }),
      ],
      applyCodexRuntime: port,
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
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      isTurnActive: () => false,
      applyClaudeRuntime: port,
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

  it("Claude with turn active records staged-idle without calling the port", async () => {
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [claudeConversation({ isTurnActive: true })],
      isTurnActive: () => true,
      applyClaudeRuntime: port,
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
      disposition: "staged-idle",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      lastApplyStatus: "staged-idle",
      pendingItemIds: ["alpha"],
    });
  });

  it("stages codex-plugins changes for next turn without calling the runtime port", async () => {
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [codexConversation()],
      applyCodexRuntime: port,
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
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      affected: [codexConversation()],
      applyCodexRuntime: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": {
              rows: [{ itemId: "spec-init", enabled: false }],
            },
          },
          codexConfig: {
            verifiedSkillConfig: { "spec-init": false },
          } as unknown as CodexRuntimeCapabilityConfig["config"],
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
      async (): Promise<ClaudeApplyPortResult> => ({
        status: "rejected",
        error: "sdk reload failed",
      }),
    );
    const { deps, writes } = buildDeps({
      affected: [claudeConversation()],
      applyClaudeRuntime: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: prevAppliedHash,
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
    const state = writes[0]?.state.cascades["claude-skills"];
    expect(state?.appliedHash).toBe(prevAppliedHash);
    expect(state?.lastApplyStatus).toBe("rejected");
    expect(state?.lastApplyError).toContain("sdk reload failed");
  });

  it("records a rejected disposition with retryable diagnostic when compose throws for the affected conversation", async () => {
    const good = claudeConversation({ conversationId: "good" });
    const bad = claudeConversation({ conversationId: "bad" });
    const port = vi.fn(
      async (): Promise<ClaudeApplyPortResult> => ({
        status: "applied",
      }),
    );
    const { deps, writes } = buildDeps({
      affected: [good, bad],
      applyClaudeRuntime: port,
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
    expect(goodOutcome?.cascades[0]?.disposition).toBe("applied");
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

  it("records staged-idle with a diagnostic when Claude port is unavailable", async () => {
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
      disposition: "staged-idle",
    });
    expect(result.conversations[0]?.diagnostics[0]).toMatchObject({
      cascadeKind: "claude-skills",
      code: "agent-capability-apply-failed",
    });
    expect(writes[0]?.state.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "staged-idle",
    );
  });
});

describe("apply-claude-idle-drain", () => {
  it("promotes staged-idle to applied on successful live-apply", async () => {
    const port = vi.fn(
      async (): Promise<ClaudeApplyPortResult> => ({
        status: "applied",
      }),
    );
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            pendingHash: composedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-idle",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyWhenConversationBecomesIdle({
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
      async (): Promise<ClaudeApplyPortResult> => ({
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
      applyClaudeRuntime: port,
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: prevApplied,
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-idle",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyWhenConversationBecomesIdle({
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
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
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
            lastApplyStatus: "staged-idle",
          },
        },
      }),
    });
    const result = await createCapabilityRuntimeApplyService(
      deps,
    ).applyWhenConversationBecomesIdle({
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

  it("is a no-op when no cascades are staged-idle", async () => {
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
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
    ).applyWhenConversationBecomesIdle({
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
            lastApplyStatus: "staged-idle",
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
    ).applyWhenConversationBecomesIdle({
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

  it("retries a previously-rejected pending hash on the next idle transition", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn(
      async (): Promise<ClaudeApplyPortResult> => ({
        status: "applied",
      }),
    );
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
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
    ).applyWhenConversationBecomesIdle({
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

  it("persists rejected pending state when idle-drain composition throws", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
      composeForConversation: async () => {
        throw new Error(
          "idle compose failed in /home/alex/projects/repo with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        );
      },
      readRuntimeState: async () => ({
        cascades: {
          "claude-skills": {
            appliedHash: "prev-applied",
            pendingHash: stagedHash,
            pendingItemIds: ["alpha"],
            lastApplyStatus: "staged-idle",
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
    ).applyWhenConversationBecomesIdle({
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
    const port = vi.fn<
      (input: ClaudeApplyPortInput) => Promise<ClaudeApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
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
    ).applyWhenConversationBecomesIdle({
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
  it("promotes seeded staged-next-turn to applied at first turn start", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
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
      disposition: "applied",
    });
    expect(writes[0]?.state.cascades["claude-skills"]).toMatchObject({
      appliedHash: composedHash,
      lastApplyStatus: "applied",
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
    const fakeConfig = {
      recordedKey: "value-1",
    } as unknown as CodexRuntimeCapabilityConfig["config"];
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      applyCodexRuntime: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
          codexConfig: fakeConfig,
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
      conversationId: "conv-c1",
      config: { config: fakeConfig },
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
      async (): Promise<CodexApplyPortResult> => ({
        status: "rejected",
        error: "codex runtime is closed",
      }),
    );
    const { deps, writes } = buildDeps({
      applyCodexRuntime: port,
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

  it("does not promote staged-idle (those wait for idle-drain)", async () => {
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
            lastApplyStatus: "staged-idle",
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
    const fakeConfig = {
      recordedKey: "value-retry",
    } as unknown as CodexRuntimeCapabilityConfig["config"];
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      applyCodexRuntime: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": { rows: [{ itemId: "spec-init", enabled: false }] },
          },
          codexConfig: fakeConfig,
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
      conversationId: "conv-c1",
      config: { config: fakeConfig },
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
    const port = vi.fn<
      (input: CodexApplyPortInput) => Promise<CodexApplyPortResult>
    >(async () => ({ status: "applied" }));
    const { deps, writes } = buildDeps({
      applyCodexRuntime: port,
      composeForConversation: async () =>
        buildCodexComposition({
          cascades: {
            "codex-skills": {
              rows: [{ itemId: "other-skill", enabled: false }],
            },
          },
          codexConfig: {
            recordedKey: "drifted",
          } as unknown as CodexRuntimeCapabilityConfig["config"],
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
      applyCodexRuntime: port,
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

  it("does not retry a rejected Claude pending hash at turn start (waits for idle-drain)", async () => {
    const composedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const port = vi.fn();
    const { deps, writes } = buildDeps({
      applyClaudeRuntime: port,
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
      disposition: "idempotent-no-op",
    });
    expect(port).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
