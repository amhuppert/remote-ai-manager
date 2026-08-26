/**
 * Tests for the asymmetric Collaboration Mode slice (Agent One/Two flow).
 *
 * The slice composes the existing primitive layer (AgentCall, Lane,
 * ArtifactRegistry, StatusBus, WorkflowEnvelope, HumanApprovalGate) for the
 * primary-led negotiation state machine described in
 * `memory-bank/COLLABORATION_MODE_FLOW.md` and
 * `memory-bank/COLLABORATION_MODE_IMPLEMENTATION_PLAN.md` phases 3-5.
 *
 *  - Round 0 (parallel): Agent One and Agent Two each emit an `initial_draft`.
 *  - Round 0.5 (Agent Two only): Agent Two emits a `cross_review` against
 *    Agent One's draft (saved to the output zone, not delivered to Agent One).
 *  - Negotiation round n: Agent One emits `proposed_changes` (targets
 *    agent_two), Agent Two emits `counter_proposal` (incorporates its
 *    cross-review and Agent One's proposed changes), Agent One emits
 *    `resolution_decision` (must read the LATEST counter-proposal of the
 *    current round, never an earlier one).
 *  - Policy edges (see `policy.ts`) interpret the resolution decision against
 *    `autonomousResolutionThreshold` plus the disagreement category/severity
 *    to choose: continue another negotiation round, write `final_answer`,
 *    pause for user via `open_conflicts`, or fail the run.
 *  - Agent failure (One or Two) terminally fails the workflow.
 *
 * No `vi.mock`. All deps are injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type {
  CollaborationAgentsMap,
  CollaborationArtifact,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationInitialDraftOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
} from "./types";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeBlockingImplementationDisagreement,
  makeFinalAnswer,
  makeImplementationDisagreement,
  makeObjectiveDisagreement,
  makeOpenConflicts,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
  makeUserQuestion,
} from "./test-fixtures";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/events/status-bus";

import {
  asCollaborationAgent,
  type CollaborationAgent,
} from "@/lib/workflows/collaboration/types";

type Backend = CollaborationAgent;

type ArtifactKind =
  | CollaborationInitialDraftOutput
  | CollaborationCrossReviewOutput
  | CollaborationProposedChangesOutput
  | CollaborationCounterProposalOutput
  | CollaborationResolutionDecisionOutput
  | CollaborationFinalAnswerOutput;

interface ScriptedAgentCall {
  backend: Backend;
  callAgent: AsymmetricCollaborationSliceDeps["callAgent"];
  receivedRequests: AgentCallRequest[];
}

function makeBackendResult(
  backend: Backend,
  structuredOutput: ArtifactKind,
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
      structuredOutputEnforcement:
        backend === "claude" ? "post_validation" : "backend_native",
      mcpApplicationBoundary:
        backend === "claude" ? "between_turns" : "per_request",
      contextMetricsAvailable: backend === "claude",
      nativeMidTurnAskUser: backend === "claude",
    },
    usage: { durationMs: 100 },
    artifacts: [],
    outcome: {
      kind: "completed",
      text: "synthetic",
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

function hasGeneratedArtifactFiles(value: unknown): value is ArtifactKind & {
  artifacts: NonNullable<ArtifactKind["artifacts"]>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "artifacts" in value &&
    Array.isArray((value as { artifacts?: unknown }).artifacts)
  );
}

function prepareBackendResultForRequest(
  result: AgentCallResult,
  request: AgentCallRequest,
): AgentCallResult {
  if (result.outcome.kind !== "completed") return result;
  const structuredOutput = result.outcome.structuredOutput;
  if (!structuredOutput || typeof structuredOutput !== "object") return result;

  const workflowId = request.laneRef?.workflowId ?? "wf-asym";
  const rehomedOutput = rehomeGeneratedArtifactPaths(
    structuredOutput,
    workflowId,
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

function materializeGeneratedFiles(structuredOutput: unknown): void {
  if (!hasGeneratedArtifactFiles(structuredOutput)) return;
  for (const ref of structuredOutput.artifacts) {
    const absolutePath = path.join(workingDir, ref.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const content =
      structuredOutput.kind === "final_answer" &&
      ref.id === structuredOutput.answer_artifact_id
        ? structuredOutput.summary
        : `# ${ref.id}\n\n${structuredOutput.kind} ${ref.artifact_type}\n`;
    writeFileSync(absolutePath, content, "utf-8");
  }
}

function makeFailedResult(backend: Backend, message: string): AgentCallResult {
  return {
    backend,
    backendRef: null,
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
    usage: { durationMs: 5 },
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

function makeProgrammedCallAgent(
  responsesByBackend: Record<Backend, AgentCallResult[]>,
): ScriptedAgentCall {
  const queues: Record<Backend, AgentCallResult[]> = {
    claude: [...responsesByBackend.claude],
    codex: [...responsesByBackend.codex],
  };
  const receivedRequests: AgentCallRequest[] = [];

  const callAgent: AsymmetricCollaborationSliceDeps["callAgent"] = async (
    request,
  ) => {
    receivedRequests.push(request);
    const requestedBackend =
      request.kind === "conversation_turn"
        ? (request.backend ?? "claude")
        : request.backend;
    const backend = asCollaborationAgent(requestedBackend);
    if (backend === null) {
      throw new Error(
        `collaboration dispatched an ineligible backend: ${requestedBackend}`,
      );
    }
    const queue = queues[backend];
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `programmed call-agent ran out of responses for backend "${backend}" (received so far: ${receivedRequests.length})`,
      );
    }
    return prepareBackendResultForRequest(next, request);
  };

  return { backend: "claude", callAgent, receivedRequests };
}

interface BuiltDeps {
  deps: AsymmetricCollaborationSliceDeps;
  capturedEnvelopes: StatusBusEnvelope[];
  envelopeStore: ReturnType<typeof createInMemoryWorkflowEnvelopeStore>;
  capturedPushDispatches: Array<
    Parameters<NonNullable<AsymmetricCollaborationSliceDeps["dispatchPush"]>>[0]
  >;
  /**
   * In-memory stand-in for the durable JSONL artifacts sidecar, keyed by
   * workflowId. `appendArtifact` pushes here; `readArtifacts` reads back in
   * append order. Tests seed it to drive the resume path and read it to assert
   * the artifact stream now lives in the sidecar, not the envelope blob.
   */
  artifactSidecar: Map<string, CollaborationArtifact[]>;
  /** Conversation-ownership releases, in order. A collaboration that ends
   *  without one leaves the user unable to prompt in their own conversation. */
  releasedOwners: Array<{
    conversationId: string;
    owner: { workflowId: string; attemptEpoch: number };
  }>;
}

async function buildDeps(
  programmed: ScriptedAgentCall,
  options: {
    appendTranscriptEntry?: AsymmetricCollaborationSliceDeps["appendTranscriptEntry"];
    markConversationAwaiting?: (
      conversationId: string,
      input: { workflowId: string; timestamp: string },
    ) => Promise<unknown>;
    updateConversationBackendRef?: AsymmetricCollaborationSliceDeps["updateConversationBackendRef"];
    laneService?: ReturnType<typeof createLaneService>;
  } = {},
): Promise<
  BuiltDeps & {
    laneService: ReturnType<typeof createLaneService>;
  }
> {
  const laneStore = createInMemoryLaneStore();
  const laneService =
    options.laneService ?? createLaneService({ store: laneStore });
  const envelopeStore = createInMemoryWorkflowEnvelopeStore();

  const capturedEnvelopes: StatusBusEnvelope[] = [];
  const statusBus = createStatusBus({
    broadcast: (envelope) => capturedEnvelopes.push(envelope),
  });

  const capturedPushDispatches: Array<
    Parameters<NonNullable<AsymmetricCollaborationSliceDeps["dispatchPush"]>>[0]
  > = [];

  const artifactSidecar = new Map<string, CollaborationArtifact[]>();
  const releasedOwners: BuiltDeps["releasedOwners"] = [];

  const deps: AsymmetricCollaborationSliceDeps = {
    callAgent: programmed.callAgent,
    laneService,
    envelopeStore,
    statusBus,
    now: () => "2026-04-28T10:00:00.000Z",
    dispatchPush: (info) => {
      capturedPushDispatches.push(info);
    },
    appendArtifact: async (workflowId, artifact) => {
      const existing = artifactSidecar.get(workflowId) ?? [];
      existing.push(artifact);
      artifactSidecar.set(workflowId, existing);
    },
    releaseConversationOwner: async (conversationId, owner) => {
      releasedOwners.push({ conversationId, owner });
      return true;
    },
    readArtifactStream: async (workflowId: string) => {
      const entries = artifactSidecar.get(workflowId);
      if (entries === undefined) return { kind: "absent" as const };
      return { kind: "ok" as const, entries: [...entries], skipped: [] };
    },
    ...(options.appendTranscriptEntry
      ? { appendTranscriptEntry: options.appendTranscriptEntry }
      : {}),
    ...(options.markConversationAwaiting
      ? { markConversationAwaiting: options.markConversationAwaiting }
      : {}),
    ...(options.updateConversationBackendRef
      ? { updateConversationBackendRef: options.updateConversationBackendRef }
      : {}),
  };

  return {
    deps,
    capturedEnvelopes,
    envelopeStore,
    capturedPushDispatches,
    laneService,
    artifactSidecar,
    releasedOwners,
  };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-asym-"));
});

function baseInput(
  overrides: Partial<AsymmetricCollaborationSliceInput> = {},
): AsymmetricCollaborationSliceInput {
  return {
    workflowId: "wf-asym",
    brief: "Design X.",
    worktreePath: workingDir,
    sessionKey: "tests/asym",
    primaryAgentBackend: "claude",
    negotiationRounds: 3,
    autonomousResolutionThreshold: "major",
    sessionContext: EMPTY_COLLABORATION_SESSION_CONTEXT,
    ...overrides,
  };
}

describe("runAsymmetricCollaborationSlice — initial draft phase", () => {
  it("routes agent_one to codex and agent_two to claude when primaryAgentBackend is codex", async () => {
    const programmed = makeProgrammedCallAgent({
      codex: [
        makeBackendResult("codex", makeAgentOneInitialDraft()),
        makeBackendResult("codex", makeAgentOneProposedChanges()),
        makeBackendResult(
          "codex",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("codex", makeFinalAnswer()),
      ],
      claude: [
        makeBackendResult("claude", makeAgentTwoInitialDraft()),
        makeBackendResult("claude", makeAgentTwoCrossReview()),
        makeBackendResult("claude", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ primaryAgentBackend: "codex" }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");

    const initialRequests = programmed.receivedRequests.slice(0, 2);
    const initialBackends = initialRequests
      .map((req) =>
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend,
      )
      .sort();
    expect(initialBackends).toEqual(["claude", "codex"]);
  });

  it("runs Agent One and Agent Two initial drafts as artifact-only calls so both can create generated artifacts concurrently", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    const initialRequests = programmed.receivedRequests.slice(0, 2);
    const initialBackends = initialRequests
      .slice(0, 2)
      .map((req) =>
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend,
      )
      .sort();
    expect(initialBackends).toEqual(["claude", "codex"]);
    for (const request of initialRequests) {
      expect(request.writeCapability).toBe("artifact_only");
    }
  });
});

describe("runAsymmetricCollaborationSlice — negotiation message routing", () => {
  it("includes Agent Two's initial draft inside Agent One's proposed_changes prompt and excludes Agent Two's cross-review (cross-review is not delivered to Agent One)", async () => {
    const agentTwoDraft = makeAgentTwoInitialDraft({
      summary: "AGENT_TWO_INITIAL_NARRATIVE_MARKER",
    });
    const agentTwoCrossReview = makeAgentTwoCrossReview({
      summary: "AGENT_TWO_CROSS_REVIEW_MARKER",
    });

    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", agentTwoDraft),
        makeBackendResult("codex", agentTwoCrossReview),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    await runAsymmetricCollaborationSlice(baseInput(), built.deps);

    // Agent One's proposed_changes call is the third claude request
    // (after initial draft, NOT cross-review which is agent_two's).
    const claudeRequests = programmed.receivedRequests.filter((req) => {
      const backend =
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend;
      return backend === "claude";
    });
    expect(claudeRequests.length).toBeGreaterThanOrEqual(2);
    const proposedChangesPrompt = claudeRequests[1]?.prompt ?? "";
    expect(proposedChangesPrompt).toContain(
      "AGENT_TWO_INITIAL_NARRATIVE_MARKER",
    );
    expect(proposedChangesPrompt).not.toContain(
      "AGENT_TWO_CROSS_REVIEW_MARKER",
    );
  });

  it("Agent Two's counter_proposal prompt includes its own cross-review AND Agent One's proposed changes", async () => {
    const agentTwoCrossReview = makeAgentTwoCrossReview({
      summary: "CROSS_REVIEW_VISIBLE_TO_TWO",
    });
    const agentOneProposedChanges = makeAgentOneProposedChanges({
      summary: "PROPOSED_CHANGES_VISIBLE_TO_TWO",
    });

    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", agentOneProposedChanges),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", agentTwoCrossReview),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    await runAsymmetricCollaborationSlice(baseInput(), built.deps);

    // The counter_proposal request to codex is the third codex request.
    const codexRequests = programmed.receivedRequests.filter((req) => {
      const backend =
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend;
      return backend === "codex";
    });
    expect(codexRequests.length).toBeGreaterThanOrEqual(3);
    const counterProposalPrompt = codexRequests[2]?.prompt ?? "";
    expect(counterProposalPrompt).toContain("CROSS_REVIEW_VISIBLE_TO_TWO");
    expect(counterProposalPrompt).toContain("PROPOSED_CHANGES_VISIBLE_TO_TWO");
  });
});

describe("runAsymmetricCollaborationSlice — resolution sees latest counter-proposal", () => {
  it("Agent One's resolution_decision prompt in round 2 includes Agent Two's round 2 counter-proposal — never the round 1 one (regression boundary)", async () => {
    const round1Counter = makeAgentTwoCounterProposalRound1({
      summary: "ROUND_1_COUNTER_NARRATIVE",
    });
    const round2Counter = makeAgentTwoCounterProposalRound2({
      summary: "ROUND_2_COUNTER_NARRATIVE",
    });

    const programmed = makeProgrammedCallAgent({
      claude: [
        // Initial draft.
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        // Round 1 proposed_changes.
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        // Round 1 resolution: continue (impl disagreement remaining).
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeImplementationDisagreement()],
          }),
        ),
        // Round 2 proposed_changes.
        makeBackendResult("claude", makeAgentOneProposedChanges({ round: 2 })),
        // Round 2 resolution: final.
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            remaining_disagreements: [],
            round: 2,
          }),
        ),
        // Final answer.
        makeBackendResult("claude", makeFinalAnswer({ round: 2 })),
      ],
      codex: [
        // Initial draft.
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        // Cross-review (one-time).
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        // Round 1 counter.
        makeBackendResult("codex", round1Counter),
        // Round 2 counter.
        makeBackendResult("codex", round2Counter),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ negotiationRounds: 3 }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");

    const claudeRequests = programmed.receivedRequests.filter((req) => {
      const backend =
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend;
      return backend === "claude";
    });
    // claudeRequests order:
    //   [0] initial_draft
    //   [1] round 1 proposed_changes
    //   [2] round 1 resolution_decision
    //   [3] round 2 proposed_changes
    //   [4] round 2 resolution_decision
    //   [5] final_answer
    const round2ResolutionPrompt = claudeRequests[4]?.prompt ?? "";
    expect(round2ResolutionPrompt).toContain("ROUND_2_COUNTER_NARRATIVE");
    expect(round2ResolutionPrompt).not.toContain("ROUND_1_COUNTER_NARRATIVE");
  });
});

describe("runAsymmetricCollaborationSlice — policy edges", () => {
  it("forces ask_user when Agent One's resolution surfaces an objective disagreement (objective category always halts)", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeObjectiveDisagreement()],
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const updateConversationBackendRef = vi.fn(async () => {});
    const built = await buildDeps(programmed, {
      updateConversationBackendRef,
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        autonomousResolutionThreshold: "blocking",
        conversationId: "conv-1",
        negotiationRounds: 5,
      }),
      built.deps,
    );

    expect(result.kind).toBe("paused_for_user_input");
    if (result.kind !== "paused_for_user_input") return;
    expect(result.resumeToken).toBeTruthy();
    expect(updateConversationBackendRef).not.toHaveBeenCalled();
  });

  it("loops into another negotiation round when Agent One's resolution returns continue_negotiation with implementation disagreements and rounds remain", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        // Round 1 proposed_changes.
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        // Round 1 resolution: continue (impl disagreement remains, rounds remain).
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeImplementationDisagreement()],
          }),
        ),
        // Round 2 proposed_changes.
        makeBackendResult("claude", makeAgentOneProposedChanges({ round: 2 })),
        // Round 2 resolution: final.
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            remaining_disagreements: [],
            round: 2,
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer({ round: 2 })),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound2()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ negotiationRounds: 5 }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    if (result.kind !== "completed_final") return;
    expect(result.negotiationRoundsCompleted).toBe(2);
  });

  it("asks the user when the final negotiation round still has implementation disagreements above the autonomous threshold", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        // Final round resolution: continue is requested, but no rounds remain
        // and major exceeds minor threshold → policy forces ask_user.
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeImplementationDisagreement()],
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        negotiationRounds: 1,
        autonomousResolutionThreshold: "minor",
      }),
      built.deps,
    );

    expect(result.kind).toBe("paused_for_user_input");
  });

  it("finalizes when the final negotiation round still has implementation disagreements at or below the autonomous threshold", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        // Continue requested, but no rounds remain and major <= major threshold
        // → policy forces final.
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeImplementationDisagreement()],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        negotiationRounds: 1,
        autonomousResolutionThreshold: "major",
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
  });

  it("only finalizes a remaining blocking implementation disagreement when threshold is blocking", async () => {
    const programmedWithMajorThreshold = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeBlockingImplementationDisagreement()],
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const builtMajor = await buildDeps(programmedWithMajorThreshold);

    const askResult = await runAsymmetricCollaborationSlice(
      baseInput({
        negotiationRounds: 1,
        autonomousResolutionThreshold: "major",
      }),
      builtMajor.deps,
    );

    expect(askResult.kind).toBe("paused_for_user_input");

    const programmedWithBlockingThreshold = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeBlockingImplementationDisagreement()],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const builtBlocking = await buildDeps(programmedWithBlockingThreshold);

    const finalResult = await runAsymmetricCollaborationSlice(
      baseInput({
        workflowId: "wf-asym-2",
        negotiationRounds: 1,
        autonomousResolutionThreshold: "blocking",
      }),
      builtBlocking.deps,
    );

    expect(finalResult.kind).toBe("completed_final");
  });
});

describe("runAsymmetricCollaborationSlice — agent failures", () => {
  it("fails the workflow when Agent One's initial draft call fails", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [makeFailedResult("claude", "synthetic agent_one failure")],
      codex: [makeBackendResult("codex", makeAgentTwoInitialDraft())],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.agent).toBe("agent_one");
  });

  it("marks the originating conversation awaiting when a structured-output parse failure fails the run", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", {
          kind: "initial_draft",
          agent: "agent_one",
        } as unknown as CollaborationInitialDraftOutput),
      ],
      codex: [makeBackendResult("codex", makeAgentTwoInitialDraft())],
    });
    const metadataCalls: Array<{
      conversationId: string;
      workflowId: string;
      timestamp: string;
    }> = [];
    const built = await buildDeps(programmed, {
      markConversationAwaiting: async (conversationId, input) => {
        metadataCalls.push({ conversationId, ...input });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ conversationId: "conv-1" }),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    expect(metadataCalls).toEqual([
      {
        conversationId: "conv-1",
        workflowId: "wf-asym",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    ]);
  });

  it("fails the workflow when Agent Two's counter-proposal call fails", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeFailedResult("codex", "synthetic agent_two counter failure"),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.agent).toBe("agent_two");
  });
});

describe("runAsymmetricCollaborationSlice — artifact sidecar persistence", () => {
  it("appends every emitted artifact to the sidecar in chronological order on completed_final, and keeps the envelope blob free of the artifacts array", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");

    const stored = await built.envelopeStore.read("wf-asym");
    expect(stored).toBeTruthy();
    if (!stored) return;

    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["artifacts"]).toBeUndefined();

    const artifacts = built.artifactSidecar.get("wf-asym") ?? [];
    const kindsAndAgents = artifacts.map((a) => ({
      kind: a.kind,
      agent: "agent" in a ? a.agent : null,
    }));
    expect(kindsAndAgents).toEqual([
      { kind: "initial_draft", agent: "agent_one" },
      { kind: "initial_draft", agent: "agent_two" },
      { kind: "cross_review", agent: "agent_two" },
      { kind: "proposed_changes", agent: "agent_one" },
      { kind: "counter_proposal", agent: "agent_two" },
      { kind: "resolution_decision", agent: "agent_one" },
      { kind: "final_answer", agent: "agent_one" },
    ]);
  });

  it("records the primary agent backend, negotiation rounds, threshold, and rounds completed on the snapshot", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      }),
      built.deps,
    );

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["primaryAgentBackend"]).toBe("claude");
    expect(snapshot["negotiationRounds"]).toBe(3);
    expect(snapshot["negotiationRoundsCompleted"]).toBe(1);
    expect(snapshot["autonomousResolutionThreshold"]).toBe("major");
    // An input without a resolved agents map writes none.
    expect(snapshot["agents"]).toBeUndefined();
  });

  it("records the per-flow-agent agents map on the snapshot when the input carries it", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const agents: CollaborationAgentsMap = {
      agent_one: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      },
      agent_two: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    };
    await runAsymmetricCollaborationSlice(baseInput({ agents }), built.deps);

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["agents"]).toEqual({
      agent_one: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      },
      agent_two: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    });
  });

  it("preserves all artifacts emitted before the agent failure in the failed envelope's snapshot", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeFailedResult("codex", "synthetic counter failure"),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("failed");

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    expect(stored.status).toBe("failed");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["artifacts"]).toBeUndefined();
    const artifacts = built.artifactSidecar.get("wf-asym") ?? [];
    const kinds = artifacts.map((a) => a.kind);
    expect(kinds).toEqual([
      "initial_draft",
      "initial_draft",
      "cross_review",
      "proposed_changes",
    ]);
  });

  // Regression: when one initial-draft call fails in parallel with a
  // successful peer, the slice MUST still track and persist the successful
  // peer's artifact on the failed envelope snapshot. Otherwise the inline
  // collab UI shows an empty failed run even though the surviving agent's
  // draft was produced.
  it("preserves the successful peer's initial draft on the failed envelope snapshot when the other agent's initial draft fails in parallel", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeFailedResult("claude", "synthetic agent_one initial failure"),
      ],
      codex: [makeBackendResult("codex", makeAgentTwoInitialDraft())],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.agent).toBe("agent_one");

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    expect(stored.status).toBe("failed");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["artifacts"]).toBeUndefined();
    const artifacts = built.artifactSidecar.get("wf-asym") ?? [];
    const summary = artifacts.map((a) => ({
      kind: a.kind,
      agent: "agent" in a ? a.agent : null,
    }));
    expect(summary).toEqual([{ kind: "initial_draft", agent: "agent_two" }]);
  });

  it("preserves the successful peer's initial draft when agent_two's initial draft fails in parallel", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [makeBackendResult("claude", makeAgentOneInitialDraft())],
      codex: [makeFailedResult("codex", "synthetic agent_two initial failure")],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.agent).toBe("agent_two");

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    expect(stored.status).toBe("failed");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["artifacts"]).toBeUndefined();
    const artifacts = built.artifactSidecar.get("wf-asym") ?? [];
    const summary = artifacts.map((a) => ({
      kind: a.kind,
      agent: "agent" in a ? a.agent : null,
    }));
    expect(summary).toEqual([{ kind: "initial_draft", agent: "agent_one" }]);
  });

  it("preserves all artifacts emitted before user_stopped in the unresolved envelope's snapshot", async () => {
    const stopController = new AbortController();
    const programmed = makeProgrammedCallAgent({
      claude: [makeBackendResult("claude", makeAgentOneInitialDraft())],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
      ],
    });
    const built = await buildDeps(programmed);

    const wrappedCallAgent = built.deps.callAgent;
    let crossReviewSeen = false;
    built.deps.callAgent = async (request) => {
      const result = await wrappedCallAgent(request);
      if (result.outcome.kind === "completed") {
        const so = result.outcome.structuredOutput as { kind?: string };
        if (so?.kind === "cross_review") {
          crossReviewSeen = true;
          stopController.abort();
        }
      }
      return result;
    };

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ stopSignal: stopController.signal }),
      built.deps,
    );

    expect(crossReviewSeen).toBe(true);
    expect(result.kind).toBe("completed_unresolved");

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["artifacts"]).toBeUndefined();
    const artifacts = built.artifactSidecar.get("wf-asym") ?? [];
    const kinds = artifacts.map((a) => a.kind);
    expect(kinds).toEqual(["initial_draft", "initial_draft", "cross_review"]);
  });

  it("captures a typed open_conflicts artifact (disagreements + questions) on the pause snapshot", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionContinue({
            remaining_disagreements: [makeObjectiveDisagreement()],
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        autonomousResolutionThreshold: "blocking",
        negotiationRounds: 5,
      }),
      built.deps,
    );
    expect(result.kind).toBe("paused_for_user_input");

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    expect(stored.status).toBe("paused");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    const openConflicts = snapshot["currentOpenConflicts"] as
      | Record<string, unknown>
      | undefined;
    expect(openConflicts).toBeTruthy();
    if (!openConflicts) return;
    expect(openConflicts["kind"]).toBe("open_conflicts");
    const disagreements = openConflicts["disagreements"] as Array<{
      category: string;
    }>;
    expect(Array.isArray(disagreements)).toBe(true);
    expect(disagreements.length).toBeGreaterThan(0);
    expect(disagreements[0]?.category).toBe("objective");

    // The artifact stream — including the open_conflicts beat — now lives in
    // the sidecar, not the envelope blob.
    expect(snapshot["artifacts"]).toBeUndefined();
    const sidecar = built.artifactSidecar.get("wf-asym") ?? [];
    const kinds = sidecar.map((a) => a.kind);
    expect(kinds).toContain("open_conflicts");
  });
});

describe("runAsymmetricCollaborationSlice — captured session context durability", () => {
  const CAPTURED = {
    alignment: {
      version: 9,
      contentHash: "hash-9",
      text: "## Charter\n\nPrefer boring technology.",
      snapshotPath: ".cc/session-alignment/snapshots/hash-9.md",
    },
    activeTicketBlock: "<active-ticket>\nidentifier: p#12\n</active-ticket>",
  };

  it("persists the captured snapshot into the envelope's feature snapshot", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    await runAsymmetricCollaborationSlice(
      baseInput({ sessionContext: CAPTURED }),
      built.deps,
    );

    const stored = await built.envelopeStore.read("wf-asym");
    const snapshot = stored?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["sessionContext"]).toEqual(CAPTURED);
  });

  it("persists an empty projection when neither a charter nor a ticket governs", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    await runAsymmetricCollaborationSlice(baseInput(), built.deps);

    const stored = await built.envelopeStore.read("wf-asym");
    const snapshot = stored?.featureSnapshot as Record<string, unknown>;
    expect(snapshot["sessionContext"]).toEqual(
      EMPTY_COLLABORATION_SESSION_CONTEXT,
    );
  });
});

describe("runAsymmetricCollaborationSlice — Codex speed durability", () => {
  it.each([false, true])(
    "persists agent_one's explicit Codex fast parameter of %s through a user-input pause via the agents map",
    async (codexFastMode) => {
      const programmed = makeProgrammedCallAgent({
        claude: [
          makeBackendResult("claude", makeAgentTwoInitialDraft()),
          makeBackendResult("claude", makeAgentTwoCrossReview()),
          makeBackendResult("claude", makeAgentTwoCounterProposalRound1()),
        ],
        codex: [
          makeBackendResult("codex", makeAgentOneInitialDraft()),
          makeBackendResult("codex", makeAgentOneProposedChanges()),
          makeBackendResult(
            "codex",
            makeResolutionDecisionContinue({
              remaining_disagreements: [makeObjectiveDisagreement()],
            }),
          ),
        ],
      });
      const built = await buildDeps(programmed);

      const agents: CollaborationAgentsMap = {
        agent_one: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.5-codex",
            parameters: {
              reasoning: "high",
              fast: String(codexFastMode),
            },
          },
        },
        agent_two: {
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        },
      };
      const result = await runAsymmetricCollaborationSlice(
        baseInput({
          primaryAgentBackend: "codex",
          agents,
          autonomousResolutionThreshold: "blocking",
          negotiationRounds: 5,
        }),
        built.deps,
      );

      expect(result.kind).toBe("paused_for_user_input");
      const stored = await built.envelopeStore.read("wf-asym");
      const snapshot = stored?.featureSnapshot as Record<string, unknown>;
      expect(snapshot["agents"]).toEqual(agents);
    },
  );
});

describe("runAsymmetricCollaborationSlice — mid-run progress envelopes", () => {
  // Regression: without per-artifact progress envelopes, the UI cache only
  // invalidates at lifecycle boundaries (running/paused/completed/failed),
  // so the inline collab UI sticks on the initial "drafting" frame even
  // though the slice has progressed through cross-review and negotiation
  // rounds server-side. A page refresh is the only way to see the latest
  // featureSnapshot. Each `persistArtifactsSnapshot` MUST broadcast a
  // status envelope so SSE consumers can refetch the envelope between
  // lifecycle transitions.
  it("publishes a running status envelope after each persisted artifact between the initial running envelope and the final completed envelope", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput(),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");

    const collabEnvelopes = built.capturedEnvelopes.filter(
      (e) => e.scope === "collaboration" && e.scopeId === "wf-asym",
    );

    expect(collabEnvelopes.length).toBeGreaterThanOrEqual(3);

    expect(collabEnvelopes[0]?.status).toBe("running");
    const last = collabEnvelopes[collabEnvelopes.length - 1];
    expect(last?.status).toBe("completed");

    const middle = collabEnvelopes.slice(1, -1);
    expect(middle.length).toBeGreaterThan(0);
    for (const env of middle) {
      expect(env.status).toBe("running");
    }
  });
});

describe("runAsymmetricCollaborationSlice — resume short-circuit from paused open_conflicts", () => {
  it("rehydrates the artifact stream, skips drafts and negotiation, calls only the final-answer prompt with user answers, and preserves all original artifacts on the snapshot", async () => {
    const agentOneInitialDraft = makeAgentOneInitialDraft();
    const agentTwoInitialDraft = makeAgentTwoInitialDraft();
    const crossReview = makeAgentTwoCrossReview();
    const proposedChanges = makeAgentOneProposedChanges();
    const counterProposal = makeAgentTwoCounterProposalRound1();
    const resolutionAskUser = makeResolutionDecisionAskUser();
    const openConflicts = makeOpenConflicts({
      questions: [
        makeUserQuestion({
          id: "Q-1",
          question: "Should this be a design or implementation plan?",
        }),
      ],
    });
    const seededArtifacts = [
      agentOneInitialDraft,
      agentTwoInitialDraft,
      crossReview,
      proposedChanges,
      counterProposal,
      resolutionAskUser,
      openConflicts,
    ];

    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult(
          "claude",
          makeFinalAnswer({ summary: "FINAL_RESUME_ANSWER" }),
        ),
      ],
      codex: [],
    });
    const built = await buildDeps(programmed);

    // The paused artifact stream now lives in the durable sidecar; seed it
    // there (not in the envelope blob) so the resume path rehydrates from
    // storage exactly as production does after a process restart.
    built.artifactSidecar.set("wf-asym", [...seededArtifacts]);

    await built.envelopeStore.upsert("wf-asym", () => ({
      workflowId: "wf-asym",
      workflowType: "collaboration",
      status: "paused",
      phase: "asymmetric_paused_for_user",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      pause: {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "wf-asym-asymmetric-ask-user",
        reason: "user_input_required",
      },
      featureSnapshot: {
        mode: "asymmetric",
        brief: "Design X.",
        primaryAgentBackend: "claude",
        negotiationRounds: 3,
        negotiationRoundsCompleted: 1,
        autonomousResolutionThreshold: "major",
        userAnswersByQuestionId: {},
        currentOpenConflicts: openConflicts,
      },
    }));

    const inputWithResume = baseInput({
      resume: {
        userAnswersByQuestionId: { "Q-1": "design document" },
      },
    } as Partial<AsymmetricCollaborationSliceInput> as AsymmetricCollaborationSliceInput);

    const result = await runAsymmetricCollaborationSlice(
      inputWithResume,
      built.deps,
    );

    expect(programmed.receivedRequests).toHaveLength(1);
    const finalCall = programmed.receivedRequests[0];
    if (!finalCall) throw new Error("expected final-answer request");
    expect(finalCall.backend).toBe("claude");
    expect(finalCall.prompt).toContain("design document");
    expect(finalCall.prompt).toContain("Q-1");

    expect(result.kind).toBe("completed_final");

    // The rehydrated stream plus the newly appended final_answer land in the
    // sidecar, preserving append order; the blob never carries artifacts.
    const sidecar = built.artifactSidecar.get("wf-asym") ?? [];
    expect(sidecar.map((a) => a.kind)).toEqual([
      "initial_draft",
      "initial_draft",
      "cross_review",
      "proposed_changes",
      "counter_proposal",
      "resolution_decision",
      "open_conflicts",
      "final_answer",
    ]);

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    const snapshot = stored.featureSnapshot as {
      artifacts?: unknown;
      userAnswersByQuestionId: Record<string, string>;
    };
    expect(snapshot.artifacts).toBeUndefined();
    expect(snapshot.userAnswersByQuestionId).toEqual({
      "Q-1": "design document",
    });
  });
});

describe("runAsymmetricCollaborationSlice — resume input", () => {
  it("accepts userAnswersByQuestionId on a resume input and surfaces it on the post-resume snapshot", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const built = await buildDeps(programmed);

    const inputWithResume = baseInput({
      resume: {
        userAnswersByQuestionId: { "Q-1": "design document" },
      },
    } as Partial<AsymmetricCollaborationSliceInput> as AsymmetricCollaborationSliceInput);

    await runAsymmetricCollaborationSlice(inputWithResume, built.deps);

    const stored = await built.envelopeStore.read("wf-asym");
    if (!stored) throw new Error("envelope missing");
    const snapshot = stored.featureSnapshot as Record<string, unknown>;
    expect(snapshot["userAnswersByQuestionId"]).toEqual({
      "Q-1": "design document",
    });
  });
});

describe("runAsymmetricCollaborationSlice — final answer + transcript writeback", () => {
  it("writes the final answer artifact and appends an assistant transcript entry on completed_final when conversationId is set", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult(
          "claude",
          makeFinalAnswer({
            summary: "FINAL_ANSWER_BODY",
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });

    const appendCalls: Array<{ conversationId: string; entry: unknown }> = [];
    const metadataCalls: Array<{
      conversationId: string;
      workflowId: string;
      timestamp: string;
    }> = [];
    const built = await buildDeps(programmed, {
      appendTranscriptEntry: async (conversationId, entry) => {
        appendCalls.push({ conversationId, entry });
      },
      markConversationAwaiting: async (conversationId, input) => {
        metadataCalls.push({ conversationId, ...input });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ conversationId: "conv-1" }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    if (result.kind !== "completed_final") return;
    expect(result.finalAnswerArtifactId).toBeTruthy();

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.conversationId).toBe("conv-1");
    const entry = appendCalls[0]?.entry as {
      type: string;
      role?: string;
      content?: { type: string; text: string }[];
    };
    expect(entry.type).toBe("assistant");
    expect(entry.content?.[0]?.text).toContain("FINAL_ANSWER_BODY");
    expect(metadataCalls).toEqual([
      {
        conversationId: "conv-1",
        workflowId: "wf-asym",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    ]);
  });

  it("reads the final answer transcript body from the generated answer artifact", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult(
          "claude",
          makeFinalAnswer({
            summary: "INLINE_FINAL_ANSWER",
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });

    const appendCalls: Array<{ conversationId: string; entry: unknown }> = [];
    const built = await buildDeps(programmed, {
      appendTranscriptEntry: async (conversationId, entry) => {
        appendCalls.push({ conversationId, entry });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ conversationId: "conv-inline" }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    if (result.kind !== "completed_final") return;
    expect(result.finalAnswerArtifactId).toBeTruthy();

    expect(appendCalls).toHaveLength(1);
    const entry = appendCalls[0]?.entry as {
      content?: { type: string; text: string }[];
    };
    expect(entry.content?.[0]?.text).toBe("INLINE_FINAL_ANSWER");
  });
});

describe("runAsymmetricCollaborationSlice — conversation continuity", () => {
  function makeFullHappyPathClaudePrimary() {
    return makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges()),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
  }

  function makeFullHappyPathCodexPrimary() {
    return makeProgrammedCallAgent({
      codex: [
        makeBackendResult("codex", makeAgentOneInitialDraft()),
        makeBackendResult("codex", makeAgentOneProposedChanges()),
        makeBackendResult(
          "codex",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        makeBackendResult("codex", makeFinalAnswer()),
      ],
      claude: [
        makeBackendResult("claude", makeAgentTwoInitialDraft()),
        makeBackendResult("claude", makeAgentTwoCrossReview()),
        makeBackendResult("claude", makeAgentTwoCounterProposalRound1()),
      ],
    });
  }

  function spyOnLaneInitialize(inner: ReturnType<typeof createLaneService>): {
    service: ReturnType<typeof createLaneService>;
    initializeCalls: LaneState[];
  } {
    const initializeCalls: LaneState[] = [];
    const service: ReturnType<typeof createLaneService> = {
      resolve: (ref) => inner.resolve(ref),
      initialize: async (state) => {
        initializeCalls.push(state);
        return inner.initialize(state);
      },
      recordOutcome: (ref, outcome) => inner.recordOutcome(ref, outcome),
    };
    return { service, initializeCalls };
  }

  it("seeds the primary Claude lane with conversationId when priorBackendRef.backend matches primary", async () => {
    const inner = createLaneService({ store: createInMemoryLaneStore() });
    const { service, initializeCalls } = spyOnLaneInitialize(inner);

    const programmed = makeFullHappyPathClaudePrimary();
    const built = await buildDeps(programmed, { laneService: service });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        priorBackendRef: {
          backend: "claude",
          ref: "claude-prior-session",
        },
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    expect(initializeCalls.length).toBeGreaterThanOrEqual(2);

    const claudeInit = initializeCalls.find((s) => s.backend === "claude");
    const codexInit = initializeCalls.find((s) => s.backend === "codex");
    expect(claudeInit).toBeDefined();
    expect(codexInit).toBeDefined();
    if (!claudeInit || !codexInit) return;

    expect(claudeInit.ref).toBe("claude-prior-session");
    expect(codexInit.ref).toBeNull();
  });

  it("seeds the primary Codex lane with threadId when priorBackendRef.backend matches primary", async () => {
    const inner = createLaneService({ store: createInMemoryLaneStore() });
    const { service, initializeCalls } = spyOnLaneInitialize(inner);

    const programmed = makeFullHappyPathCodexPrimary();
    const built = await buildDeps(programmed, { laneService: service });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "codex",
        priorBackendRef: {
          backend: "codex",
          ref: "codex-prior-thread",
        },
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    const claudeInit = initializeCalls.find((s) => s.backend === "claude");
    const codexInit = initializeCalls.find((s) => s.backend === "codex");
    expect(claudeInit).toBeDefined();
    expect(codexInit).toBeDefined();
    if (!claudeInit || !codexInit) return;

    expect(codexInit.ref).toBe("codex-prior-thread");
    expect(claudeInit.ref).toBeNull();
  });

  it("does NOT seed when priorBackendRef.backend does not match primaryAgentBackend", async () => {
    const inner = createLaneService({ store: createInMemoryLaneStore() });
    const { service, initializeCalls } = spyOnLaneInitialize(inner);

    const programmed = makeFullHappyPathClaudePrimary();
    const built = await buildDeps(programmed, { laneService: service });

    await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        priorBackendRef: {
          backend: "codex",
          ref: "stale-codex-thread",
        },
      }),
      built.deps,
    );

    const claudeInit = initializeCalls.find((s) => s.backend === "claude");
    const codexInit = initializeCalls.find((s) => s.backend === "codex");
    if (!claudeInit || !codexInit) throw new Error("expected both lanes init");

    expect(claudeInit.ref).toBeNull();
    expect(codexInit.ref).toBeNull();
  });

  it("does not overwrite an existing lane on resume (initializeLaneIfMissing wins)", async () => {
    const laneStore = createInMemoryLaneStore();
    const inner = createLaneService({ store: laneStore });
    await inner.initialize({
      workflowId: "wf-asym",
      laneId: "agent_one",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: "from-prior-turn",
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T09:00:00.000Z",
    });

    const programmed = makeFullHappyPathClaudePrimary();
    const built = await buildDeps(programmed, { laneService: inner });

    await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        priorBackendRef: {
          backend: "claude",
          ref: "from-conversation",
        },
      }),
      built.deps,
    );

    const lane = await inner.resolve({
      workflowId: "wf-asym",
      laneId: "agent_one",
    });
    expect(lane).toBeDefined();
    if (!lane) return;
    expect(lane.ref).toBe("sess-claude");
  });

  it("calls updateConversationBackendRef with the primary lane's latest codex ref when primary is codex", async () => {
    const programmed = makeFullHappyPathCodexPrimary();
    const updateCalls: Array<{
      conversationId: string;
      ref: AgentSessionRef;
    }> = [];
    const built = await buildDeps(programmed, {
      updateConversationBackendRef: async (conversationId, ref) => {
        updateCalls.push({ conversationId, ref });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "codex",
        conversationId: "conv-1",
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    expect(updateCalls).toEqual([
      {
        conversationId: "conv-1",
        ref: { backend: "codex", ref: "th-codex" },
      },
    ]);
  });

  it("skips updateConversationBackendRef when the primary lane has no continuity id", async () => {
    const noRefResult = (
      backend: Backend,
      output: ArtifactKind,
    ): AgentCallResult => ({
      ...makeBackendResult(backend, output),
      backendRef: null,
    });

    const programmed = makeProgrammedCallAgent({
      claude: [
        noRefResult("claude", makeAgentOneInitialDraft()),
        noRefResult("claude", makeAgentOneProposedChanges()),
        noRefResult(
          "claude",
          makeResolutionDecisionFinal({ remaining_disagreements: [] }),
        ),
        noRefResult("claude", makeFinalAnswer()),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult("codex", makeAgentTwoCounterProposalRound1()),
      ],
    });
    const updateCalls: Array<{
      conversationId: string;
      ref: AgentSessionRef;
    }> = [];
    const built = await buildDeps(programmed, {
      updateConversationBackendRef: async (conversationId, ref) => {
        updateCalls.push({ conversationId, ref });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    expect(updateCalls).toEqual([]);
  });

  it("does not fail the run when updateConversationBackendRef rejects", async () => {
    const programmed = makeFullHappyPathClaudePrimary();
    const built = await buildDeps(programmed, {
      updateConversationBackendRef: async () => {
        throw new Error("synthetic mutate failure");
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
  });

  it("does NOT call updateConversationBackendRef when the run fails", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [makeFailedResult("claude", "claude initial draft exploded")],
      codex: [makeBackendResult("codex", makeAgentTwoInitialDraft())],
    });
    const updateCalls: Array<{
      conversationId: string;
      ref: AgentSessionRef;
    }> = [];
    const built = await buildDeps(programmed, {
      updateConversationBackendRef: async (conversationId, ref) => {
        updateCalls.push({ conversationId, ref });
      },
    });

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
      }),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    expect(updateCalls).toEqual([]);
  });
});

describe("runAsymmetricCollaborationSlice — resuming after an operational failure", () => {
  /**
   * Seed the durable sidecar as a prior attempt would have left it, and
   * materialize the generated markdown each recorded artifact names — a
   * replayed artifact points at real files a resumed run may read.
   */
  function seedSidecar(
    built: Awaited<ReturnType<typeof buildDeps>>,
    artifacts: CollaborationArtifact[],
  ): void {
    const rehomed = artifacts.map((a) =>
      rehomeGeneratedArtifactPaths(a, "wf-asym"),
    );
    for (const artifact of rehomed) materializeGeneratedFiles(artifact);
    built.artifactSidecar.set("wf-asym", rehomed);
  }

  function requestKinds(programmed: ScriptedAgentCall): string[] {
    return programmed.receivedRequests.map((req) => {
      const backend =
        req.kind === "conversation_turn"
          ? (req.backend ?? "claude")
          : req.backend;
      return `${req.laneRef?.laneId ?? "?"}:${backend}`;
    });
  }

  // The ticket's core promise: an outage mid-negotiation must not throw away
  // the rounds already paid for.
  it("replays every recorded step and calls the model only for the missing one", async () => {
    const programmed = makeProgrammedCallAgent({
      // agent_two — only the counter-proposal that never completed.
      codex: [
        makeBackendResult(
          "codex",
          makeAgentTwoCounterProposalRound2({ round: 2 }),
        ),
      ],
      // agent_one — the rest of round 2, then the final answer.
      claude: [
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            round: 2,
            remaining_disagreements: [],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer({ round: 2 })),
      ],
    });
    const built = await buildDeps(programmed);
    seedSidecar(built, [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges({ round: 1 }),
      makeAgentTwoCounterProposalRound1({ round: 1 }),
      makeResolutionDecisionContinue({ round: 1 }),
      makeAgentOneProposedChanges({ round: 2 }),
    ]);
    const seededLength = built.artifactSidecar.get("wf-asym")!.length;

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ primaryAgentBackend: "claude", negotiationRounds: 3 }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    // Seven recorded steps replayed for free; only the three that never ran
    // cost a model call.
    expect(requestKinds(programmed)).toEqual([
      "agent_two:codex",
      "agent_one:claude",
      "agent_one:claude",
    ]);

    // Replayed lines are already on disk: re-entry must not append them again.
    const sidecar = built.artifactSidecar.get("wf-asym")!;
    expect(sidecar).toHaveLength(seededLength + 3);
    const keys = sidecar.map((a) =>
      a.kind === "initial_draft"
        ? `${a.kind}:${a.agent}`
        : a.kind === "cross_review" || a.kind === "final_answer"
          ? a.kind
          : `${a.kind}:${a.round}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  // When one model has an outage during the parallel draft phase, the healthy
  // peer's draft is still committed — so the sidecar legitimately holds one
  // draft, and only the failed peer should be re-dispatched.
  it("re-dispatches only the peer whose initial draft is missing", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges({ round: 1 })),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            round: 1,
            remaining_disagreements: [],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer({ round: 1 })),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult(
          "codex",
          makeAgentTwoCounterProposalRound1({ round: 1 }),
        ),
      ],
    });
    const built = await buildDeps(programmed);
    seedSidecar(built, [makeAgentTwoInitialDraft()]);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ primaryAgentBackend: "claude" }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    // agent_two's draft replayed; the very first live call is agent_one's.
    expect(requestKinds(programmed)[0]).toBe("agent_one:claude");
    expect(
      programmed.receivedRequests.filter(
        (r) => r.laneRef?.laneId === "agent_two",
      ),
    ).toHaveLength(2);
  });

  it("presents replayed drafts to later prompts in canonical order", async () => {
    const programmed = makeProgrammedCallAgent({
      codex: [
        makeBackendResult(
          "codex",
          makeAgentTwoCounterProposalRound1({ round: 1 }),
        ),
      ],
      claude: [
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            round: 1,
            remaining_disagreements: [],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer({ round: 1 })),
      ],
    });
    const built = await buildDeps(programmed);
    // Agent Two's draft landed on disk FIRST — the append-only order a real
    // parallel phase can produce.
    seedSidecar(built, [
      makeAgentTwoInitialDraft(),
      makeAgentOneInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges({ round: 1 }),
    ]);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ primaryAgentBackend: "claude" }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    // The final-answer prompt is the one that replays the whole recorded
    // stream. It must list Agent One's draft before Agent Two's even though
    // Agent Two's landed on disk first — an append-only file cannot be
    // reordered, so the canonical order has to come from the ledger.
    const finalPrompt = programmed.receivedRequests.at(-1)!.prompt;
    const ledgerSection = finalPrompt.slice(
      finalPrompt.indexOf(
        "--- complete artifact stream before final answer ---",
      ),
    );
    expect(ledgerSection).toContain("initial_draft (agent=agent_one)");
    expect(
      ledgerSection.indexOf("initial_draft (agent=agent_one)"),
    ).toBeLessThan(ledgerSection.indexOf("initial_draft (agent=agent_two)"));
  });

  // A stream the ledger cannot trust must never be re-dispatched as if fresh:
  // that would re-run a completed run and bill it twice.
  it("fails terminally rather than restarting when the recorded stream has a hole", async () => {
    const programmed = makeProgrammedCallAgent({ claude: [], codex: [] });
    const built = await buildDeps(programmed);
    seedSidecar(built, [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      // round 1's proposed_changes is missing beneath its own counter-proposal
      makeAgentTwoCounterProposalRound1({ round: 1 }),
    ]);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({ primaryAgentBackend: "claude" }),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    expect(programmed.receivedRequests).toEqual([]);
  });
});

describe("runAsymmetricCollaborationSlice — handing the conversation back", () => {
  function completingCalls() {
    return makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges({ round: 1 })),
        makeBackendResult(
          "claude",
          makeResolutionDecisionFinal({
            round: 1,
            remaining_disagreements: [],
          }),
        ),
        makeBackendResult("claude", makeFinalAnswer({ round: 1 })),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult(
          "codex",
          makeAgentTwoCounterProposalRound1({ round: 1 }),
        ),
      ],
    });
  }

  // The ordinary end of a collaboration. If ownership were not released here
  // the user could never prompt in that conversation again — prompt admission
  // refuses an owned conversation.
  it("releases the conversation when the run completes with a final answer", async () => {
    const programmed = completingCalls();
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
        attemptEpoch: 3,
      }),
      built.deps,
    );

    expect(result.kind).toBe("completed_final");
    expect(built.releasedOwners).toEqual([
      {
        conversationId: "conv-1",
        owner: { workflowId: "wf-asym", attemptEpoch: 3 },
      },
    ]);
  });

  it("releases the conversation when the run fails", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [makeFailedResult("claude", "provider down")],
      codex: [makeBackendResult("codex", makeAgentTwoInitialDraft())],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
        attemptEpoch: 1,
      }),
      built.deps,
    );

    expect(result.kind).toBe("failed");
    expect(built.releasedOwners).toHaveLength(1);
  });

  // A paused run keeps the conversation: the user's next act is answering the
  // question through the pause UI, which resumes the SAME run rather than
  // starting a competing turn.
  it("keeps the conversation while paused for user input", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeBackendResult("claude", makeAgentOneInitialDraft()),
        makeBackendResult("claude", makeAgentOneProposedChanges({ round: 1 })),
        makeBackendResult(
          "claude",
          makeResolutionDecisionAskUser({
            round: 1,
            user_questions: [makeUserQuestion()],
          }),
        ),
      ],
      codex: [
        makeBackendResult("codex", makeAgentTwoInitialDraft()),
        makeBackendResult("codex", makeAgentTwoCrossReview()),
        makeBackendResult(
          "codex",
          makeAgentTwoCounterProposalRound1({ round: 1 }),
        ),
      ],
    });
    const built = await buildDeps(programmed);

    const result = await runAsymmetricCollaborationSlice(
      baseInput({
        primaryAgentBackend: "claude",
        conversationId: "conv-1",
        attemptEpoch: 1,
        negotiationRounds: 1,
      }),
      built.deps,
    );

    expect(result.kind).toBe("paused_for_user_input");
    expect(built.releasedOwners).toEqual([]);
  });
});
