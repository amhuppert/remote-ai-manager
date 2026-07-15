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
  type ApplyConversationIdentity,
  type ApplyServiceDeps,
} from ".";
import type {
  ResolvedCapabilityCascade,
  RuntimeConfigApplyResult,
} from "@/lib/agent-backends/runtime-config";
import { computeCascadeRuntimeHash } from "../runtime-hashes";
import type { ComposeConversationStartResult } from "../runtime-composer";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

function allLoggedArgs(): string {
  return JSON.stringify([
    logger.debug.mock.calls,
    logger.info.mock.calls,
    logger.warn.mock.calls,
    logger.error.mock.calls,
  ]);
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
    capabilities: {
      backend: "claude",
      kinds: [
        {
          kind: "skills",
          items: [{ itemId: "alpha", enabled: false, originLayer: "global" }],
        },
      ],
    },
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
  applyRuntimeConfig?: (input: {
    conversation: ApplyConversationIdentity;
    resolved: ResolvedCapabilityCascade;
  }) => Promise<RuntimeConfigApplyResult>;
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
  applyRuntimeConfig: opts.applyRuntimeConfig,
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
        applyRuntimeConfig: vi.fn(
          async (): Promise<RuntimeConfigApplyResult> => ({
            status: "applied",
          }),
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
        applyRuntimeConfig: vi.fn(async () => {
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

  it("tags PLC apply plan and outcome logs with project conversation scope and id (Req 16.1, 16.3)", async () => {
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        affected: [projectConversation({ conversationId: "plc-1" })],
        applyRuntimeConfig: vi.fn(
          async (): Promise<RuntimeConfigApplyResult> => ({
            status: "applied",
          }),
        ),
      }),
    );

    await service.applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
      operationId: "cap-op-plc",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "apply.cascade_planned",
      expect.objectContaining({
        trigger: "after-mutation",
        cascadeKind: "claude-skills",
        conversationScope: "project",
        conversationId: "plc-1",
        backend: "claude",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "apply.cascade_outcome",
      expect.objectContaining({
        trigger: "after-mutation",
        cascadeKind: "claude-skills",
        conversationScope: "project",
        conversationId: "plc-1",
        disposition: "applied",
      }),
    );
  });

  it("tags PLC discovery-failure logs with project conversation scope (Req 16.1)", async () => {
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        affected: [projectConversation({ conversationId: "plc-1" })],
        composeForConversation: async () => ({
          backend: "claude",
          capabilities: { backend: "claude", kinds: [] },
          diagnostics: [],
          runtimeState: { cascades: {} },
          views: {},
          failedCascadeKinds: ["claude-skills"],
        }),
        applyRuntimeConfig: vi.fn(
          async (): Promise<RuntimeConfigApplyResult> => ({
            status: "applied",
          }),
        ),
      }),
    );

    await service.applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
      operationId: "cap-op-plc-disc",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "apply.discovery_failed",
      expect.objectContaining({
        cascadeKind: "claude-skills",
        conversationScope: "project",
        conversationId: "plc-1",
        backend: "claude",
      }),
    );
  });

  it("tags PLC compose-failure logs with project conversation scope (Req 16.1, 19.5)", async () => {
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        affected: [projectConversation({ conversationId: "plc-1" })],
        composeForConversation: async () => {
          throw new Error("compose blew up for the project conversation");
        },
      }),
    );

    await service.applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
      operationId: "cap-op-plc-compose",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "apply.compose_failed",
      expect.objectContaining({
        conversationScope: "project",
        conversationId: "plc-1",
        backend: "claude",
        trigger: "after-mutation",
      }),
    );
  });

  it("never leaks the PLC sentinel into any captured apply log argument (Req 3.2, 16.3, 20.2)", async () => {
    const service = createCapabilityRuntimeApplyService(
      buildDeps({
        affected: [projectConversation({ conversationId: "plc-1" })],
        applyRuntimeConfig: vi.fn(async () => {
          throw new Error("reload failed mid project conversation apply");
        }),
      }),
    );

    await service.applyAfterOverrideChange({
      scope: { level: "project", projectPath: "/repo" },
      cascadeKind: "claude-skills",
      changedItemIds: ["alpha"],
      operationId: "cap-op-plc-sentinel",
    });

    expect(allLoggedArgs()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(allLoggedArgs()).not.toContain("sessionName");
  });
});
