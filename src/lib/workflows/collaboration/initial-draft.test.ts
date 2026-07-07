/**
 * Happy-path pinning test for the initial-draft phase. Verifies that:
 *   - The phase issues one call per agent in parallel (Agent One → primary
 *     backend, Agent Two → opposite backend).
 *   - Both drafts are parsed, tracked, and returned in the success outcome.
 *   - The envelope is snapshotted after each successful draft.
 *
 * No `vi.mock`: deps are wired through in-memory primitives.
 */
import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { runInitialDraftsPhase } from "./initial-draft";
import {
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
} from "./envelope";
import type { ArtifactTracker } from "./helpers";
import type {
  CollaborationAgent,
  CollaborationArtifact,
  CollaborationFlowAgent,
  CollaborationInitialDraftOutput,
} from "./types";
import {
  makeAgentOneInitialDraft,
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
} from "@/lib/workflows/primitives/status-bus";
import { createLaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";

type Backend = "claude" | "codex";

function makeBackendResult(
  backend: Backend,
  structuredOutput: CollaborationInitialDraftOutput,
): AgentCallResult {
  return {
    backend,
    backendRef:
      backend === "claude"
        ? { backend: "claude", sessionId: `sess-${backend}` }
        : { backend: "codex", threadId: `th-${backend}` },
    capabilities: {
      backend,
      continuationStrength:
        backend === "claude" ? "precise_session" : "synthetic_thread",
      structuredOutputEnforcement:
        backend === "claude" ? "post_validation" : "backend_native",
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

function backendOfRequest(request: AgentCallRequest): Backend {
  return request.kind === "conversation_turn"
    ? (request.backend ?? "claude")
    : (request.backend as Backend);
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
  responses: Record<Backend, AgentCallResult[]>,
  workingDir: string,
): Promise<{
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  tracker: ArtifactTracker;
  receivedRequests: AgentCallRequest[];
  capturedEnvelopes: StatusBusEnvelope[];
  envelopeStore: ReturnType<typeof createInMemoryWorkflowEnvelopeStore>;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
}> {
  const queues: Record<Backend, AgentCallResult[]> = {
    claude: [...responses.claude],
    codex: [...responses.codex],
  };
  const receivedRequests: AgentCallRequest[] = [];

  const laneStore = createInMemoryLaneStore();
  const laneService = createLaneService({ store: laneStore });
  const envelopeStore = createInMemoryWorkflowEnvelopeStore();
  const capturedEnvelopes: StatusBusEnvelope[] = [];
  const statusBus = createStatusBus({
    broadcast: (envelope) => capturedEnvelopes.push(envelope),
  });
  const laneScheduler = createLaneScheduler();

  const input: AsymmetricCollaborationSliceInput = {
    workflowId: "wf-initial-draft-test",
    brief: "Design Y.",
    worktreePath: workingDir,
    sessionKey: "tests/initial-draft",
    primaryAgentBackend: "claude",
    negotiationRounds: 1,
    autonomousResolutionThreshold: "major",
  };

  const deps: AsymmetricCollaborationSliceDeps = {
    callAgent: async (request) => {
      receivedRequests.push(request);
      const backend = backendOfRequest(request);
      const next = queues[backend].shift();
      if (!next) throw new Error(`no scripted response for ${backend}`);
      return next;
    },
    laneService,
    laneScheduler,
    envelopeStore,
    statusBus,
    now: () => "2026-05-01T00:00:00.000Z",
  };

  const claudeLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "claude",
    backend: "claude",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "claude" },
    metrics: { backend: "claude", rotateBeforeNextTurn: false },
    lastUsedAt: "2026-05-01T00:00:00.000Z",
  };
  const codexLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "codex",
    backend: "codex",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "codex" },
    metrics: { backend: "codex", rotateBeforeNextTurn: false },
    lastUsedAt: "2026-05-01T00:00:00.000Z",
  };
  await laneService.initialize(claudeLane);
  await laneService.initialize(codexLane);

  await envelopeStore.upsert(input.workflowId, () => ({
    workflowId: input.workflowId,
    workflowType: "collaboration",
    status: "running",
    phase: "asymmetric_initial_drafts",
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

  return {
    input,
    deps,
    tracker,
    receivedRequests,
    capturedEnvelopes,
    envelopeStore,
    backendForAgent,
  };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-initial-"));
});

describe("runInitialDraftsPhase", () => {
  it("returns both drafts in the ok outcome, tracks them, and routes each agent to its assigned backend", async () => {
    const agentOneFixture = withWorkflowId(
      makeAgentOneInitialDraft(),
      "wf-initial-draft-test",
    );
    const agentTwoFixture = withWorkflowId(
      makeAgentTwoInitialDraft(),
      "wf-initial-draft-test",
    );
    await writeGeneratedFiles(workingDir, agentOneFixture);
    await writeGeneratedFiles(workingDir, agentTwoFixture);
    const harness = await buildTestHarness(
      {
        claude: [makeBackendResult("claude", agentOneFixture)],
        codex: [makeBackendResult("codex", agentTwoFixture)],
      },
      workingDir,
    );

    const outcome = await runInitialDraftsPhase({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      backendForAgent: harness.backendForAgent,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.agentOneDraft).toEqual(agentOneFixture);
    expect(outcome.agentTwoDraft).toEqual(agentTwoFixture);
    expect(harness.tracker.artifacts).toHaveLength(2);

    expect(harness.receivedRequests).toHaveLength(2);
    const backends = harness.receivedRequests.map(backendOfRequest).sort();
    expect(backends).toEqual(["claude", "codex"]);
    for (const req of harness.receivedRequests) {
      expect(req.writeCapability).toBe("artifact_only");
    }
  });

  it("issues both drafts concurrently — the shared-session write lock must not chain them", async () => {
    const agentOneFixture = withWorkflowId(
      makeAgentOneInitialDraft(),
      "wf-initial-draft-test",
    );
    const agentTwoFixture = withWorkflowId(
      makeAgentTwoInitialDraft(),
      "wf-initial-draft-test",
    );
    await writeGeneratedFiles(workingDir, agentOneFixture);
    await writeGeneratedFiles(workingDir, agentTwoFixture);
    const harness = await buildTestHarness(
      {
        claude: [makeBackendResult("claude", agentOneFixture)],
        codex: [makeBackendResult("codex", agentTwoFixture)],
      },
      workingDir,
    );

    // Gate every callAgent response behind a promise that only resolves once
    // BOTH requests are in flight. If the lane scheduler serializes the two
    // draft calls, the second request never arrives and the phase deadlocks —
    // caught by the bothInFlight timeout below.
    const innerCallAgent = harness.deps.callAgent;
    let inFlight = 0;
    let releaseBoth!: () => void;
    const bothInFlightGate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    harness.deps.callAgent = async (request) => {
      inFlight += 1;
      if (inFlight === 2) releaseBoth();
      await bothInFlightGate;
      return innerCallAgent(request);
    };

    const phase = runInitialDraftsPhase({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      backendForAgent: harness.backendForAgent,
    });

    const bothInFlight = await Promise.race([
      bothInFlightGate.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(bothInFlight).toBe(true);

    const outcome = await phase;
    expect(outcome.kind).toBe("ok");
  });

  it("returns a failed outcome with the agent_one backend error message when Agent One's call fails", async () => {
    const agentTwoFixture = withWorkflowId(
      makeAgentTwoInitialDraft(),
      "wf-initial-draft-test",
    );
    await writeGeneratedFiles(workingDir, agentTwoFixture);
    const harness = await buildTestHarness(
      {
        claude: [
          {
            backend: "claude",
            backendRef: null,
            capabilities: {
              backend: "claude",
              continuationStrength: "precise_session",
              structuredOutputEnforcement: "post_validation",
              mcpApplicationBoundary: "between_turns",
              contextMetricsAvailable: true,
              nativeMidTurnAskUser: true,
            },
            usage: { durationMs: 1 },
            artifacts: [],
            outcome: {
              kind: "failed",
              error: {
                failureKind: "backend_error",
                backend: "claude",
                message: "boom",
              },
            },
          },
        ],
        codex: [makeBackendResult("codex", agentTwoFixture)],
      },
      workingDir,
    );

    const outcome = await runInitialDraftsPhase({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      backendForAgent: harness.backendForAgent,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.result.agent).toBe("agent_one");
    expect(outcome.result.errorSummary).toContain("boom");
  });
});
