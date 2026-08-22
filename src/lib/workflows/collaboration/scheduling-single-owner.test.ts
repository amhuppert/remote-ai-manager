/**
 * Pins the lane-scheduling ownership contract for collaboration (plan §3.2.2,
 * D16): the LaneScheduler is acquired in exactly ONE place — inside
 * `WorkflowAgentCaller` — and a full negotiation round behaves identically to
 * the pre-consolidation flow.
 *
 * The test drives the real production composition (`runAsymmetricCollaboration
 * Slice` → `createCollaborationProductionCallAgent` → WorkflowAgentCaller)
 * with a scripted `executeAgentCallImpl`, and injects an instrumented REAL
 * scheduler at the single acquisition point. A nested write-capable
 * acquisition on the same sessionKey — the double-acquisition bug the
 * production no-op inner scheduler used to paper over — would deadlock the
 * chain-based scheduler; the instrumentation throws instead of hanging so the
 * failure mode is legible.
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  runAsymmetricCollaborationSlice,
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
} from "./envelope";
import { EMPTY_COLLABORATION_SESSION_CONTEXT } from "./session-context";
import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeResolutionDecisionFinal,
} from "./test-fixtures";
import type { CollaborationArtifact } from "./types";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createStatusBus } from "@/lib/events/status-bus";
import {
  createLaneScheduler,
  type LaneScheduler,
  type LaneScheduleRequest,
} from "@/lib/workflows/primitives/lane-scheduler";
import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";

type Backend = "claude" | "codex";

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-sched-"));
});

// ============================================================
// Instrumented real scheduler
// ============================================================

interface InstrumentedScheduler {
  scheduler: LaneScheduler;
  /**
   * The raw chain scheduler underneath the guarded wrapper. An external
   * competing writer schedules directly on this (real serialization on the
   * same write chain) without tripping the nested-acquisition guard, which
   * exists only to catch a re-entrant acquisition FROM the collaboration flow.
   */
  inner: LaneScheduler;
  acquisitions: LaneScheduleRequest[];
}

/**
 * Wraps the real chain-based scheduler. A write-capable acquisition that
 * happens while ANOTHER write-capable fn scheduled through this same wrapper is
 * still running signals a nested (re-entrant) acquisition from the
 * collaboration flow — the bug the single-acquisition contract forbids — which
 * would deadlock the real chain; throw instead of hanging so the test fails
 * fast with a named cause. A legitimate external competitor uses `inner`
 * directly, so it contends on the same chain without counting as nested.
 */
function makeInstrumentedScheduler(): InstrumentedScheduler {
  const inner = createLaneScheduler();
  const runningWriteKeys = new Set<string>();
  const acquisitions: LaneScheduleRequest[] = [];

  const scheduler: LaneScheduler = {
    async schedule(request, fn) {
      acquisitions.push(request);
      const capability = request.writeCapability ?? "write_capable";
      if (
        capability === "write_capable" &&
        runningWriteKeys.has(request.sessionKey)
      ) {
        throw new Error(
          `double lane-scheduler acquisition on sessionKey "${request.sessionKey}" — nested write-capable schedule would deadlock`,
        );
      }
      return inner.schedule(request, async () => {
        if (capability === "write_capable") {
          runningWriteKeys.add(request.sessionKey);
        }
        try {
          return await fn();
        } finally {
          if (capability === "write_capable") {
            runningWriteKeys.delete(request.sessionKey);
          }
        }
      });
    },
  };

  return { scheduler, inner, acquisitions };
}

// ============================================================
// Scripted execution below the WorkflowAgentCaller
// ============================================================

function makeCapabilities(backend: Backend): AgentCallResult["capabilities"] {
  return {
    backend,
    continuationStrength:
      backend === "claude" ? "precise_session" : "synthetic_thread",
    structuredOutputEnforcement:
      backend === "claude" ? "post_validation" : "backend_native",
    mcpApplicationBoundary:
      backend === "claude" ? "between_turns" : "per_request",
    contextMetricsAvailable: backend === "claude",
    nativeMidTurnAskUser: backend === "claude",
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

function materializeGeneratedFiles(structuredOutput: unknown): void {
  if (
    typeof structuredOutput !== "object" ||
    structuredOutput === null ||
    !("artifacts" in structuredOutput) ||
    !Array.isArray((structuredOutput as { artifacts?: unknown }).artifacts)
  ) {
    return;
  }
  const output = structuredOutput as {
    kind?: string;
    summary?: string;
    answer_artifact_id?: string;
    artifacts: Array<{ id: string; path: string; artifact_type: string }>;
  };
  for (const ref of output.artifacts) {
    const absolutePath = path.join(workingDir, ref.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const content =
      output.kind === "final_answer" && ref.id === output.answer_artifact_id
        ? (output.summary ?? "final answer")
        : `# ${ref.id}\n\n${output.kind ?? "artifact"} ${ref.artifact_type}\n`;
    writeFileSync(absolutePath, content, "utf-8");
  }
}

interface ScriptedExec {
  exec: (request: AgentCallRequest) => Promise<AgentCallResult>;
  requests: AgentCallRequest[];
}

/**
 * Scripted stand-in for `executeAgentCall`. The production caller issues a
 * prose work turn (no outputSchema) followed by a format turn (outputSchema
 * set) for every schema-carrying request, so schema-less requests get a
 * text-only completion and each schema-carrying request consumes the next
 * scripted structured output for its backend.
 */
function makeScriptedExec(
  workflowId: string,
  outputsByBackend: Record<Backend, unknown[]>,
): ScriptedExec {
  const queues: Record<Backend, unknown[]> = {
    claude: [...outputsByBackend.claude],
    codex: [...outputsByBackend.codex],
  };
  const requests: AgentCallRequest[] = [];

  const exec = async (request: AgentCallRequest): Promise<AgentCallResult> => {
    requests.push(request);
    const backend: Backend =
      request.kind === "conversation_turn"
        ? ((request.backend ?? "claude") as Backend)
        : (request.backend as Backend);
    const backendRef =
      backend === "claude"
        ? ({ backend: "claude", ref: `sess-${backend}` } as const)
        : ({ backend: "codex", ref: `th-${backend}` } as const);

    if (request.outputSchema === undefined) {
      return {
        backend,
        backendRef,
        capabilities: makeCapabilities(backend),
        usage: { durationMs: 5 },
        artifacts: [],
        outcome: { kind: "completed", text: "prose work turn" },
      };
    }

    const next = queues[backend].shift();
    if (!next) {
      throw new Error(
        `scripted exec ran out of structured outputs for backend "${backend}"`,
      );
    }
    const rehomed = rehomeGeneratedArtifactPaths(next, workflowId);
    materializeGeneratedFiles(rehomed);
    return {
      backend,
      backendRef,
      capabilities: makeCapabilities(backend),
      usage: { durationMs: 5 },
      artifacts: [],
      outcome: {
        kind: "completed",
        text: "formatted",
        structuredOutput: rehomed,
      },
    };
  };

  return { exec, requests };
}

const stubClaudeFactory: ConversationBackendFactory = {
  backend: "claude",
  async createRuntime(input) {
    return {
      backend: "claude",
      status: "alive",
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      outputFormat: input.outputFormat,
      alignmentVersion: null,
      applyPortableMcpConfig: async () => ({
        disposition: "applied_now" as const,
        droppedServerIds: [],
        droppedFields: [],
        errors: {},
      }),
      async sendTurn() {
        throw new Error("scripted exec bypasses runtime turns");
      },
      close: async () => {},
    };
  },
};

const stubTaskRunner: AgentTaskRunner = {
  backend: "codex",
  async run() {
    throw new Error("scripted exec bypasses task runner");
  },
};

// ============================================================
// Test
// ============================================================

describe("collaboration lane scheduling — single acquisition owner", () => {
  it("completes a full negotiation round through the production WorkflowAgentCaller with a real scheduler at the single acquisition point (no double-acquisition deadlock, unchanged round behavior)", async () => {
    const workflowId = "wf-sched-pin";
    const sessionKey = "proj::session";
    const instrumented = makeInstrumentedScheduler();
    const laneService = createLaneService({
      store: createInMemoryLaneStore(),
    });
    const scripted = makeScriptedExec(workflowId, {
      claude: [
        makeAgentOneInitialDraft(),
        makeAgentOneProposedChanges(),
        makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        makeFinalAnswer(),
      ],
      codex: [
        makeAgentTwoInitialDraft(),
        makeAgentTwoCrossReview(),
        makeAgentTwoCounterProposalRound1(),
      ],
    });

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/tmp/proj",
      sessionName: "session",
      worktreePath: workingDir,
      sessionKey,
      originatingConversationId: "conv-origin",
      laneService,
      laneScheduler: instrumented.scheduler,
      agents: {
        agent_one: { backend: "claude", model: "claude-sched-model" },
        agent_two: { backend: "codex", model: "codex-sched-model" },
      },
      executeAgentCallImpl: (request) => scripted.exec(request),
      getTaskRunner: () => stubTaskRunner,
      getConversationBackendFactory: () => stubClaudeFactory,
    });

    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    const statusBus = createStatusBus({ broadcast: () => undefined });
    const artifactSidecar: CollaborationArtifact[] = [];

    const deps: AsymmetricCollaborationSliceDeps = {
      callAgent,
      laneService,
      envelopeStore,
      statusBus,
      appendArtifact: async (_workflowId, artifact) => {
        artifactSidecar.push(artifact);
      },
      readArtifactStream: async () => ({
        kind: "ok" as const,
        entries: [...artifactSidecar],
        skipped: [],
      }),
    };

    const input: AsymmetricCollaborationSliceInput = {
      workflowId,
      brief: "Design X.",
      worktreePath: workingDir,
      sessionKey,
      primaryAgentBackend: "claude",
      negotiationRounds: 1,
      autonomousResolutionThreshold: "major",
      sessionContext: EMPTY_COLLABORATION_SESSION_CONTEXT,
    };

    const result = await runAsymmetricCollaborationSlice(input, deps);

    expect(result.kind).toBe("completed_final");

    // Unchanged round behavior: the canonical phase sequence was produced.
    expect(artifactSidecar.map((artifact) => artifact.kind)).toEqual([
      "initial_draft",
      "initial_draft",
      "cross_review",
      "proposed_changes",
      "counter_proposal",
      "resolution_decision",
      "final_answer",
    ]);

    // Every executed turn was admitted through the single scheduler
    // acquisition point inside the WorkflowAgentCaller, and each schema-bearing
    // phase is ONE scheduled semantic operation: 7 phase calls run 14 backend
    // turns (prose work + format), but the scheduler is acquired exactly ONCE
    // per phase (7 acquisitions), so the two turns of a phase cannot be
    // interleaved by a competing same-session writer.
    expect(scripted.requests).toHaveLength(14);
    expect(instrumented.acquisitions).toHaveLength(7);
    expect(
      instrumented.acquisitions.every(
        (request) => request.sessionKey === sessionKey,
      ),
    ).toBe(true);
  });

  it("serializes a schema-bearing phase's work and format turns as one operation: a competing same-session writer cannot interleave between them", async () => {
    // Drives the real production adapter for ONE schema-bearing lane request
    // (the seam that splits prose→format) against the real chain scheduler.
    // The work turn is deferred so a competing same-session write is enqueued
    // while the phase is mid-flight; the single-acquisition contract forces the
    // competitor to queue behind the ENTIRE phase, so the observed order must
    // be work → format → competitor with the format turn adjacent to its work
    // turn. The pre-fix two-acquisition composition released the lock after the
    // work turn, letting the competitor wedge in as work → competitor → format.
    const workflowId = "wf-sched-interleave";
    const sessionKey = "proj::session-interleave";
    const instrumented = makeInstrumentedScheduler();
    const laneService = createLaneService({
      store: createInMemoryLaneStore(),
    });
    await laneService.initialize({
      workflowId,
      laneId: "agent_two",
      backend: "codex",
      ref: null,
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T00:00:00.000Z",
    });

    const order: string[] = [];
    let releaseWorkTurn: () => void = () => undefined;
    const workTurnParked = new Promise<void>((resolve) => {
      releaseWorkTurn = resolve;
    });

    let turnIndex = 0;
    const exec = async (
      request: AgentCallRequest,
    ): Promise<AgentCallResult> => {
      const isWorkTurn = request.outputSchema === undefined;
      if (isWorkTurn) {
        order.push("work_turn_start");
        await workTurnParked;
        order.push("work_turn_end");
      } else {
        order.push("format_turn_end");
      }
      turnIndex += 1;
      const backendRef = { backend: "codex", ref: `th-${turnIndex}` } as const;
      return {
        backend: "codex",
        backendRef,
        capabilities: makeCapabilities("codex"),
        usage: { durationMs: 1 },
        artifacts: [],
        outcome: isWorkTurn
          ? { kind: "completed", text: "prose" }
          : {
              kind: "completed",
              text: "formatted",
              structuredOutput: { ok: true },
            },
      };
    };

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: "/tmp/proj",
      sessionName: "session-interleave",
      worktreePath: workingDir,
      sessionKey,
      originatingConversationId: "conv-origin",
      laneService,
      laneScheduler: instrumented.scheduler,
      agents: {
        agent_one: { backend: "claude", model: "claude-sched-model" },
        agent_two: { backend: "codex", model: "codex-sched-model" },
      },
      executeAgentCallImpl: (request) => exec(request),
      getTaskRunner: () => stubTaskRunner,
      getConversationBackendFactory: () => stubClaudeFactory,
    });

    const phasePromise = callAgent({
      kind: "task_run",
      backend: "codex",
      prompt: "phase prompt",
      laneRef: { workflowId, laneId: "agent_two" },
      writeCapability: "write_capable",
      outputSchema: { type: "object" },
    });

    // Wait until the work turn is parked (phase mid-flight) before enqueuing
    // the competitor.
    await waitUntil(() => order.includes("work_turn_start"));

    const competitorPromise = instrumented.inner.schedule(
      { sessionKey, writeCapability: "write_capable" },
      async () => {
        order.push("competitor");
      },
    );

    // Give any (incorrect) interleaving a chance to happen, then release.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    releaseWorkTurn();

    await phasePromise;
    await competitorPromise;

    // work → format → competitor: the format turn is adjacent to its work
    // turn, and the competitor runs strictly after the whole phase.
    expect(order).toEqual([
      "work_turn_start",
      "work_turn_end",
      "format_turn_end",
      "competitor",
    ]);

    // Exactly ONE acquisition through the collaboration seam for the whole
    // two-turn phase (the competitor contends on `inner`, not the guarded
    // wrapper). A pre-fix two-acquisition composition would record two here.
    expect(instrumented.acquisitions).toHaveLength(1);
  });
});

/** Polls `predicate` on the macrotask queue until it holds. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met within 2000ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
