/**
 * Happy-path pinning test for the cross-review phase. Verifies that:
 *   - Agent Two is dispatched to its backend exactly once with the user
 *     prompt and both drafts.
 *   - The structured output is parsed and tracked.
 *   - Agent backend errors propagate as a failed outcome attributed to
 *     agent_two.
 *
 * No `vi.mock`: deps are wired through in-memory primitives.
 */
import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { runCrossReviewPhase } from "./cross-review";
import {
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
} from "./envelope";
import { EMPTY_COLLABORATION_SESSION_CONTEXT } from "./session-context";
import type { ArtifactTracker } from "./helpers";
import type {
  CollaborationAgent,
  CollaborationArtifact,
  CollaborationCrossReviewOutput,
  CollaborationFlowAgent,
} from "./types";
import {
  makeAgentOneInitialDraft,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
} from "./test-fixtures";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/events/status-bus";

import { asCollaborationAgent } from "@/lib/workflows/collaboration/types";

type Backend = CollaborationAgent;

function makeCompletedResult(
  backend: Backend,
  structuredOutput: CollaborationCrossReviewOutput,
): AgentCallResult {
  return {
    backend,
    backendRef:
      backend === "claude"
        ? { backend: "claude", ref: `sess-${backend}` }
        : { backend: "codex", ref: `th-${backend}` },
    capabilities: {
      backend,
      continuationStrength:
        backend === "claude" ? "precise_session" : "synthetic_thread",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary:
        backend === "claude" ? "between_turns" : "per_request",
      contextMetricsAvailable: backend === "claude",
      nativeMidTurnAskUser: backend === "claude",
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: { kind: "completed", text: "synthetic", structuredOutput },
  };
}

function makeFailedResult(backend: Backend, message: string): AgentCallResult {
  return {
    backend,
    backendRef: null,
    capabilities: {
      backend,
      continuationStrength:
        backend === "claude" ? "precise_session" : "synthetic_thread",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary:
        backend === "claude" ? "between_turns" : "per_request",
      contextMetricsAvailable: backend === "claude",
      nativeMidTurnAskUser: backend === "claude",
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: {
      kind: "failed",
      error: { failureKind: "backend_error", backend, message },
    },
  };
}

function backendOfRequest(request: AgentCallRequest): Backend {
  const backend =
    request.kind === "conversation_turn"
      ? (request.backend ?? "claude")
      : request.backend;
  const agent = asCollaborationAgent(backend);
  if (agent === null) {
    throw new Error(
      `collaboration dispatched an ineligible backend: ${backend}`,
    );
  }
  return agent;
}

async function writeGeneratedFiles(
  worktreePath: string,
  artifact: CollaborationArtifact,
): Promise<void> {
  if (!("artifacts" in artifact)) return;
  for (const ref of artifact.artifacts) {
    const absolutePath = path.join(worktreePath, ref.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `# ${ref.id}\n\n${ref.summary}`, "utf-8");
  }
}

function withWorkflowId<T extends CollaborationArtifact>(
  artifact: T,
  workflowId: string,
): T {
  if (!("artifacts" in artifact)) return artifact;
  return {
    ...artifact,
    artifacts: artifact.artifacts.map((ref) => ({
      ...ref,
      path: ref.path.replace("/wf-fixture/", `/${workflowId}/`),
    })),
  } as T;
}

async function buildTestHarness(
  responses: AgentCallResult[],
  workingDir: string,
): Promise<{
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  tracker: ArtifactTracker;
  receivedRequests: AgentCallRequest[];
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
}> {
  const queue = [...responses];
  const receivedRequests: AgentCallRequest[] = [];

  const laneStore = createInMemoryLaneStore();
  const laneService = createLaneService({ store: laneStore });
  const envelopeStore = createInMemoryWorkflowEnvelopeStore();
  const capturedEnvelopes: StatusBusEnvelope[] = [];
  const statusBus = createStatusBus({
    broadcast: (e) => capturedEnvelopes.push(e),
  });

  const input: AsymmetricCollaborationSliceInput = {
    workflowId: "wf-cross-review-test",
    brief: "Design Z.",
    worktreePath: workingDir,
    sessionKey: "tests/cross-review",
    primaryAgentBackend: "claude",
    negotiationRounds: 1,
    autonomousResolutionThreshold: "major",
    sessionContext: EMPTY_COLLABORATION_SESSION_CONTEXT,
  };

  const deps: AsymmetricCollaborationSliceDeps = {
    callAgent: async (request) => {
      receivedRequests.push(request);
      const next = queue.shift();
      if (!next) throw new Error("no scripted response remaining");
      return next;
    },
    laneService,
    envelopeStore,
    statusBus,
    now: () => "2026-05-01T00:00:00.000Z",
  };

  const lanes: LaneState[] = [
    {
      workflowId: input.workflowId,
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-05-01T00:00:00.000Z",
    },
    {
      workflowId: input.workflowId,
      laneId: "agent_two",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-05-01T00:00:00.000Z",
    },
  ];
  for (const lane of lanes) await laneService.initialize(lane);

  await envelopeStore.upsert(input.workflowId, () => ({
    workflowId: input.workflowId,
    workflowType: "collaboration",
    status: "running",
    phase: "asymmetric_cross_review",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    featureSnapshot: {},
  }));

  const tracker: ArtifactTracker = {
    artifacts: [],
    negotiationRoundsCompleted: 0,
  };
  const backendForAgent = (
    agent: CollaborationFlowAgent,
  ): CollaborationAgent => (agent === "agent_one" ? "claude" : "codex");

  return { input, deps, tracker, receivedRequests, backendForAgent };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-cross-"));
});

describe("runCrossReviewPhase", () => {
  it("dispatches Agent Two to its backend once, returns the parsed cross-review, and tracks the artifact", async () => {
    const crossReviewFixture = withWorkflowId(
      makeAgentTwoCrossReview(),
      "wf-cross-review-test",
    );
    await writeGeneratedFiles(workingDir, crossReviewFixture);
    const harness = await buildTestHarness(
      [makeCompletedResult("codex", crossReviewFixture)],
      workingDir,
    );

    const outcome = await runCrossReviewPhase({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.crossReview).toEqual(crossReviewFixture);
    expect(harness.tracker.artifacts).toEqual([crossReviewFixture]);

    expect(harness.receivedRequests).toHaveLength(1);
    expect(backendOfRequest(harness.receivedRequests[0]!)).toBe("codex");
  });

  it("returns a failed outcome attributed to agent_two when the backend call fails", async () => {
    const harness = await buildTestHarness(
      [makeFailedResult("codex", "transport lost")],
      workingDir,
    );

    const outcome = await runCrossReviewPhase({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.result.agent).toBe("agent_two");
    expect(outcome.result.errorSummary).toContain("transport lost");
    expect(harness.tracker.artifacts).toEqual([]);
  });
});
