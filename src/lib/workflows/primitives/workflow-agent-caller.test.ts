/**
 * WorkflowAgentCaller adapter tests.
 *
 * Validates the production composition point above AgentCall: lane resolution,
 * Claude conversation / Codex thread resume, post-turn outcomes, stale-ref
 * recovery, and LaneScheduler serialization. Mirrors the validation scenarios
 * named in `memory-bank/composable-workflow-primitives-integration-plan.md`
 * issues 2 and 3.
 */
import { describe, it, expect } from "vitest";

import {
  createWorkflowAgentCaller,
  markStaleBackendRefError,
  type WorkflowAgentCallContinuity,
  type WorkflowAgentCallerDeps,
  type WorkflowAgentCallerRequest,
} from "./workflow-agent-caller";
import {
  createLaneScheduler,
  type LaneScheduleRequest,
} from "./lane-scheduler";
import { createLaneService } from "./lane-service";
import { createInMemoryLaneStore } from "./lane-store";
import type { LaneState } from "./lane-vocabulary";
import type {
  AgentCallRequest,
  AgentCallResult,
  BackendCapabilityView,
} from "./agent-call-vocabulary";

interface Recorded {
  continuities: WorkflowAgentCallContinuity[];
  agentRequests: AgentCallRequest[];
  scheduleRequests: LaneScheduleRequest[];
  createClaudeCalls: number;
  validateClaudeCalls: number;
  startCodexCalls: number;
  resumeCodexCalls: number;
}

interface Harness {
  deps: WorkflowAgentCallerDeps;
  recorded: Recorded;
  fixedNow: string;
}

const claudeCapabilities: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

const codexCapabilities: BackendCapabilityView = {
  backend: "codex",
  continuationStrength: "synthetic_thread",
  structuredOutputEnforcement: "backend_native",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: false,
  nativeMidTurnAskUser: false,
};

function buildHarness(
  opts: {
    callAgent?: WorkflowAgentCallerDeps["callAgent"];
    validateClaudeConversation?: WorkflowAgentCallerDeps["validateClaudeConversation"];
    resumeCodexThread?: WorkflowAgentCallerDeps["resumeCodexThread"];
    createClaudeConversation?: WorkflowAgentCallerDeps["createClaudeConversation"];
    startCodexThread?: WorkflowAgentCallerDeps["startCodexThread"];
  } = {},
): Harness {
  const recorded: Recorded = {
    continuities: [],
    agentRequests: [],
    scheduleRequests: [],
    createClaudeCalls: 0,
    validateClaudeCalls: 0,
    startCodexCalls: 0,
    resumeCodexCalls: 0,
  };
  const fixedNow = "2026-04-28T00:00:00.000Z";

  const baseScheduler = createLaneScheduler();
  const laneScheduler = {
    schedule: async <T>(
      req: LaneScheduleRequest,
      fn: () => Promise<T>,
    ): Promise<T> => {
      recorded.scheduleRequests.push(req);
      return baseScheduler.schedule(req, fn);
    },
  };

  const laneService = createLaneService({
    store: createInMemoryLaneStore(),
    now: () => fixedNow,
  });

  const callAgent: WorkflowAgentCallerDeps["callAgent"] =
    opts.callAgent ??
    (async (request, continuity) => {
      recorded.agentRequests.push(request);
      recorded.continuities.push(continuity);
      const backend =
        request.kind === "task_run"
          ? request.backend
          : (request.backend ?? "claude");
      return successResult(backend, continuity);
    });

  const deps: WorkflowAgentCallerDeps = {
    callAgent,
    laneService,
    laneScheduler,
    createClaudeConversation:
      opts.createClaudeConversation ??
      (async () => {
        recorded.createClaudeCalls++;
        return { conversationId: `claude-conv-${recorded.createClaudeCalls}` };
      }),
    validateClaudeConversation:
      opts.validateClaudeConversation ??
      (async () => {
        recorded.validateClaudeCalls++;
        return true;
      }),
    startCodexThread:
      opts.startCodexThread ??
      (async () => {
        recorded.startCodexCalls++;
        return { threadId: `codex-thread-${recorded.startCodexCalls}` };
      }),
    resumeCodexThread:
      opts.resumeCodexThread ??
      (async ({ threadId }) => {
        recorded.resumeCodexCalls++;
        return { threadId };
      }),
    now: () => fixedNow,
  };

  return { deps, recorded, fixedNow };
}

function successResult(
  backend: "claude" | "codex",
  continuity: WorkflowAgentCallContinuity,
  overrides: Partial<AgentCallResult> = {},
): AgentCallResult {
  const backendRef =
    continuity.resumeRef ??
    (backend === "claude"
      ? { backend: "claude" as const, sessionId: "sess-default" }
      : { backend: "codex" as const, threadId: "thread-default" });
  return {
    backend,
    backendRef,
    capabilities: backend === "claude" ? claudeCapabilities : codexCapabilities,
    usage: {},
    artifacts: [],
    outcome: { kind: "completed", text: "ok" },
    ...overrides,
  };
}

async function seedClaudeLane(
  deps: WorkflowAgentCallerDeps,
  laneRef: { workflowId: string; laneId: string },
  conversationId: string | undefined,
  options: { rotate?: boolean; contextLimitTokens?: number } = {},
): Promise<void> {
  const seeded: LaneState = {
    workflowId: laneRef.workflowId,
    laneId: laneRef.laneId,
    backend: "claude",
    writeCapability: "write_capable",
    policy: {
      continuityEnabled: true,
      ...(options.contextLimitTokens !== undefined
        ? { contextLimitTokens: options.contextLimitTokens }
        : {}),
    },
    backendState: {
      backend: "claude",
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
    metrics: {
      backend: "claude",
      rotateBeforeNextTurn: options.rotate === true,
    },
    lastUsedAt: "2026-04-28T00:00:00.000Z",
  };
  await deps.laneService.initialize(seeded);
}

async function seedCodexLane(
  deps: WorkflowAgentCallerDeps,
  laneRef: { workflowId: string; laneId: string },
  threadId: string | undefined,
): Promise<void> {
  const seeded: LaneState = {
    workflowId: laneRef.workflowId,
    laneId: laneRef.laneId,
    backend: "codex",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: {
      backend: "codex",
      ...(threadId !== undefined ? { threadId } : {}),
    },
    metrics: { backend: "codex", rotateBeforeNextTurn: false },
    lastUsedAt: "2026-04-28T00:00:00.000Z",
  };
  await deps.laneService.initialize(seeded);
}

function buildClaudeRequest(
  laneRef: { workflowId: string; laneId: string },
  overrides: Partial<WorkflowAgentCallerRequest> = {},
): WorkflowAgentCallerRequest {
  return {
    laneRef,
    sessionKey: overrides.sessionKey ?? "session-A",
    writeCapability: overrides.writeCapability,
    contextLimitTokens: overrides.contextLimitTokens,
    agentCallRequest: overrides.agentCallRequest ?? {
      kind: "conversation_turn",
      backend: "claude",
      prompt: "claude prompt",
      laneRef,
      writeCapability: overrides.writeCapability ?? "write_capable",
    },
  } as WorkflowAgentCallerRequest;
}

function buildCodexRequest(
  laneRef: { workflowId: string; laneId: string },
  overrides: Partial<WorkflowAgentCallerRequest> = {},
): WorkflowAgentCallerRequest {
  return {
    laneRef,
    sessionKey: overrides.sessionKey ?? "session-A",
    writeCapability: overrides.writeCapability,
    agentCallRequest: overrides.agentCallRequest ?? {
      kind: "task_run",
      backend: "codex",
      prompt: "codex prompt",
      laneRef,
      writeCapability: overrides.writeCapability ?? "write_capable",
    },
  } as WorkflowAgentCallerRequest;
}

describe("createWorkflowAgentCaller", () => {
  describe("lane resolution and continuity", () => {
    it("resumes the prior Claude conversation for a lane-backed call", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-1", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "claude-prior-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.validateClaudeCalls).toBe(1);
      expect(recorded.createClaudeCalls).toBe(0);
      expect(recorded.continuities).toHaveLength(1);
      expect(recorded.continuities[0]).toMatchObject({
        laneRef,
        laneAction: "reuse",
        resumeRef: { backend: "claude", sessionId: "claude-prior-1" },
      });
    });

    it("resumes the prior Codex thread for a lane-backed call", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-1", laneId: "codex" };
      await seedCodexLane(deps, laneRef, "codex-prior-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(recorded.resumeCodexCalls).toBe(1);
      expect(recorded.startCodexCalls).toBe(0);
      expect(recorded.continuities).toHaveLength(1);
      expect(recorded.continuities[0]).toMatchObject({
        laneRef,
        laneAction: "reuse",
        resumeRef: { backend: "codex", threadId: "codex-prior-1" },
      });
    });

    it("creates a fresh Claude conversation when the lane has no prior backend ref", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-2", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, undefined);
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.createClaudeCalls).toBe(1);
      expect(recorded.validateClaudeCalls).toBe(0);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        sessionId: "claude-conv-1",
      });
    });

    it("creates a fresh Codex thread when the lane has no prior thread", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-2", laneId: "codex" };
      await seedCodexLane(deps, laneRef, undefined);
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(recorded.startCodexCalls).toBe(1);
      expect(recorded.resumeCodexCalls).toBe(0);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "codex",
        threadId: "codex-thread-1",
      });
    });

    it("rotates to a fresh backend when rotateBeforeNextTurn is set", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-3", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "old-claude-conv", { rotate: true });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.createClaudeCalls).toBe(1);
      expect(recorded.validateClaudeCalls).toBe(0);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        sessionId: "claude-conv-1",
      });
    });

    it("throws when the lane has not been initialized", async () => {
      const { deps } = buildHarness();
      const caller = createWorkflowAgentCaller(deps);
      await expect(
        caller.call(
          buildClaudeRequest({ workflowId: "wf-x", laneId: "claude" }),
        ),
      ).rejects.toThrow(/not initialized/);
    });
  });

  describe("LaneScheduler integration", () => {
    it("serializes two write-capable calls sharing a session key", async () => {
      const events: string[] = [];
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        request,
        continuity,
      ) => {
        events.push(`start:${continuity.laneRef.laneId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${continuity.laneRef.laneId}`);
        const backend =
          request.kind === "task_run"
            ? request.backend
            : (request.backend ?? "claude");
        return successResult(backend, continuity);
      };
      const { deps } = buildHarness({ callAgent });
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "a" }, "ca");
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "b" }, "cb");
      const caller = createWorkflowAgentCaller(deps);

      await Promise.all([
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "a" },
            { sessionKey: "shared", writeCapability: "write_capable" },
          ),
        ),
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "b" },
            { sessionKey: "shared", writeCapability: "write_capable" },
          ),
        ),
      ]);

      expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    });

    it("allows two read-only calls to overlap on the same session key", async () => {
      const events: string[] = [];
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        request,
        continuity,
      ) => {
        events.push(`start:${continuity.laneRef.laneId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${continuity.laneRef.laneId}`);
        const backend =
          request.kind === "task_run"
            ? request.backend
            : (request.backend ?? "claude");
        return successResult(backend, continuity);
      };
      const { deps } = buildHarness({ callAgent });
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "a" }, "ca");
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "b" }, "cb");
      const caller = createWorkflowAgentCaller(deps);

      await Promise.all([
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "a" },
            { sessionKey: "shared", writeCapability: "read_only" },
          ),
        ),
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "b" },
            { sessionKey: "shared", writeCapability: "read_only" },
          ),
        ),
      ]);

      expect(events).toEqual(["start:a", "start:b", "end:a", "end:b"]);
    });

    it("treats a missing writeCapability as write-capable (serializes)", async () => {
      const events: string[] = [];
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        request,
        continuity,
      ) => {
        events.push(`start:${continuity.laneRef.laneId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${continuity.laneRef.laneId}`);
        const backend =
          request.kind === "task_run"
            ? request.backend
            : (request.backend ?? "claude");
        return successResult(backend, continuity);
      };
      const { deps, recorded } = buildHarness({ callAgent });
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "a" }, "ca");
      await seedClaudeLane(deps, { workflowId: "wf", laneId: "b" }, "cb");
      const caller = createWorkflowAgentCaller(deps);

      await Promise.all([
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "a" },
            { sessionKey: "shared" },
          ),
        ),
        caller.call(
          buildClaudeRequest(
            { workflowId: "wf", laneId: "b" },
            { sessionKey: "shared" },
          ),
        ),
      ]);

      expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
      expect(
        recorded.scheduleRequests.every(
          (r) => r.writeCapability === "write_capable",
        ),
      ).toBe(true);
    });
  });

  describe("post-turn outcome recording", () => {
    it("records context-limit rotation for a Claude call when contextTokens exceeds the limit", async () => {
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        _request,
        continuity,
      ) => {
        return {
          backend: "claude",
          backendRef: continuity.resumeRef,
          capabilities: claudeCapabilities,
          usage: { contextTokens: 200_000, contextWindowMax: 250_000 },
          artifacts: [],
          outcome: { kind: "completed", text: "ok" },
        };
      };
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-rot", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "claude-prior", {
        contextLimitTokens: 150_000,
      });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(
        buildClaudeRequest(laneRef, { contextLimitTokens: 150_000 }),
      );

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.metrics.rotateBeforeNextTurn).toBe(true);
      if (after?.metrics.backend === "claude") {
        expect(after.metrics.contextTokens).toBe(200_000);
        expect(after.metrics.contextWindowMax).toBe(250_000);
      }
    });

    it("records the post-turn Codex thread id and turn usage", async () => {
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async () => ({
        backend: "codex",
        backendRef: { backend: "codex", threadId: "codex-after-turn" },
        capabilities: codexCapabilities,
        usage: { inputTokens: 50, outputTokens: 30, cachedInputTokens: 5 },
        artifacts: [],
        outcome: { kind: "completed", text: "ok" },
      });
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-codex-rec", laneId: "codex" };
      await seedCodexLane(deps, laneRef, "codex-prior");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      const after = await deps.laneService.resolve(laneRef);
      if (after?.backendState.backend === "codex") {
        expect(after.backendState.threadId).toBe("codex-after-turn");
      }
      if (after?.metrics.backend === "codex") {
        expect(after.metrics.lastTurnUsage).toEqual({
          inputTokens: 50,
          cachedInputTokens: 5,
          outputTokens: 30,
        });
        expect(after.metrics.rotateBeforeNextTurn).toBe(false);
      }
    });

    it("flips Codex rotateBeforeNextTurn when the agent call fails", async () => {
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async () => ({
        backend: "codex",
        backendRef: null,
        capabilities: codexCapabilities,
        usage: {},
        artifacts: [],
        outcome: {
          kind: "failed",
          error: {
            failureKind: "backend_error",
            backend: "codex",
            message: "boom",
          },
        },
      });
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-fail", laneId: "codex" };
      await seedCodexLane(deps, laneRef, "codex-prior");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.metrics.rotateBeforeNextTurn).toBe(true);
    });

    it("propagates the error when recording the post-turn outcome fails", async () => {
      const { deps } = buildHarness();
      const laneRef = { workflowId: "wf-record-fail", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "claude-prior-1");
      const failingLaneService: WorkflowAgentCallerDeps["laneService"] = {
        resolve: deps.laneService.resolve,
        initialize: deps.laneService.initialize,
        recordOutcome: async () => {
          throw new Error("lane store write failed");
        },
      };
      const failingDeps: WorkflowAgentCallerDeps = {
        ...deps,
        laneService: failingLaneService,
      };
      const caller = createWorkflowAgentCaller(failingDeps);

      await expect(caller.call(buildClaudeRequest(laneRef))).rejects.toThrow(
        /lane store write failed/,
      );
    });
  });

  describe("stale backend recovery", () => {
    it("creates a fresh Claude conversation when validation reports the prior conversation is gone", async () => {
      const { deps, recorded } = buildHarness({
        validateClaudeConversation: async () => {
          recorded?.validateClaudeCalls;
          return false;
        },
      });
      const laneRef = { workflowId: "wf-stale", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "claude-deleted-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.createClaudeCalls).toBe(1);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        sessionId: "claude-conv-1",
      });
      const after = await deps.laneService.resolve(laneRef);
      expect(after?.workflowId).toBe(laneRef.workflowId);
      expect(after?.laneId).toBe(laneRef.laneId);
      if (after?.backendState.backend === "claude") {
        expect(after.backendState.conversationId).toBe("claude-conv-1");
      }
    });

    it("starts a fresh Codex thread when resume rejects (expired thread)", async () => {
      let attempt = 0;
      const { deps, recorded } = buildHarness({
        resumeCodexThread: async () => {
          attempt++;
          throw new Error("thread expired");
        },
      });
      const laneRef = { workflowId: "wf-stale", laneId: "codex" };
      await seedCodexLane(deps, laneRef, "codex-expired-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(attempt).toBe(1);
      expect(recorded.startCodexCalls).toBe(1);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "codex",
        threadId: "codex-thread-1",
      });
      const after = await deps.laneService.resolve(laneRef);
      expect(after?.workflowId).toBe(laneRef.workflowId);
      expect(after?.laneId).toBe(laneRef.laneId);
      if (after?.backendState.backend === "codex") {
        expect(after.backendState.threadId).toBe("codex-thread-1");
      }
    });

    it("retries once when callAgent throws a stale-backend-ref error", async () => {
      const records: WorkflowAgentCallContinuity[] = [];
      let callCount = 0;
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        _request,
        continuity,
      ) => {
        records.push(continuity);
        callCount++;
        if (callCount === 1) {
          throw markStaleBackendRefError(
            new Error("backend session not found"),
          );
        }
        return successResult("claude", continuity);
      };
      const { deps, recorded } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-mid-stale", laneId: "claude" };
      await seedClaudeLane(deps, laneRef, "claude-pre-stale");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(callCount).toBe(2);
      expect(records[0]?.laneAction).toBe("reuse");
      expect(records[0]?.resumeRef).toEqual({
        backend: "claude",
        sessionId: "claude-pre-stale",
      });
      expect(records[1]?.laneAction).toBe("create");
      expect(records[1]?.resumeRef).toEqual({
        backend: "claude",
        sessionId: "claude-conv-1",
      });
      expect(recorded.createClaudeCalls).toBe(1);
    });
  });
});
