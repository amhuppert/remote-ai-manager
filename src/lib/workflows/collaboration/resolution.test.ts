/**
 * Happy-path pinning tests for the two Agent-One negotiation-round steps:
 *   - `runProposedChangesStep` — emits `proposed_changes` against both drafts.
 *   - `runResolutionDecisionStep` — emits `resolution_decision` against the
 *     LATEST counter-proposal of the current round.
 *
 * Each test verifies dispatch to the primary backend, structured-output
 * parsing, artifact tracking, and the failed-outcome branch on backend errors.
 *
 * No `vi.mock`: deps are wired through in-memory primitives.
 */
import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import {
  runProposedChangesStep,
  runResolutionDecisionStep,
} from "./resolution";
import {
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
} from "./envelope";
import { EMPTY_COLLABORATION_SESSION_CONTEXT } from "./session-context";
import type { ArtifactTracker } from "./helpers";
import type {
  CollaborationAgent,
  CollaborationArtifact,
  CollaborationFlowAgent,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
} from "./types";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoInitialDraft,
  makeResolutionDecisionFinal,
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
  structuredOutput:
    | CollaborationProposedChangesOutput
    | CollaborationResolutionDecisionOutput,
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
    workflowId: "wf-resolution-test",
    brief: "Design Z.",
    worktreePath: workingDir,
    sessionKey: "tests/resolution",
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

  for (const lane of [
    {
      workflowId: input.workflowId,
      laneId: "agent_one" as const,
      backend: "claude" as const,
      writeCapability: "write_capable" as const,
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-05-01T00:00:00.000Z",
    },
    {
      workflowId: input.workflowId,
      laneId: "agent_two" as const,
      backend: "codex" as const,
      writeCapability: "write_capable" as const,
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-05-01T00:00:00.000Z",
    },
  ] satisfies LaneState[]) {
    await laneService.initialize(lane);
  }

  await envelopeStore.upsert(input.workflowId, () => ({
    workflowId: input.workflowId,
    workflowType: "collaboration",
    status: "running",
    phase: "asymmetric_negotiation",
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
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-resolution-"));
});

describe("runProposedChangesStep", () => {
  it("dispatches Agent One once to the primary backend, returns the parsed proposed_changes, and tracks it", async () => {
    const proposedFixture = withWorkflowId(
      makeAgentOneProposedChanges(),
      "wf-resolution-test",
    );
    await writeGeneratedFiles(workingDir, proposedFixture);
    const harness = await buildTestHarness(
      [makeCompletedResult("claude", proposedFixture)],
      workingDir,
    );

    const outcome = await runProposedChangesStep({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
      round: 1,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.proposedChanges).toEqual(proposedFixture);
    expect(harness.tracker.artifacts).toEqual([proposedFixture]);

    expect(harness.receivedRequests).toHaveLength(1);
    expect(backendOfRequest(harness.receivedRequests[0]!)).toBe("claude");
  });

  it("returns a failed outcome attributed to agent_one on backend failure", async () => {
    const harness = await buildTestHarness(
      [makeFailedResult("claude", "rate limited")],
      workingDir,
    );

    const outcome = await runProposedChangesStep({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
      round: 1,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.result.agent).toBe("agent_one");
    expect(outcome.result.errorSummary).toContain("rate limited");
    expect(harness.tracker.artifacts).toEqual([]);
  });
});

describe("runResolutionDecisionStep", () => {
  it("dispatches Agent One once to the primary backend, returns the parsed resolution_decision, and tracks it", async () => {
    const resolutionFixture = withWorkflowId(
      makeResolutionDecisionFinal(),
      "wf-resolution-test",
    );
    await writeGeneratedFiles(workingDir, resolutionFixture);
    const harness = await buildTestHarness(
      [makeCompletedResult("claude", resolutionFixture)],
      workingDir,
    );

    const outcome = await runResolutionDecisionStep({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
      proposedChanges: makeAgentOneProposedChanges(),
      counterProposal: makeAgentTwoCounterProposalRound1(),
      round: 1,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.resolution).toEqual(resolutionFixture);
    expect(harness.tracker.artifacts).toEqual([resolutionFixture]);

    expect(harness.receivedRequests).toHaveLength(1);
    expect(backendOfRequest(harness.receivedRequests[0]!)).toBe("claude");
  });

  it("returns a failed outcome attributed to agent_one on backend failure", async () => {
    const harness = await buildTestHarness(
      [makeFailedResult("claude", "auth expired")],
      workingDir,
    );

    const outcome = await runResolutionDecisionStep({
      input: harness.input,
      deps: harness.deps,
      now: harness.deps.now!,
      tracker: harness.tracker,
      ledger: null,
      backendForAgent: harness.backendForAgent,
      agentOneDraft: makeAgentOneInitialDraft(),
      agentTwoDraft: makeAgentTwoInitialDraft(),
      proposedChanges: makeAgentOneProposedChanges(),
      counterProposal: makeAgentTwoCounterProposalRound1(),
      round: 1,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.result.agent).toBe("agent_one");
    expect(outcome.result.errorSummary).toContain("auth expired");
    expect(harness.tracker.artifacts).toEqual([]);
  });
});
