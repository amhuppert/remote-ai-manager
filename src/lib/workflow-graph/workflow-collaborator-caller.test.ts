/**
 * Tests for the production `WorkflowCollaborationCollaboratorCaller` factory
 * created by `createWorkflowCollaboratorCaller`.
 *
 * The factory composes the canonical phase prompt builders, routes every call
 * through a `WorkflowAgentCaller` for lane bookkeeping, and parses the
 * structured outputs through the authoritative Zod schemas. These tests
 * exercise the caller through a DI'd fake `WorkflowAgentCaller` (no `vi.mock`
 * on internal modules) and verify behavior: which backend each phase calls,
 * that lane refs are stamped with the correct (workflowId, laneId=backend)
 * pair, that structured outputs are parsed, and that failures surface as
 * thrown errors.
 */

import { describe, expect, it, vi } from "vitest";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { WorkflowAgentCaller } from "@/lib/workflows/primitives/workflow-agent-caller";
import type { WorkflowAgentCallerRequest } from "@/lib/workflows/primitives/workflow-agent-caller";
import { createWorkflowCollaboratorCaller } from "./workflow-collaborator-caller";
import type { AgentBackendId } from "@/lib/agent-backends/types";
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
} from "@/lib/workflows/schemas";

function resolvedConfigFixture(
  backend: "claude" | "codex",
): ResolvedCollaborationConfig {
  return {
    secondAgent: {
      value:
        backend === "codex"
          ? { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" }
          : { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 4, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  };
}

function agentOneDraftFixture(): CollaborationInitialDraftOutput {
  return {
    kind: "initial_draft",
    agent: "agent_one",
    narrative: "agent_one initial draft narrative",
    report: "agent_one initial draft report",
    supporting: [],
    assumptions: [],
    keyClaims: [],
  };
}

function agentTwoDraftFixture(): CollaborationInitialDraftOutput {
  return {
    kind: "initial_draft",
    agent: "agent_two",
    narrative: "agent_two initial draft narrative",
    report: "agent_two initial draft report",
    supporting: [],
    assumptions: [],
    keyClaims: [],
  };
}

function crossReviewFixture(): CollaborationCrossReviewOutput {
  return {
    kind: "cross_review",
    agent: "agent_two",
    targetAgent: "agent_one",
    narrative: "agent_two cross review narrative",
    report: "agent_two cross review report",
    supporting: [],
    agree: [],
    disagree: [],
    reviseSelf: [],
  };
}

function proposedChangesFixture(): CollaborationProposedChangesOutput {
  return {
    kind: "proposed_changes",
    agent: "agent_one",
    targetAgent: "agent_two",
    narrative: "agent_one proposed changes narrative",
    acceptedFromAgentTwoDraft: [],
    proposedChanges: [],
    remainingDisagreements: [],
    report: "agent_one proposed changes report",
    supporting: [],
  };
}

function counterProposalFixture(
  overrides?: Partial<CollaborationCounterProposalOutput>,
): CollaborationCounterProposalOutput {
  return {
    kind: "counter_proposal",
    agent: "agent_two",
    narrative: "agent_two counter proposal narrative",
    acceptedProposedChangeIds: [],
    rejectedProposedChangeIds: [],
    alternativeChanges: [],
    agree: [],
    disagree: [],
    report: "agent_two counter proposal report",
    supporting: [],
    ...overrides,
  };
}

function resolutionFixture(
  overrides?: Partial<CollaborationResolutionDecisionOutput>,
): CollaborationResolutionDecisionOutput {
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: false,
    nextAction: "continue_negotiation",
    acceptedPoints: [],
    resolvedDisagreements: [],
    remainingDisagreements: [],
    userQuestions: [],
    rationale: "need another round",
    ...overrides,
  };
}

function capabilityFixture(backend: AgentBackendId): BackendCapabilityView {
  return {
    backend,
    continuationStrength: "synthetic_thread",
    structuredOutputEnforcement: "backend_native",
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
  const call = vi.fn(callImpl);
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
        worktreePath: "/wt",
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

    it("seeds both backend lanes under the supplied workflowId before the first call", async () => {
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
        worktreePath: "/wt",
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

      const claudeLane = await laneService.resolve({
        workflowId: "wf-x",
        laneId: "claude",
      });
      const codexLane = await laneService.resolve({
        workflowId: "wf-x",
        laneId: "codex",
      });
      expect(claudeLane?.backend).toBe("claude");
      expect(codexLane?.backend).toBe("codex");
    });

    it("stamps each call's laneRef with workflowId + backend laneId and includes sessionKey", async () => {
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
        worktreePath: "/wt",
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
        expect(req.laneRef.laneId).toBe(req.agentCallRequest.backend);
        expect(req.agentCallRequest.laneRef?.laneId).toBe(
          req.agentCallRequest.backend,
        );
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
        worktreePath: "/wt",
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
        worktreePath: "/wt",
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
      expect(req.laneRef.laneId).toBe("codex");
      expect(out.agentTwoCrossReview.agent).toBe("agent_two");
      expect(out.agentTwoCrossReview.targetAgent).toBe("agent_one");
    });

    it("throws when the cross review fails", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async () =>
        failedResult("codex", "cross review boom"),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath: "/wt",
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
        worktreePath: "/wt",
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
        round: 2,
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
        worktreePath: "/wt",
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
        worktreePath: "/wt",
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
        worktreePath: "/wt",
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
      const final: CollaborationFinalAnswerOutput = {
        kind: "final_answer",
        agent: "agent_one",
        answer: "Use Postgres because durability requirements outweigh latency",
        report: "Two-round negotiation converged on Postgres for durability.",
        supporting: ["Both agents agreed on the consistency requirement"],
      };
      const { laneService, agentCaller, call } = buildInMemoryDeps(async () =>
        completedResult("claude", final),
      );

      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath: "/wt",
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
          nextAction: "final",
          agreementReached: true,
          rationale: "agreed",
        }),
      });

      expect(call).toHaveBeenCalledTimes(1);
      const [req] = call.mock.calls[0]!;
      if (!req || req.agentCallRequest.kind !== "task_run") {
        throw new Error("expected task_run");
      }
      expect(req.agentCallRequest.backend).toBe("claude");
      expect(req.laneRef.laneId).toBe("claude");

      expect(out.finalAnswer).toEqual(final);
    });

    it("throws when the final answer call fails", async () => {
      const { laneService, agentCaller } = buildInMemoryDeps(async () =>
        failedResult("claude", "boom"),
      );
      const caller = createWorkflowCollaboratorCaller({
        resolvedConfig: resolvedConfigFixture("codex"),
        worktreePath: "/wt",
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
