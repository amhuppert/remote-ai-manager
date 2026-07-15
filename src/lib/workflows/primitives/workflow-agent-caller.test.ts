/**
 * WorkflowAgentCaller adapter tests.
 *
 * Validates the production composition point above AgentCall: lane
 * resolution, continuity resolution through injected backend continuity
 * adapters (start / resumeOrRecover), post-turn outcomes, stale-ref
 * recovery, and LaneScheduler serialization.
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
import type {
  BackendContinuityAdapter,
  ContinuityContext,
  ContinuityResumption,
} from "@/lib/agent-backends/continuity";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";

interface Recorded {
  continuities: WorkflowAgentCallContinuity[];
  agentRequests: AgentCallRequest[];
  scheduleRequests: LaneScheduleRequest[];
  starts: Record<string, number>;
  resumes: Record<string, number>;
  continuityContexts: ContinuityContext[];
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

const CONTINUITY_CONTEXT: ContinuityContext = {
  projectPath: "/projects/demo",
  sessionName: "session-demo",
};

function buildHarness(
  opts: {
    callAgent?: WorkflowAgentCallerDeps["callAgent"];
    /** Overrides the fake adapter's resumeOrRecover per backend. */
    resumeOrRecover?: Partial<
      Record<
        AgentBackendId,
        (ref: AgentSessionRef) => Promise<ContinuityResumption>
      >
    >;
  } = {},
): Harness {
  const recorded: Recorded = {
    continuities: [],
    agentRequests: [],
    scheduleRequests: [],
    starts: {},
    resumes: {},
    continuityContexts: [],
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
      return successResult(backend as "claude" | "codex", continuity);
    });

  function fakeAdapter(backend: AgentBackendId): BackendContinuityAdapter {
    const prefix = backend === "claude" ? "claude-conv" : "codex-thread";
    return {
      backend,
      async start(input) {
        recorded.continuityContexts.push(input);
        recorded.starts[backend] = (recorded.starts[backend] ?? 0) + 1;
        return { backend, ref: `${prefix}-${recorded.starts[backend]}` };
      },
      async validate() {
        return { status: "valid" };
      },
      async resumeOrRecover(ref, input) {
        recorded.continuityContexts.push(input);
        recorded.resumes[backend] = (recorded.resumes[backend] ?? 0) + 1;
        const override = opts.resumeOrRecover?.[backend];
        if (override) return override(ref);
        return { ref, recovered: false };
      },
      async fork() {
        return { kind: "unsupported" };
      },
    };
  }

  const adapters: Record<string, BackendContinuityAdapter> = {
    claude: fakeAdapter("claude"),
    codex: fakeAdapter("codex"),
  };

  const deps: WorkflowAgentCallerDeps = {
    callAgent,
    laneService,
    laneScheduler,
    continuityContext: CONTINUITY_CONTEXT,
    continuityAdapter(backend) {
      const adapter = adapters[backend];
      if (!adapter) throw new Error(`no fake adapter for ${backend}`);
      return adapter;
    },
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
      ? { backend: "claude" as const, ref: "sess-default" }
      : { backend: "codex" as const, ref: "thread-default" });
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

async function seedLane(
  deps: WorkflowAgentCallerDeps,
  laneRef: { workflowId: string; laneId: string },
  backend: "claude" | "codex",
  ref: string | null,
  options: {
    rotate?: boolean;
    contextLimitTokens?: number;
    continuityEnabled?: boolean;
  } = {},
): Promise<void> {
  const seeded: LaneState = {
    workflowId: laneRef.workflowId,
    laneId: laneRef.laneId,
    backend,
    ref,
    writeCapability: "write_capable",
    policy: {
      continuityEnabled: options.continuityEnabled ?? true,
      ...(options.contextLimitTokens !== undefined
        ? { contextLimitTokens: options.contextLimitTokens }
        : {}),
    },
    metrics: { rotateBeforeNextTurn: options.rotate === true },
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
      await seedLane(deps, laneRef, "claude", "claude-prior-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.resumes["claude"]).toBe(1);
      expect(recorded.starts["claude"]).toBeUndefined();
      expect(recorded.continuities).toHaveLength(1);
      expect(recorded.continuities[0]).toMatchObject({
        laneRef,
        laneAction: "reuse",
        resumeRef: { backend: "claude", ref: "claude-prior-1" },
      });
    });

    it("resumes the prior Codex thread for a lane-backed call", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-1", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-prior-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(recorded.resumes["codex"]).toBe(1);
      expect(recorded.starts["codex"]).toBeUndefined();
      expect(recorded.continuities).toHaveLength(1);
      expect(recorded.continuities[0]).toMatchObject({
        laneRef,
        laneAction: "reuse",
        resumeRef: { backend: "codex", ref: "codex-prior-1" },
      });
    });

    it("forwards the project/session continuity context to the adapter", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-ctx", laneId: "claude" };
      await seedLane(deps, laneRef, "claude", null);
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.continuityContexts[0]).toEqual(CONTINUITY_CONTEXT);
    });

    it("starts a fresh backend session when the lane has no prior handle", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-2", laneId: "claude" };
      await seedLane(deps, laneRef, "claude", null);
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.starts["claude"]).toBe(1);
      expect(recorded.resumes["claude"]).toBeUndefined();
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        ref: "claude-conv-1",
      });
      const after = await deps.laneService.resolve(laneRef);
      expect(after?.ref).toBe("claude-conv-1");
    });

    it("rotates to a fresh backend when rotateBeforeNextTurn is set", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-3", laneId: "claude" };
      await seedLane(deps, laneRef, "claude", "old-claude-conv", {
        rotate: true,
      });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(recorded.starts["claude"]).toBe(1);
      expect(recorded.resumes["claude"]).toBeUndefined();
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        ref: "claude-conv-1",
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

    it("starts a fresh session when the lane policy disables continuity, even if a prior handle is recorded", async () => {
      const { deps, recorded } = buildHarness();
      const laneRef = { workflowId: "wf-no-cont", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-prior-disabled", {
        continuityEnabled: false,
      });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(recorded.resumes["codex"]).toBeUndefined();
      expect(recorded.starts["codex"]).toBe(1);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "codex",
        ref: "codex-thread-1",
      });
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
        return successResult(backend as "claude" | "codex", continuity);
      };
      const { deps } = buildHarness({ callAgent });
      await seedLane(deps, { workflowId: "wf", laneId: "a" }, "claude", "ca");
      await seedLane(deps, { workflowId: "wf", laneId: "b" }, "claude", "cb");
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
        return successResult(backend as "claude" | "codex", continuity);
      };
      const { deps } = buildHarness({ callAgent });
      await seedLane(deps, { workflowId: "wf", laneId: "a" }, "claude", "ca");
      await seedLane(deps, { workflowId: "wf", laneId: "b" }, "claude", "cb");
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
        return successResult(backend as "claude" | "codex", continuity);
      };
      const { deps, recorded } = buildHarness({ callAgent });
      await seedLane(deps, { workflowId: "wf", laneId: "a" }, "claude", "ca");
      await seedLane(deps, { workflowId: "wf", laneId: "b" }, "claude", "cb");
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
      await seedLane(deps, laneRef, "claude", "claude-prior", {
        contextLimitTokens: 150_000,
      });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(
        buildClaudeRequest(laneRef, { contextLimitTokens: 150_000 }),
      );

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.metrics.rotateBeforeNextTurn).toBe(true);
      expect(after?.metrics.contextTokens).toBe(200_000);
      expect(after?.metrics.contextWindowMax).toBe(250_000);
    });

    it("records the post-turn Codex thread id and turn usage", async () => {
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async () => ({
        backend: "codex",
        backendRef: { backend: "codex", ref: "codex-after-turn" },
        capabilities: codexCapabilities,
        usage: { inputTokens: 50, outputTokens: 30, cachedInputTokens: 5 },
        artifacts: [],
        outcome: { kind: "completed", text: "ok" },
      });
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-codex-rec", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-prior");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.ref).toBe("codex-after-turn");
      expect(after?.metrics.lastTurnUsage).toEqual({
        inputTokens: 50,
        cachedInputTokens: 5,
        outputTokens: 30,
      });
      expect(after?.metrics.rotateBeforeNextTurn).toBe(false);
    });

    it("retains a Codex lane when a failed call explicitly retains continuation", async () => {
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
        continuationDisposition: "retain",
      });
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-fail", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-prior");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.metrics.rotateBeforeNextTurn).toBe(false);
    });

    it("rotates a lane when the call explicitly clears continuation", async () => {
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
        continuationDisposition: "clear",
      });
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-clear", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-prior");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      const after = await deps.laneService.resolve(laneRef);
      expect(after?.metrics.rotateBeforeNextTurn).toBe(true);
      expect(after?.ref).toBe("codex-prior");
    });

    it("propagates the error when recording the post-turn outcome fails", async () => {
      const { deps } = buildHarness();
      const laneRef = { workflowId: "wf-record-fail", laneId: "claude" };
      await seedLane(deps, laneRef, "claude", "claude-prior-1");
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

  describe("two-turn format follow-up (single scheduled operation)", () => {
    it("acquires the scheduler once for a work turn plus a format follow-up, threading the work turn's advanced ref into the format turn", async () => {
      const records: WorkflowAgentCallContinuity[] = [];
      const prompts: string[] = [];
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        request,
        continuity,
      ) => {
        records.push(continuity);
        prompts.push(
          request.kind === "task_run" || request.kind === "conversation_turn"
            ? request.prompt
            : "",
        );
        // Each turn advances the codex thread so the format turn must resume
        // the work turn's newly minted ref, not the seeded one.
        return {
          backend: "codex",
          backendRef: {
            backend: "codex",
            ref: `thread-after-${records.length}`,
          },
          capabilities: codexCapabilities,
          usage: {},
          artifacts: [],
          outcome: { kind: "completed", text: "ok" },
        };
      };
      const { deps, recorded } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-two-turn", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-seed");
      const caller = createWorkflowAgentCaller(deps);

      const result = await caller.call({
        laneRef,
        sessionKey: "session-two-turn",
        writeCapability: "write_capable",
        agentCallRequest: {
          kind: "task_run",
          backend: "codex",
          prompt: "work turn prompt",
          laneRef,
          writeCapability: "write_capable",
        },
        formatFollowUp: {
          kind: "task_run",
          backend: "codex",
          prompt: "format turn prompt",
          laneRef,
          writeCapability: "write_capable",
          outputSchema: { type: "object" },
        },
      });

      // Two backend turns ran; ONE scheduler acquisition wrapped both.
      expect(prompts).toEqual(["work turn prompt", "format turn prompt"]);
      expect(recorded.scheduleRequests).toHaveLength(1);

      // The work turn resumed the seeded ref; the format turn resumed the ref
      // the work turn advanced (persisted between the two turns in one section).
      expect(records[0]?.resumeRef).toEqual({
        backend: "codex",
        ref: "codex-seed",
      });
      expect(records[1]?.resumeRef).toEqual({
        backend: "codex",
        ref: "thread-after-1",
      });

      // The returned result is the format turn's.
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-after-2",
      });
    });

    it("does not resume the work turn's ref for the format turn when lane continuity is disabled", async () => {
      const records: WorkflowAgentCallContinuity[] = [];
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async (
        _request,
        continuity,
      ) => {
        records.push(continuity);
        return {
          backend: "codex",
          backendRef: {
            backend: "codex",
            ref: `thread-after-${records.length}`,
          },
          capabilities: codexCapabilities,
          usage: {},
          artifacts: [],
          outcome: { kind: "completed", text: "ok" },
        };
      };
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-two-turn-no-cont", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-seed", {
        continuityEnabled: false,
      });
      const caller = createWorkflowAgentCaller(deps);

      await caller.call({
        laneRef,
        sessionKey: "session-two-turn-no-cont",
        writeCapability: "write_capable",
        agentCallRequest: {
          kind: "task_run",
          backend: "codex",
          prompt: "work",
          laneRef,
          writeCapability: "write_capable",
        },
        formatFollowUp: {
          kind: "task_run",
          backend: "codex",
          prompt: "format",
          laneRef,
          writeCapability: "write_capable",
          outputSchema: { type: "object" },
        },
      });

      // Continuity disabled: every turn starts a fresh backend session, so
      // neither turn carries a resume ref (laneAction === "create").
      expect(records[0]?.laneAction).toBe("create");
      expect(records[1]?.laneAction).toBe("create");
    });

    it("skips the format turn and returns the work turn result when the work turn does not complete", async () => {
      let callCount = 0;
      const callAgent: WorkflowAgentCallerDeps["callAgent"] = async () => {
        callCount++;
        return {
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
              message: "work turn boom",
            },
          },
        };
      };
      const { deps } = buildHarness({ callAgent });
      const laneRef = { workflowId: "wf-two-turn-fail", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-seed");
      const caller = createWorkflowAgentCaller(deps);

      const result = await caller.call({
        laneRef,
        sessionKey: "session-two-turn-fail",
        writeCapability: "write_capable",
        agentCallRequest: {
          kind: "task_run",
          backend: "codex",
          prompt: "work",
          laneRef,
          writeCapability: "write_capable",
        },
        formatFollowUp: {
          kind: "task_run",
          backend: "codex",
          prompt: "format",
          laneRef,
          writeCapability: "write_capable",
          outputSchema: { type: "object" },
        },
      });

      expect(callCount).toBe(1);
      expect(result.outcome.kind).toBe("failed");
    });
  });

  describe("stale backend recovery", () => {
    it("treats an adapter-recovered handle as a fresh session and persists it on the lane", async () => {
      const { deps, recorded } = buildHarness({
        resumeOrRecover: {
          claude: async () => ({
            ref: { backend: "claude", ref: "claude-recovered-1" },
            recovered: true,
          }),
        },
      });
      const laneRef = { workflowId: "wf-stale", laneId: "claude" };
      await seedLane(deps, laneRef, "claude", "claude-deleted-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "claude",
        ref: "claude-recovered-1",
      });
      const after = await deps.laneService.resolve(laneRef);
      expect(after?.workflowId).toBe(laneRef.workflowId);
      expect(after?.laneId).toBe(laneRef.laneId);
      expect(after?.ref).toBe("claude-recovered-1");
    });

    it("starts a fresh session when resumeOrRecover rejects (expired handle)", async () => {
      let attempt = 0;
      const { deps, recorded } = buildHarness({
        resumeOrRecover: {
          codex: async () => {
            attempt++;
            throw new Error("thread expired");
          },
        },
      });
      const laneRef = { workflowId: "wf-stale", laneId: "codex" };
      await seedLane(deps, laneRef, "codex", "codex-expired-1");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildCodexRequest(laneRef));

      expect(attempt).toBe(1);
      expect(recorded.starts["codex"]).toBe(1);
      const continuity = recorded.continuities[0];
      expect(continuity?.laneAction).toBe("create");
      expect(continuity?.resumeRef).toEqual({
        backend: "codex",
        ref: "codex-thread-1",
      });
      const after = await deps.laneService.resolve(laneRef);
      expect(after?.ref).toBe("codex-thread-1");
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
      await seedLane(deps, laneRef, "claude", "claude-pre-stale");
      const caller = createWorkflowAgentCaller(deps);

      await caller.call(buildClaudeRequest(laneRef));

      expect(callCount).toBe(2);
      expect(records[0]?.laneAction).toBe("reuse");
      expect(records[0]?.resumeRef).toEqual({
        backend: "claude",
        ref: "claude-pre-stale",
      });
      expect(records[1]?.laneAction).toBe("create");
      expect(records[1]?.resumeRef).toEqual({
        backend: "claude",
        ref: "claude-conv-1",
      });
      expect(recorded.starts["claude"]).toBe(1);
    });
  });
});
