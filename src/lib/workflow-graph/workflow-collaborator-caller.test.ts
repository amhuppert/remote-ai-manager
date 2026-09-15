/**
 * Tests for the production `WorkflowCollaborationCollaboratorCaller` factory
 * created by `createWorkflowCollaboratorCaller`.
 *
 * The factory composes the canonical phase prompt builders, routes every call
 * through a `WorkflowAgentCaller` for lane bookkeeping, and parses the
 * structured outputs through the authoritative Zod schemas. These tests
 * exercise the caller through a DI'd fake `WorkflowAgentCaller` (no `vi.mock`
 * on internal modules) and verify behavior: which backend each phase calls,
 * that lane refs are stamped with the correct (workflowId, laneId=flow agent)
 * pair, that structured outputs are parsed, and that failures surface as
 * thrown errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { WorkflowAgentCaller } from "@/lib/workflows/primitives/workflow-agent-caller";
import type { WorkflowAgentCallerRequest } from "@/lib/workflows/primitives/workflow-agent-caller";
import { createWorkflowCollaboratorCaller } from "./workflow-collaborator-caller";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentCallResult,
  BackendCapabilityView,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationInitialDraftOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
  ResolvedCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeResolutionDecisionContinue,
} from "@/lib/workflows/collaboration/test-fixtures";

type GeneratedArtifactOutput =
  | CollaborationInitialDraftOutput
  | CollaborationCrossReviewOutput
  | CollaborationProposedChangesOutput
  | CollaborationCounterProposalOutput
  | CollaborationResolutionDecisionOutput
  | CollaborationFinalAnswerOutput;

let worktreePath: string;

beforeEach(async () => {
  worktreePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "collab-caller-test-"),
  );
});

afterEach(async () => {
  await fs.rm(worktreePath, { recursive: true, force: true });
});

function resolvedConfigFixture(
  backend: "claude" | "codex",
): ResolvedCollaborationConfig {
  return {
    enabled: { value: true, source: "global" },
    secondAgent: {
      value:
        backend === "codex"
          ? {
              backend: "codex",
              modelSelection: {
                modelId: "gpt-5.4",
                parameters: { reasoning: "medium", fast: "false" },
              },
            }
          : {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
      source: "global",
    },
    negotiationRounds: { value: 4, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  };
}

function agentOneDraftFixture(): CollaborationInitialDraftOutput {
  return makeAgentOneInitialDraft();
}

function agentTwoDraftFixture(): CollaborationInitialDraftOutput {
  return makeAgentTwoInitialDraft();
}

function crossReviewFixture(): CollaborationCrossReviewOutput {
  return makeAgentTwoCrossReview();
}

function proposedChangesFixture(): CollaborationProposedChangesOutput {
  return makeAgentOneProposedChanges();
}

function counterProposalFixture(
  overrides?: Partial<CollaborationCounterProposalOutput>,
): CollaborationCounterProposalOutput {
  return makeAgentTwoCounterProposalRound1(overrides);
}

function resolutionFixture(
  overrides?: Partial<CollaborationResolutionDecisionOutput>,
): CollaborationResolutionDecisionOutput {
  return makeResolutionDecisionContinue(overrides);
}

function capabilityFixture(backend: AgentBackendId): BackendCapabilityView {
  return {
    backend,
    continuationStrength: "synthetic_thread",
    structuredOutputEnforcement: "post_validation",
    mcpApplicationBoundary: "per_request",
    contextMetricsAvailable: true,
    nativeMidTurnAskUser: false,
  };
}

function completedResult(
  backend: AgentBackendId,
  structuredOutput: unknown,
): AgentCallResult {
  return {
    backend,
    backendRef: null,
    capabilities: capabilityFixture(backend),
    usage: {},
    artifacts: [],
    outcome: {
      kind: "completed",
      text: null,
      structuredOutput,
    },
  };
}

function rehomeGeneratedArtifactPaths<T>(value: T, workflowId: string): T {
  return JSON.parse(
    JSON.stringify(value).replaceAll(
      "memory-bank/collaboration/wf-fixture/",
      `memory-bank/collaboration/${workflowId}/`,
    ),
  ) as T;
}

function hasGeneratedArtifactFiles(
  value: unknown,
): value is GeneratedArtifactOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "artifacts" in value &&
    Array.isArray((value as { artifacts?: unknown }).artifacts)
  );
}

function materializeGeneratedFiles(structuredOutput: unknown): void {
  if (!hasGeneratedArtifactFiles(structuredOutput)) return;
  for (const ref of structuredOutput.artifacts) {
    const absolutePath = path.join(worktreePath, ref.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const content =
      structuredOutput.kind === "final_answer" &&
      ref.id === structuredOutput.answer_artifact_id
        ? structuredOutput.summary
        : `# ${ref.id}\n\n${structuredOutput.kind} ${ref.artifact_type}\n`;
    writeFileSync(absolutePath, content, "utf-8");
  }
}

function prepareResultForRequest(
  result: AgentCallResult,
  request: WorkflowAgentCallerRequest,
): AgentCallResult {
  if (result.outcome.kind !== "completed") return result;
  const structuredOutput = result.outcome.structuredOutput;
  if (!structuredOutput || typeof structuredOutput !== "object") return result;

  const rehomedOutput = rehomeGeneratedArtifactPaths(
    structuredOutput,
    request.laneRef.workflowId,
  );
  materializeGeneratedFiles(rehomedOutput);

  return {
    ...result,
    outcome: {
      ...result.outcome,
      structuredOutput: rehomedOutput,
    },
  };
}

function failedResult(
  backend: AgentBackendId,
  message: string,
): AgentCallResult {
  return {
    backend,
    backendRef: null,
    capabilities: capabilityFixture(backend),
    usage: {},
    artifacts: [],
    outcome: {
      kind: "failed",
      error: {
        failureKind: "backend_error",
        backend,
        message,
      },
    },
  };
}

function buildInMemoryDeps(
  callImpl: (req: WorkflowAgentCallerRequest) => Promise<AgentCallResult>,
) {
  const laneService = createLaneService({ store: createInMemoryLaneStore() });
  const call = vi.fn(async (req: WorkflowAgentCallerRequest) =>
    prepareResultForRequest(await callImpl(req), req),
  );
  const agentCaller: WorkflowAgentCaller = { call };
  return { laneService, agentCaller, call };
}

describe("createWorkflowCollaboratorCaller", () => {
  describe("runInitialDrafts", () => {
    it("invokes agent_one and agent_two on opposite backends in parallel and parses both drafts", async () => {
      const { laneService, agentCaller, call } = buildInMemoryDeps(
        async (req) => {
          if (req.agentCallRequest.kind !== "task_run") {
            throw new Error("expected task_run");
          }
          if (req.agentCallRequest.backend === "claude") {
            return completedResult("claude", agentOneDraftFixture());
          }
          return completedResult("codex", agentTwoDraftFixture());
        },
      );

      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "use Postgres?",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-collab-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      const out = await caller.runInitialDrafts({ brief: "use Postgres?" });

      expect(call).toHaveBeenCalledTimes(2);
      const backends = call.mock.calls
        .map(([req]) =>
          req && req.agentCallRequest.kind === "task_run"
            ? req.agentCallRequest.backend
            : null,
        )
        .filter((b): b is AgentBackendId => b !== null)
        .sort();
      expect(backends).toEqual(["claude", "codex"]);

      expect(out.agentOneDraft.agent).toBe("agent_one");
      expect(out.agentTwoDraft.agent).toBe("agent_two");
    });

    it("seeds both flow-agent lanes under the supplied workflowId before the first call", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async (req) => {
        if (req.agentCallRequest.kind !== "task_run") {
          throw new Error("expected task_run");
        }
        if (req.agentCallRequest.backend === "claude") {
          return completedResult("claude", agentOneDraftFixture());
        }
        return completedResult("codex", agentTwoDraftFixture());
      });
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "b",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-x",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });
      await caller.runInitialDrafts({ brief: "b" });

      const agentOneLane = await laneService.resolve({
        workflowId: "wf-x",
        laneId: "agent_one",
      });
      const agentTwoLane = await laneService.resolve({
        workflowId: "wf-x",
        laneId: "agent_two",
      });
      expect(agentOneLane?.backend).toBe("claude");
      expect(agentTwoLane?.backend).toBe("codex");
    });

    it("stamps each call's laneRef with workflowId + flow-agent laneId and includes sessionKey", async () => {
      const { laneService, agentCaller, call } = buildInMemoryDeps(
        async (req) => {
          if (req.agentCallRequest.kind !== "task_run") {
            throw new Error("expected task_run");
          }
          if (req.agentCallRequest.backend === "claude") {
            return completedResult("claude", agentOneDraftFixture());
          }
          return completedResult("codex", agentTwoDraftFixture());
        },
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "b",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-stamped",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });
      await caller.runInitialDrafts({ brief: "b" });

      for (const [req] of call.mock.calls) {
        if (!req) throw new Error("expected request");
        expect(req.laneRef.workflowId).toBe("wf-stamped");
        expect(req.sessionKey).toBe("/proj::sess");
        if (req.agentCallRequest.kind !== "task_run") {
          throw new Error("expected task_run");
        }
        // secondAgent is codex here, so codex requests belong to agent_two.
        const expectedLane =
          req.agentCallRequest.backend === "codex" ? "agent_two" : "agent_one";
        expect(req.laneRef.laneId).toBe(expectedLane);
        expect(req.agentCallRequest.laneRef?.laneId).toBe(expectedLane);
      }
    });

    it("throws when either initial draft fails", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async (req) => {
        if (req.agentCallRequest.kind !== "task_run") {
          throw new Error("expected task_run");
        }
        if (req.agentCallRequest.backend === "claude") {
          return failedResult("claude", "initial draft boom");
        }
        return completedResult("codex", agentTwoDraftFixture());
      });
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(caller.runInitialDrafts({ brief: "brief" })).rejects.toThrow(
        /initial draft boom/,
      );
    });
  });

  describe("runCrossReview", () => {
    it("invokes agent_two on the secondAgent backend and parses the cross review", async () => {
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () =>
        completedResult("codex", crossReviewFixture()),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      const out = await caller.runCrossReview({
        brief: "brief",
        agentOneDraft: agentOneDraftFixture(),
        agentTwoDraft: agentTwoDraftFixture(),
      });

      expect(call).toHaveBeenCalledTimes(1);
      const [req] = call.mock.calls[0]!;
      if (!req || req.agentCallRequest.kind !== "task_run") {
        throw new Error("expected task_run");
      }
      expect(req.agentCallRequest.backend).toBe("codex");
      expect(req.agentCallRequest.modelSelection).toEqual({
        modelId: "gpt-5.4",
        parameters: { reasoning: "medium", fast: "false" },
      });
      expect(req.laneRef.laneId).toBe("agent_two");
      expect(out.agentTwoCrossReview.agent).toBe("agent_two");
      expect(out.agentTwoCrossReview.target_agent).toBe("agent_one");
    });

    it("throws when the cross review fails", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async () =>
        failedResult("codex", "cross review boom"),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(
        caller.runCrossReview({
          brief: "brief",
          agentOneDraft: agentOneDraftFixture(),
          agentTwoDraft: agentTwoDraftFixture(),
        }),
      ).rejects.toThrow(/cross review boom/);
    });
  });

  describe("runRound", () => {
    it("invokes a three-call round: agent_one proposed_changes → agent_two counter_proposal → agent_one resolution_decision", async () => {
      let callIndex = 0;
      const sequence: AgentCallResult[] = [
        completedResult("claude", proposedChangesFixture()),
        completedResult("codex", counterProposalFixture()),
        completedResult("claude", resolutionFixture()),
      ];
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () => {
        const next = sequence[callIndex];
        callIndex += 1;
        if (!next) throw new Error("unexpected extra call");
        return next;
      });

      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "use Postgres?",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      const out = await caller.runRound({
        round: 1,
        brief: "use Postgres?",
        agentOneDraft: agentOneDraftFixture(),
        agentTwoDraft: agentTwoDraftFixture(),
        agentTwoCrossReview: crossReviewFixture(),
      });

      expect(call).toHaveBeenCalledTimes(3);
      const callBackends = call.mock.calls
        .map(([req]) =>
          req && req.agentCallRequest.kind === "task_run"
            ? req.agentCallRequest.backend
            : null,
        )
        .filter((b): b is AgentBackendId => b !== null);
      expect(callBackends).toEqual(["claude", "codex", "claude"]);

      expect(out.proposedChanges.kind).toBe("proposed_changes");
      expect(out.counterProposal.kind).toBe("counter_proposal");
      expect(out.resolution.kind).toBe("resolution_decision");
    });

    it("throws when the proposed_changes call fails", async () => {
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () =>
        failedResult("claude", "proposed boom"),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(
        caller.runRound({
          round: 1,
          brief: "brief",
          agentOneDraft: agentOneDraftFixture(),
          agentTwoDraft: agentTwoDraftFixture(),
          agentTwoCrossReview: crossReviewFixture(),
        }),
      ).rejects.toThrow(/proposed boom/);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it("throws when the counter_proposal call fails", async () => {
      let callIndex = 0;
      const sequence: AgentCallResult[] = [
        completedResult("claude", proposedChangesFixture()),
        failedResult("codex", "counter boom"),
      ];
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () => {
        const next = sequence[callIndex];
        callIndex += 1;
        if (!next) throw new Error("unexpected extra call");
        return next;
      });
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(
        caller.runRound({
          round: 1,
          brief: "brief",
          agentOneDraft: agentOneDraftFixture(),
          agentTwoDraft: agentTwoDraftFixture(),
          agentTwoCrossReview: crossReviewFixture(),
        }),
      ).rejects.toThrow(/counter boom/);
      expect(call).toHaveBeenCalledTimes(2);
    });

    it("throws when the resolution_decision call fails after the prior two succeed", async () => {
      let callIndex = 0;
      const sequence: AgentCallResult[] = [
        completedResult("claude", proposedChangesFixture()),
        completedResult("codex", counterProposalFixture()),
        failedResult("claude", "resolution boom"),
      ];
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () => {
        const next = sequence[callIndex];
        callIndex += 1;
        if (!next) throw new Error("unexpected extra call");
        return next;
      });
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(
        caller.runRound({
          round: 1,
          brief: "brief",
          agentOneDraft: agentOneDraftFixture(),
          agentTwoDraft: agentTwoDraftFixture(),
          agentTwoCrossReview: crossReviewFixture(),
        }),
      ).rejects.toThrow(/resolution boom/);
      expect(call).toHaveBeenCalledTimes(3);
    });
  });

  describe("generateFinalAnswer", () => {
    it("invokes the agent caller with the final-answer schema on agent_one's backend and returns the parsed answer", async () => {
      const final: CollaborationFinalAnswerOutput = makeFinalAnswer({
        summary:
          "Use Postgres because durability requirements outweigh latency",
      });
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () =>
        completedResult("claude", final),
      );

      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "use Postgres?",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      const out = await caller.generateFinalAnswer({
        brief: "use Postgres?",
        agentOneDraft: agentOneDraftFixture(),
        agentTwoDraft: agentTwoDraftFixture(),
        latestCounterProposal: counterProposalFixture(),
        latestResolutionDecision: resolutionFixture({
          next_action: "final",
          agreement_reached: true,
          rationale: "agreed",
        }),
      });

      expect(call).toHaveBeenCalledTimes(1);
      const [req] = call.mock.calls[0]!;
      if (!req || req.agentCallRequest.kind !== "task_run") {
        throw new Error("expected task_run");
      }
      expect(req.agentCallRequest.backend).toBe("claude");
      expect(req.laneRef.laneId).toBe("agent_one");

      expect(out.finalAnswer).toEqual(
        rehomeGeneratedArtifactPaths(final, "wf-1"),
      );
      expect(out.finalAnswerText).toContain("Use Postgres");
    });

    it("throws when the final answer call fails", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async () =>
        failedResult("claude", "boom"),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath,
        brief: "brief",
        parentImplementerTurnId: "impl-1",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        workflowId: "wf-1",
        sessionKey: "/proj::sess",
        agentCaller,
        laneService,
      });

      await expect(
        caller.generateFinalAnswer({
          brief: "brief",
          agentOneDraft: agentOneDraftFixture(),
          agentTwoDraft: agentTwoDraftFixture(),
          latestCounterProposal: counterProposalFixture(),
          latestResolutionDecision: resolutionFixture(),
        }),
      ).rejects.toThrow(/boom/);
    });
  });
});
