import { describe, expect, it, vi, beforeEach } from "vitest";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityRuntimeApplicationState,
} from "../schemas";

import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ApplyServiceDeps,
  type ClaudeApplyPortInput,
  type ClaudeApplyPortResult,
} from ".";
import type { ClaudeRuntimeCapabilityConfig } from "../claude-runtime-translator";
import { CLAUDE_AGENT_SUPPRESSION_STRATEGY } from "../claude-agent-suppression";
import { computeCascadeRuntimeHash } from "../runtime-hashes";
import type { ComposeConversationStartResult } from "../runtime-composer";

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

const claudeRuntime = (): ClaudeRuntimeCapabilityConfig => ({
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
}): ComposeConversationStartResult => {
  const cascades: AgentCapabilityRuntimeApplicationState["cascades"] = {};
  for (const [cascadeKind, val] of Object.entries(input.cascades) as [
    AgentCapabilityCascadeKind,
    { rows: readonly { itemId: string; enabled: boolean }[] } | undefined,
  ][]) {
    if (!val) continue;
    cascades[cascadeKind] = {
      pendingHash: computeCascadeRuntimeHash({ cascadeKind, rows: val.rows }),
      pendingItemIds: val.rows.map((r) => r.itemId),
      lastApplyStatus: "staged-next-turn",
    };
  }
  return {
    backend: "claude",
    claudeRuntime: claudeRuntime(),
    diagnostics: [],
    runtimeState: { cascades },
    views: {},
    failedCascadeKinds: [],
  };
};

const buildDeps = (opts: {
  affected?: readonly AffectedConversation[];
  composeForConversation?: (input: {
    backend: AgentBackendId;
    conversationId: string;
  }) => Promise<ComposeConversationStartResult>;
  readRuntimeState?: () => Promise<
    AgentCapabilityRuntimeApplicationState | undefined
  >;
  applyClaudeRuntime?: (
    input: ClaudeApplyPortInput,
  ) => Promise<ClaudeApplyPortResult>;
}): ApplyServiceDeps => ({
  listAffectedConversations: vi.fn(async () => opts.affected ?? []),
  isTurnActive: () => false,
  composeForConversation:
    opts.composeForConversation ??
    (async () =>
      buildClaudeComposition({
        cascades: {
          "claude-skills": { rows: [{ itemId: "alpha", enabled: false }] },
        },
      })),
  readRuntimeState: opts.readRuntimeState ?? (async () => undefined),
  writeRuntimeState: vi.fn(async () => undefined),
  applyClaudeRuntime: opts.applyClaudeRuntime,
});

describe("capability runtime apply logging", () => {
  beforeEach(() => {
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  it("emits structured planning, outcome, and retry recovery logs", async () => {
    const stagedHash = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        applyClaudeRuntime: vi.fn(
          async (): Promise<ClaudeApplyPortResult> => ({ status: "applied" }),
        ),
        readRuntimeState: async () => ({
          cascades: {
            "claude-skills": {
              appliedHash: "prev-applied",
              pendingHash: stagedHash,
              pendingItemIds: ["alpha"],
              lastApplyStatus: "rejected",
              lastApplyError: "earlier transient failure",
            },
          },
        }),
      }),
    );

    await service.applyWhenConversationBecomesIdle({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-a",
      conversationId: "conv-1",
      worktreePath: "/repo/.worktrees/session-a",
      backend: "claude",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "apply.cascade_planned",
      expect.objectContaining({
        trigger: "idle-drain",
        cascadeKind: "claude-skills",
        conversationId: "conv-1",
        previousStatus: "rejected",
        plannedDisposition: "try-live-apply",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "apply.retry_recovered",
      expect.objectContaining({
        trigger: "idle-drain",
        cascadeKind: "claude-skills",
        conversationId: "conv-1",
        attemptedHash: stagedHash,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "apply.cascade_outcome",
      expect.objectContaining({
        trigger: "idle-drain",
        cascadeKind: "claude-skills",
        disposition: "applied",
      }),
    );
  });

  it("sanitizes rejected apply errors in logs and returned diagnostics", async () => {
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        affected: [claudeConversation()],
        applyClaudeRuntime: vi.fn(async () => {
          throw new Error(
            "reload failed in /home/alex/projects/repo with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
          );
        }),
      }),
    );

    const result = await service.applyAfterOverrideChange({
      scope: { level: "global" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
      operationId: "cap-op-apply",
    });

    const message = result.conversations[0]?.diagnostics[0]?.message ?? "";
    expect(message).toContain("~/projects/repo");
    expect(message).toContain("<redacted>");
    expect(message).not.toContain("/home/alex");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");
    expect(logger.error).toHaveBeenCalledWith(
      "apply.failed",
      expect.objectContaining({
        error: expect.not.stringContaining("/home/alex"),
        operationId: "cap-op-apply",
      }),
    );
  });
});
