/**
 * Collaboration Mode primitive-native slice.
 *
 * The first feature implemented directly against the composable workflow
 * primitive layer. It demonstrates that a multi-lane review loop with
 * convergence, user-input pauses, artifact registration, scoped status, and a
 * durable workflow envelope can be expressed by composing the existing
 * primitives without introducing a generic workflow engine.
 *
 * What lives in this slice:
 *
 *  - Two lanes, one per agent: Claude routes through `conversation_turn` and
 *    Codex routes through `task_run`, mirroring each backend's continuity
 *    model. Lane state is initialized once and updated after every turn via
 *    `LaneService.recordOutcome`, so backend-specific continuity references
 *    (Claude conversationId, Codex threadId) round-trip without invented
 *    metrics.
 *  - The structured per-round response (`CollaborationRoundResponse`) is the
 *    contract every agent emits. The slice parses it via Zod after each
 *    `AgentCallResult.outcome.kind === "completed"` so structured-output
 *    drift fails fast.
 *  - Convergence is checked by the shared `runConvergenceGate` after every
 *    round.
 *  - User-input pauses are surfaced via the human-approval gate vocabulary
 *    (always `pauseKind: "post_turn"`); the resulting envelope projection
 *    preserves that pause shape so a future resume can target the correct
 *    state after a server restart.
 *  - The scribe pass is a single additional agent call that produces the
 *    merged design.
 *  - Three artifacts (merged design, transcript, open-questions punch list)
 *    are written under `memory-bank/collaboration/<workflowId>/` and
 *    registered as reference documents for discoverability.
 *  - A `WorkflowEnvelope` (workflowType `"collaboration"`) carries the
 *    lifecycle (`running` → `paused | completed | failed`) and a
 *    feature-owned snapshot containing the brief and the accumulating
 *    transcript.
 *  - Scoped `StatusBus` envelopes (`scope: "collaboration"`) make the
 *    lifecycle visible live without coupling the slice to SSE.
 *
 * What deliberately does NOT live in this slice:
 *
 *  - Backend resolution (which conversation runtime / task runner to use, MCP
 *    overrides, model selection) is the caller's responsibility — the slice
 *    accepts a single `callAgent(request)` entry point. Tests can stub it
 *    directly; production wires it to `executeAgentCall(request, facadeDeps)`.
 *  - Pause resumption beyond returning the resume token. The first slice
 *    proves the pause projection is durable; reentrant resume logic remains
 *    out of scope until a UI surface exists.
 *  - A generic workflow engine. Each step is an explicit, named operation in
 *    one TypeScript function — no interpreter, no graph definition.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import {
  runConvergenceGate,
  type ConvergenceVote,
} from "@/lib/workflows/primitives/convergence-gate";
import { pauseForHumanApproval } from "@/lib/workflows/primitives/human-approval-gate";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import type { LaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type { StatusBus } from "@/lib/workflows/primitives/status-bus";
import type {
  WorkflowEnvelope,
  WorkflowEnvelopeStatus,
} from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA,
  collaborationRoundResponseSchema,
  type CollaborationAgent,
  type CollaborationOpenQuestion,
  type CollaborationRoundResponse,
} from "./types";

export type { CollaborationRoundResponse };

const logger = createLogger("workflows.collaboration.slice");

const COLLABORATION_WORKFLOW_TYPE = "collaboration";
const COLLABORATION_SCOPE = "collaboration";

export interface CollaborationSliceInput {
  workflowId: string;
  brief: string;
  worktreePath: string;
  /**
   * Stable scheduling key shared by every lane execution that touches the same
   * session worktree. Two write-capable lanes scheduled with the same
   * `sessionKey` are serialized by the LaneScheduler so they cannot mutate the
   * worktree concurrently.
   */
  sessionKey: string;
  maxIterations: number;
  scribeBackend: CollaborationAgent;
  /**
   * Optional resumption context. When supplied the slice skips envelope
   * initialization, restores the prior round transcript, and starts the next
   * round at `resumeFromRound + 1`. `userAnswersByRound` is forwarded into the
   * lane prompts so the agents see the human-supplied answers from the round
   * that triggered the pause.
   */
  resume?: CollaborationResumeContext;
}

export interface CollaborationResumeContext {
  resumeFromRound: number;
  priorTranscript: CollaborationRoundResponse[][];
  userAnswersByRound: Record<number, Record<string, string>>;
}

export interface CollaborationSliceDeps {
  callAgent(request: AgentCallRequest): Promise<AgentCallResult>;
  laneService: LaneService;
  laneScheduler: LaneScheduler;
  envelopeStore: WorkflowEnvelopeStore;
  artifactRegistry: ArtifactRegistry;
  statusBus: StatusBus;
  now?: () => string;
}

export type CollaborationSliceResult =
  | {
      kind: "completed";
      rounds: number;
      mergedDesignArtifactId: string;
      transcriptArtifactId: string;
      openQuestionsArtifactId: string;
    }
  | {
      kind: "paused";
      reason: "user_input_required";
      resumeToken: string;
      round: number;
      openQuestions: ReadonlyArray<{
        agent: CollaborationAgent;
        question: string;
      }>;
    }
  | {
      kind: "halted";
      reason: "max_iterations_exceeded";
      rounds: number;
    }
  | {
      kind: "failed";
      reason: "agent_call_failed";
      round: number;
      agent: CollaborationAgent;
      errorSummary: string;
    };

interface LaneCallSuccess {
  kind: "ok";
  agent: CollaborationAgent;
  response: CollaborationRoundResponse;
}

interface LaneCallFailure {
  kind: "failed";
  agent: CollaborationAgent;
  errorSummary: string;
}

type LaneCallOutcome = LaneCallSuccess | LaneCallFailure;

interface CollaborationFeatureSnapshot {
  brief: string;
  scribeBackend: CollaborationAgent;
  maxIterations: number;
  transcript: CollaborationRoundResponse[][];
  status: "running" | "paused" | "completed" | "failed";
  rounds: number;
  userAnswersByRound?: Record<string, Record<string, string>>;
}

export async function runCollaborationSlice(
  input: CollaborationSliceInput,
  deps: CollaborationSliceDeps,
): Promise<CollaborationSliceResult> {
  if (input.maxIterations < 1) {
    throw new Error(
      `runCollaborationSlice requires maxIterations >= 1, received ${input.maxIterations}`,
    );
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const resumeContext = input.resume;
  const startingRound = (resumeContext?.resumeFromRound ?? 0) + 1;

  await initializeLanes(input, deps, now);
  if (resumeContext) {
    await prepareEnvelopeForResume(input, deps, now, resumeContext);
  } else {
    await initializeEnvelope(input, deps, now);
  }
  publishStatus(deps, input.workflowId, "running", {
    kind: "round_started",
    round: startingRound,
  });

  const transcript: CollaborationRoundResponse[][] = resumeContext
    ? resumeContext.priorTranscript.map((r) => r.map((entry) => ({ ...entry })))
    : [];

  for (let round = startingRound; round <= input.maxIterations; round++) {
    logger.info("collaboration.slice.round_start", {
      workflowId: input.workflowId,
      round,
    });

    const userAnswersForPriorRound =
      resumeContext?.userAnswersByRound?.[round - 1];
    const roundOutcome = await runRound({
      input,
      deps,
      round,
      transcript,
      userAnswersForPriorRound,
    });

    if (roundOutcome.kind === "failed") {
      return markWorkflowFailed({
        input,
        deps,
        now,
        transcript,
        round,
        snapshotRounds: round - 1,
        agent: roundOutcome.agent,
        errorSummary: `Collaboration lane "${roundOutcome.agent}" failed in round ${round}: ${roundOutcome.errorSummary}`,
      });
    }

    const roundResults = roundOutcome.responses;
    transcript.push(roundResults);

    await updateEnvelope(input, deps, now, (existing) => ({
      ...existing,
      phase: `round_${round}`,
      featureSnapshot: buildSnapshot(input, transcript, "running", round),
      updatedAt: now(),
    }));

    const pendingUserInput = collectUserInputQuestions(roundResults);
    if (pendingUserInput.length > 0) {
      const resumeToken = `${input.workflowId}-round-${round}-user-input`;
      const pauseGate = pauseForHumanApproval({
        resumeToken,
        details: {
          openQuestions: pendingUserInput.map((q) => ({
            agent: q.agent,
            question: q.question,
          })),
        },
      });

      await updateEnvelope(input, deps, now, (existing) => ({
        ...existing,
        status: "paused" satisfies WorkflowEnvelopeStatus,
        phase: `paused_round_${round}`,
        featureSnapshot: buildSnapshot(input, transcript, "paused", round),
        pause: {
          pauseKind: pauseGate.pauseKind,
          gateKind: pauseGate.kind,
          resumeToken: pauseGate.resumeToken,
          reason: "user_input_required",
          ...(pauseGate.details !== undefined
            ? { details: pauseGate.details }
            : {}),
        },
        updatedAt: now(),
      }));

      publishStatus(deps, input.workflowId, "paused", {
        kind: "paused_for_user_input",
        round,
        openQuestions: pendingUserInput,
      });

      logger.info("collaboration.slice.paused", {
        workflowId: input.workflowId,
        round,
        questionCount: pendingUserInput.length,
      });

      return {
        kind: "paused",
        reason: "user_input_required",
        resumeToken,
        round,
        openQuestions: pendingUserInput,
      };
    }

    const votes: ConvergenceVote[] = roundResults.map((r) => ({
      voter: r.agent,
      decision: r.decision,
    }));
    const conv = runConvergenceGate({ votes });
    if (conv.status === "pass") {
      let merged: { artifactId: string };
      let trans: { artifactId: string };
      let oq: { artifactId: string };
      try {
        const mergedDesign = await runScribe({
          input,
          deps,
          transcript,
        });

        merged = await deps.artifactRegistry.write({
          kind: "reference_document",
          worktreePath: input.worktreePath,
          relativePath: collaborationArtifactPath(
            input.workflowId,
            "merged-design.md",
          ),
          contents: mergedDesign,
          audience: "user_facing",
          required: true,
          source: { workflowId: input.workflowId },
          description: "Collaboration Mode merged design",
        });
        trans = await deps.artifactRegistry.write({
          kind: "reference_document",
          worktreePath: input.worktreePath,
          relativePath: collaborationArtifactPath(
            input.workflowId,
            "transcript.md",
          ),
          contents: formatTranscript(input, transcript),
          audience: "user_facing",
          required: true,
          source: { workflowId: input.workflowId },
          description: "Collaboration Mode debate transcript",
        });
        oq = await deps.artifactRegistry.write({
          kind: "reference_document",
          worktreePath: input.worktreePath,
          relativePath: collaborationArtifactPath(
            input.workflowId,
            "open-questions.md",
          ),
          contents: formatOpenQuestions(transcript),
          audience: "user_facing",
          required: true,
          source: { workflowId: input.workflowId },
          description: "Collaboration Mode open-questions punch list",
        });
      } catch (err) {
        return markWorkflowFailed({
          input,
          deps,
          now,
          transcript,
          round,
          snapshotRounds: round,
          agent: input.scribeBackend,
          errorSummary: `Collaboration finalization failed in round ${round}: ${getErrorMessage(err)}`,
        });
      }

      await updateEnvelope(input, deps, now, (existing) => ({
        ...existing,
        status: "completed" satisfies WorkflowEnvelopeStatus,
        phase: "completed",
        completedAt: now(),
        featureSnapshot: buildSnapshot(input, transcript, "completed", round, {
          mergedDesignArtifactId: merged.artifactId,
          transcriptArtifactId: trans.artifactId,
          openQuestionsArtifactId: oq.artifactId,
        }),
        updatedAt: now(),
      }));

      publishStatus(deps, input.workflowId, "completed", {
        kind: "completed",
        rounds: round,
      });

      logger.info("collaboration.slice.completed", {
        workflowId: input.workflowId,
        rounds: round,
      });

      return {
        kind: "completed",
        rounds: round,
        mergedDesignArtifactId: merged.artifactId,
        transcriptArtifactId: trans.artifactId,
        openQuestionsArtifactId: oq.artifactId,
      };
    }
  }

  // Max iterations reached without convergence. Persist the partial transcript
  // and open-questions punch list as artifacts so the operator can inspect what
  // was produced; mark the envelope `completed` (the run reached its bounded
  // termination, which is a normal lifecycle end-state) with a phase that
  // surfaces the halt reason and an `errorSummary` describing it. Skipping the
  // scribe pass keeps the merged-design slot empty (no convergence ⇒ no merge).
  const errorSummary = `Convergence not reached within ${input.maxIterations} iteration(s)`;
  const transcriptArtifact = await deps.artifactRegistry.write({
    kind: "reference_document",
    worktreePath: input.worktreePath,
    relativePath: collaborationArtifactPath(input.workflowId, "transcript.md"),
    contents: formatTranscript(input, transcript),
    audience: "user_facing",
    required: true,
    source: { workflowId: input.workflowId },
    description: "Collaboration Mode debate transcript (halted)",
  });
  const openQuestionsArtifact = await deps.artifactRegistry.write({
    kind: "reference_document",
    worktreePath: input.worktreePath,
    relativePath: collaborationArtifactPath(
      input.workflowId,
      "open-questions.md",
    ),
    contents: formatOpenQuestions(transcript),
    audience: "user_facing",
    required: true,
    source: { workflowId: input.workflowId },
    description: "Collaboration Mode open-questions punch list (halted)",
  });

  await updateEnvelope(input, deps, now, (existing) => ({
    ...existing,
    status: "completed" satisfies WorkflowEnvelopeStatus,
    phase: "max_iterations_exceeded",
    errorSummary,
    completedAt: now(),
    featureSnapshot: buildSnapshot(
      input,
      transcript,
      "completed",
      input.maxIterations,
      {
        transcriptArtifactId: transcriptArtifact.artifactId,
        openQuestionsArtifactId: openQuestionsArtifact.artifactId,
      },
    ),
    updatedAt: now(),
  }));

  publishStatus(deps, input.workflowId, "completed", {
    kind: "halted",
    reason: "max_iterations_exceeded",
  });

  logger.warn("collaboration.slice.halted", {
    workflowId: input.workflowId,
    rounds: input.maxIterations,
    reason: "max_iterations_exceeded",
  });

  return {
    kind: "halted",
    reason: "max_iterations_exceeded",
    rounds: input.maxIterations,
  };
}

async function initializeLanes(
  input: CollaborationSliceInput,
  deps: CollaborationSliceDeps,
  now: () => string,
): Promise<void> {
  const claudeLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "claude",
    backend: "claude",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "claude" },
    metrics: { backend: "claude", rotateBeforeNextTurn: false },
    lastUsedAt: now(),
  };
  const codexLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "codex",
    backend: "codex",
    writeCapability: "write_capable",
    policy: { continuityEnabled: false },
    backendState: { backend: "codex" },
    metrics: { backend: "codex", rotateBeforeNextTurn: false },
    lastUsedAt: now(),
  };
  await initializeLaneIfMissing(deps, claudeLane);
  await initializeLaneIfMissing(deps, codexLane);
}

async function initializeLaneIfMissing(
  deps: Pick<CollaborationSliceDeps, "laneService">,
  lane: LaneState,
): Promise<void> {
  const existing = await deps.laneService.resolve({
    workflowId: lane.workflowId,
    laneId: lane.laneId,
  });
  if (!existing) {
    await deps.laneService.initialize(lane);
    return;
  }
  if (existing.backend !== lane.backend) {
    throw new Error(
      `collaboration lane "${lane.laneId}" already exists with backend "${existing.backend}", expected "${lane.backend}"`,
    );
  }
}

async function initializeEnvelope(
  input: CollaborationSliceInput,
  deps: CollaborationSliceDeps,
  now: () => string,
): Promise<void> {
  const timestamp = now();
  await deps.envelopeStore.upsert(input.workflowId, () => ({
    workflowId: input.workflowId,
    workflowType: COLLABORATION_WORKFLOW_TYPE,
    status: "running",
    phase: "round_1",
    createdAt: timestamp,
    updatedAt: timestamp,
    featureSnapshot: buildSnapshot(input, [], "running", 0),
  }));
}

async function prepareEnvelopeForResume(
  input: CollaborationSliceInput,
  deps: CollaborationSliceDeps,
  now: () => string,
  resume: CollaborationResumeContext,
): Promise<void> {
  await deps.envelopeStore.upsert(input.workflowId, (existing) => {
    if (!existing) {
      throw new Error(
        `collaboration slice resume expected an existing envelope for workflow ${input.workflowId}`,
      );
    }
    const next: WorkflowEnvelope = {
      ...existing,
      status: "running",
      phase: `resumed_round_${resume.resumeFromRound + 1}`,
      featureSnapshot: buildSnapshot(
        input,
        resume.priorTranscript,
        "running",
        resume.resumeFromRound,
      ),
      updatedAt: now(),
    };
    if (next.pause !== undefined) {
      const { pause: _drop, ...rest } = next;
      return rest as WorkflowEnvelope;
    }
    return next;
  });
}

async function updateEnvelope(
  input: CollaborationSliceInput,
  deps: CollaborationSliceDeps,
  now: () => string,
  mutate: (existing: WorkflowEnvelope) => WorkflowEnvelope,
): Promise<void> {
  await deps.envelopeStore.upsert(input.workflowId, (existing) => {
    if (!existing) {
      throw new Error(
        `collaboration slice expected an existing envelope for workflow ${input.workflowId}`,
      );
    }
    const next = mutate(existing);
    if (next.status !== "paused" && next.pause !== undefined) {
      const { pause: _drop, ...rest } = next;
      return { ...rest, updatedAt: now() } as WorkflowEnvelope;
    }
    return next;
  });
}

async function markWorkflowFailed(input: {
  input: CollaborationSliceInput;
  deps: CollaborationSliceDeps;
  now: () => string;
  transcript: CollaborationRoundResponse[][];
  round: number;
  snapshotRounds: number;
  agent: CollaborationAgent;
  errorSummary: string;
}): Promise<Extract<CollaborationSliceResult, { kind: "failed" }>> {
  await updateEnvelope(input.input, input.deps, input.now, (existing) => ({
    ...existing,
    status: "failed" satisfies WorkflowEnvelopeStatus,
    phase: `failed_round_${input.round}`,
    errorSummary: input.errorSummary,
    featureSnapshot: buildSnapshot(
      input.input,
      input.transcript,
      "failed",
      input.snapshotRounds,
    ),
    updatedAt: input.now(),
  }));

  publishStatus(input.deps, input.input.workflowId, "failed", {
    kind: "lane_failed",
    round: input.round,
    agent: input.agent,
    errorSummary: input.errorSummary,
  });

  logger.error("collaboration.slice.failed", {
    workflowId: input.input.workflowId,
    round: input.round,
    agent: input.agent,
    errorSummary: input.errorSummary,
  });

  return {
    kind: "failed",
    reason: "agent_call_failed",
    round: input.round,
    agent: input.agent,
    errorSummary: input.errorSummary,
  };
}

interface RunRoundContext {
  input: CollaborationSliceInput;
  deps: CollaborationSliceDeps;
  round: number;
  transcript: CollaborationRoundResponse[][];
  userAnswersForPriorRound?: Record<string, string>;
}

type RunRoundOutcome =
  | { kind: "completed"; responses: CollaborationRoundResponse[] }
  | { kind: "failed"; agent: CollaborationAgent; errorSummary: string };

async function runRound(ctx: RunRoundContext): Promise<RunRoundOutcome> {
  const { input, deps, round, transcript, userAnswersForPriorRound } = ctx;
  const previousRound = transcript[round - 2];

  const claudePrompt = buildLanePrompt({
    agent: "claude",
    round,
    brief: input.brief,
    previousRound,
    userAnswersForPriorRound,
  });
  const codexPrompt = buildLanePrompt({
    agent: "codex",
    round,
    brief: input.brief,
    previousRound,
    userAnswersForPriorRound,
  });

  // Each lane execution is wrapped in laneScheduler.schedule so write-capable
  // lanes sharing the same sessionKey serialize against each other on the
  // session worktree. Promise.all stays for await-fan-in only — the actual
  // execution order is enforced by the scheduler, not the array literal.
  const [claudeResult, codexResult] = await Promise.all([
    deps.laneScheduler.schedule(
      {
        sessionKey: input.sessionKey,
        writeCapability: "write_capable",
        workflowId: input.workflowId,
        laneId: "claude",
      },
      () =>
        callLane({
          agent: "claude",
          prompt: claudePrompt,
          input,
          deps,
        }),
    ),
    deps.laneScheduler.schedule(
      {
        sessionKey: input.sessionKey,
        writeCapability: "write_capable",
        workflowId: input.workflowId,
        laneId: "codex",
      },
      () =>
        callLane({
          agent: "codex",
          prompt: codexPrompt,
          input,
          deps,
        }),
    ),
  ]);

  // Surface the first failed lane in deterministic Claude-then-Codex order so
  // the surfaced failure matches the scheduling order rather than whichever
  // promise rejected first under the hood.
  if (claudeResult.kind === "failed") return claudeResult;
  if (codexResult.kind === "failed") return codexResult;

  return {
    kind: "completed",
    responses: [claudeResult.response, codexResult.response],
  };
}

interface CallLaneContext {
  agent: CollaborationAgent;
  prompt: string;
  input: CollaborationSliceInput;
  deps: CollaborationSliceDeps;
}

async function callLane(ctx: CallLaneContext): Promise<LaneCallOutcome> {
  const { agent, prompt, input, deps } = ctx;
  const laneRef = { workflowId: input.workflowId, laneId: agent };

  const request: AgentCallRequest =
    agent === "claude"
      ? {
          kind: "conversation_turn",
          backend: "claude",
          prompt,
          laneRef,
          writeCapability: "write_capable",
          outputSchema:
            COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA as unknown as Record<
              string,
              unknown
            >,
        }
      : {
          kind: "task_run",
          backend: "codex",
          prompt,
          laneRef,
          writeCapability: "write_capable",
          outputSchema:
            COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA as unknown as Record<
              string,
              unknown
            >,
        };

  let result: AgentCallResult;
  try {
    result = await deps.callAgent(request);
  } catch (err) {
    return {
      kind: "failed",
      agent,
      errorSummary: getErrorMessage(err),
    };
  }

  if (result.outcome.kind === "failed") {
    return {
      kind: "failed",
      agent,
      errorSummary: `${result.outcome.error.failureKind}: ${result.outcome.error.message}`,
    };
  }
  if (result.outcome.kind === "paused") {
    return {
      kind: "failed",
      agent,
      errorSummary: `unexpected pause from lane (pauseKind=${result.outcome.pauseKind}, resumeToken=${result.outcome.resumeToken})`,
    };
  }

  // Defensive parse: even when the AgentCall facade enforces the JSON schema
  // via the structured-output gate, this Zod parse keeps the slice's typed
  // narrowing honest if a caller wires `callAgent` without the gate.
  const parsed = collaborationRoundResponseSchema.parse(
    result.outcome.structuredOutput,
  );

  await deps.laneService.recordOutcome(
    laneRef,
    agent === "claude"
      ? {
          backend: "claude",
          ...(result.backendRef && result.backendRef.backend === "claude"
            ? { conversationId: result.backendRef.sessionId }
            : {}),
        }
      : {
          backend: "codex",
          ...(result.backendRef && result.backendRef.backend === "codex"
            ? { threadId: result.backendRef.threadId }
            : {}),
        },
  );

  return { kind: "ok", agent, response: parsed };
}

interface BuildLanePromptInput {
  agent: CollaborationAgent;
  round: number;
  brief: string;
  previousRound: CollaborationRoundResponse[] | undefined;
  userAnswersForPriorRound?: Record<string, string>;
}

function buildLanePrompt(input: BuildLanePromptInput): string {
  const { agent, round, brief, previousRound, userAnswersForPriorRound } =
    input;
  if (round === 1 || !previousRound) {
    return [
      `You are the ${agent} participant in a Collaboration Mode design loop.`,
      `Brief:`,
      brief,
      ``,
      `Round ${round}: produce your initial design proposal as the structured per-round response.`,
    ].join("\n");
  }

  const otherAgent: CollaborationAgent =
    agent === "claude" ? "codex" : "claude";
  const other = previousRound.find((r) => r.agent === otherAgent);
  const me = previousRound.find((r) => r.agent === agent);

  const sections: string[] = [
    `You are the ${agent} participant in a Collaboration Mode design loop.`,
    `Brief:`,
    brief,
    ``,
    `Round ${round}: respond after reviewing the other agent's prior design and review.`,
  ];

  if (other) {
    sections.push(
      ``,
      `--- ${otherAgent} design (round ${round - 1}) ---`,
      other.designDocument,
      ``,
      `--- ${otherAgent} review of your prior design ---`,
      other.overallAssessment,
    );
    if (other.disagreements.length > 0) {
      sections.push(`Disagreements raised:`);
      for (const d of other.disagreements) {
        sections.push(
          `- (${d.severity}) ${d.description} → ${d.proposedResolution}`,
        );
      }
    }
  }

  if (me) {
    sections.push(
      ``,
      `--- your prior design (round ${round - 1}) ---`,
      me.designDocument,
    );
  }

  if (userAnswersForPriorRound) {
    const entries = Object.entries(userAnswersForPriorRound);
    if (entries.length > 0) {
      sections.push(
        ``,
        `--- user answers to open questions from round ${round - 1} ---`,
      );
      for (const [question, answer] of entries) {
        sections.push(`Q: ${question}`, `A: ${answer}`, ``);
      }
    }
  }

  return sections.join("\n");
}

interface RunScribeContext {
  input: CollaborationSliceInput;
  deps: CollaborationSliceDeps;
  transcript: CollaborationRoundResponse[][];
}

async function runScribe(ctx: RunScribeContext): Promise<string> {
  const { input, deps, transcript } = ctx;
  const scribeBackend = input.scribeBackend;
  const finalRound = transcript[transcript.length - 1] ?? [];
  const finalDesigns = finalRound
    .map((r) => `--- ${r.agent} final design ---\n${r.designDocument}`)
    .join("\n\n");

  const prompt = [
    `You are the ${scribeBackend} scribe for a Collaboration Mode design loop that just converged.`,
    `Brief:`,
    input.brief,
    ``,
    `Both agents accepted the design in the same round. Produce a single merged design document that resolves any minor differences between the two final drafts.`,
    ``,
    finalDesigns,
  ].join("\n");

  // Intentionally free-form: no `outputSchema` / `outputFormat`. The scribe
  // synthesizes a merged design as markdown prose (headings, code blocks,
  // mermaid diagrams). A JSON schema would over-fit the artifact and prevent
  // the agent from producing the rich text the merged design is meant to be.
  const request: AgentCallRequest =
    scribeBackend === "claude"
      ? { kind: "conversation_turn", backend: "claude", prompt }
      : { kind: "task_run", backend: "codex", prompt };

  const result = await deps.callAgent(request);
  if (result.outcome.kind !== "completed") {
    throw new Error(
      `collaboration scribe (${scribeBackend}) did not complete (outcome=${result.outcome.kind})`,
    );
  }
  const text = result.outcome.text;
  if (text === null || text.length === 0) {
    throw new Error(
      `collaboration scribe (${scribeBackend}) returned empty text`,
    );
  }
  return text;
}

function collectUserInputQuestions(
  roundResults: readonly CollaborationRoundResponse[],
): Array<{ agent: CollaborationAgent; question: string }> {
  const collected: Array<{ agent: CollaborationAgent; question: string }> = [];
  for (const r of roundResults) {
    for (const q of r.openQuestions) {
      if (q.requiresUserInput) {
        collected.push({ agent: r.agent, question: q.question });
      }
    }
  }
  return collected;
}

function publishStatus(
  deps: CollaborationSliceDeps,
  workflowId: string,
  status: "running" | "paused" | "completed" | "failed",
  payload: Record<string, unknown>,
): void {
  deps.statusBus.publish({
    scope: COLLABORATION_SCOPE,
    scopeId: workflowId,
    status,
    payload,
  });
}

function buildSnapshot(
  input: CollaborationSliceInput,
  transcript: CollaborationRoundResponse[][],
  status: "running" | "paused" | "completed" | "failed",
  rounds: number,
  artifacts: {
    mergedDesignArtifactId?: string;
    transcriptArtifactId?: string;
    openQuestionsArtifactId?: string;
  } = {},
): CollaborationFeatureSnapshot & {
  mergedDesignArtifactId?: string;
  transcriptArtifactId?: string;
  openQuestionsArtifactId?: string;
} {
  const userAnswers = input.resume?.userAnswersByRound;
  const userAnswersByRoundString =
    userAnswers && Object.keys(userAnswers).length > 0
      ? Object.fromEntries(
          Object.entries(userAnswers).map(([k, v]) => [String(k), v]),
        )
      : undefined;
  return {
    brief: input.brief,
    scribeBackend: input.scribeBackend,
    maxIterations: input.maxIterations,
    transcript: transcript.map((round) => round.map((r) => ({ ...r }))),
    status,
    rounds,
    ...(userAnswersByRoundString !== undefined
      ? { userAnswersByRound: userAnswersByRoundString }
      : {}),
    ...(artifacts.mergedDesignArtifactId !== undefined
      ? { mergedDesignArtifactId: artifacts.mergedDesignArtifactId }
      : {}),
    ...(artifacts.transcriptArtifactId !== undefined
      ? { transcriptArtifactId: artifacts.transcriptArtifactId }
      : {}),
    ...(artifacts.openQuestionsArtifactId !== undefined
      ? { openQuestionsArtifactId: artifacts.openQuestionsArtifactId }
      : {}),
  };
}

function collaborationArtifactPath(
  workflowId: string,
  fileName: string,
): string {
  return `memory-bank/collaboration/${workflowId}/${fileName}`;
}

function formatTranscript(
  input: CollaborationSliceInput,
  transcript: CollaborationRoundResponse[][],
): string {
  const lines: string[] = [
    `# Collaboration Mode transcript`,
    ``,
    `Brief: ${input.brief}`,
    ``,
  ];
  transcript.forEach((round, idx) => {
    lines.push(`## Round ${idx + 1}`);
    for (const r of round) {
      lines.push(``);
      lines.push(`### ${r.agent} (decision: ${r.decision})`);
      lines.push(``);
      lines.push(`**Overall assessment:** ${r.overallAssessment}`);
      if (r.agreements.length > 0) {
        lines.push(``);
        lines.push(`**Agreements:**`);
        for (const a of r.agreements) lines.push(`- ${a}`);
      }
      if (r.disagreements.length > 0) {
        lines.push(``);
        lines.push(`**Disagreements:**`);
        for (const d of r.disagreements) {
          lines.push(
            `- (${d.severity}) ${d.description} → ${d.proposedResolution}`,
          );
        }
      }
      if (r.openQuestions.length > 0) {
        lines.push(``);
        lines.push(`**Open questions:**`);
        for (const q of r.openQuestions) {
          const tag = q.requiresUserInput ? " [requires user input]" : "";
          lines.push(`- ${q.question}${tag}`);
        }
      }
      lines.push(``);
      lines.push(`**Design document:**`);
      lines.push(``);
      lines.push(r.designDocument);
    }
    lines.push(``);
  });
  return lines.join("\n");
}

function formatOpenQuestions(
  transcript: CollaborationRoundResponse[][],
): string {
  const lines: string[] = [`# Collaboration Mode open questions`, ``];
  const unresolved: Array<{
    round: number;
    agent: CollaborationAgent;
    question: CollaborationOpenQuestion;
  }> = [];
  transcript.forEach((round, idx) => {
    for (const r of round) {
      for (const q of r.openQuestions) {
        unresolved.push({ round: idx + 1, agent: r.agent, question: q });
      }
    }
  });
  if (unresolved.length === 0) {
    lines.push(`(no open questions)`);
    return lines.join("\n");
  }
  for (const u of unresolved) {
    const tag = u.question.requiresUserInput ? " [requires user input]" : "";
    lines.push(`- Round ${u.round} (${u.agent}): ${u.question.question}${tag}`);
  }
  return lines.join("\n");
}
