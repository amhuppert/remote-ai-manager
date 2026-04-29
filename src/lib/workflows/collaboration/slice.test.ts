/**
 * Collaboration Mode primitive-native slice tests.
 *
 * These tests prove that the slice composes the primitive set
 * (AgentCall, Lane, ConvergenceGate, HumanApprovalGate, ArtifactRegistry,
 * StatusBus, WorkflowEnvelope) for the Collaboration Mode design described in
 * `memory-bank/focus.md`:
 *
 *  - Round 1: both agents produce independent proposals in parallel.
 *  - Round R≥2: each agent receives the other's prior design plus their
 *    review of mine.
 *  - Convergence: both agents emit `decision: "accept"` in the same round.
 *  - Pause: any open question with `requiresUserInput: true` parks the
 *    workflow on a post-turn human-approval gate.
 *  - Final pass: a chosen scribe agent emits a single merged design.
 *  - Artifacts: merged design, transcript, open-questions punch list — all
 *    written under `memory-bank/collaboration/<workflowId>/` and registered.
 *  - Workflow envelope: durable lifecycle visible across rounds (running →
 *    paused | completed | failed).
 *  - Status bus: scoped envelopes (`scope: "collaboration"`) for round
 *    started, paused, completed, failed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import {
  runCollaborationSlice,
  type CollaborationSliceDeps,
  type CollaborationSliceInput,
} from "./slice";
import {
  COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA,
  type CollaborationAgent,
  type CollaborationDecision,
  type CollaborationOpenQuestion,
  type CollaborationRoundResponse,
} from "./types";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  createArtifactRegistry,
  type ArtifactRegistration,
} from "@/lib/workflows/primitives/artifact-registry";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/workflows/primitives/status-bus";
import {
  createLaneScheduler,
  type LaneScheduler,
  type LaneScheduleRequest,
} from "@/lib/workflows/primitives/lane-scheduler";

interface ProgrammedCallAgent {
  callAgent: CollaborationSliceDeps["callAgent"];
  receivedRequests: AgentCallRequest[];
}

function makeProgrammedCallAgent(
  responsesByBackend: Record<"claude" | "codex", AgentCallResult[]>,
): ProgrammedCallAgent {
  const queues: Record<"claude" | "codex", AgentCallResult[]> = {
    claude: [...responsesByBackend.claude],
    codex: [...responsesByBackend.codex],
  };
  const receivedRequests: AgentCallRequest[] = [];

  const callAgent: CollaborationSliceDeps["callAgent"] = async (request) => {
    receivedRequests.push(request);
    const backend =
      request.kind === "conversation_turn"
        ? (request.backend ?? "claude")
        : request.backend;
    const queue = queues[backend];
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `programmed call-agent ran out of responses for backend "${backend}" (request count so far: ${receivedRequests.length})`,
      );
    }
    return next;
  };

  return { callAgent, receivedRequests };
}

function makeAgentCallResult(
  backend: "claude" | "codex",
  structuredOutput: CollaborationRoundResponse,
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
    usage: { durationMs: 100 },
    artifacts: [],
    outcome: {
      kind: "completed",
      text: structuredOutput.designDocument,
      structuredOutput,
    },
  };
}

function makeScribeResult(
  backend: "claude" | "codex",
  mergedDesign: string,
): AgentCallResult {
  return {
    backend,
    backendRef:
      backend === "claude"
        ? { backend: "claude", sessionId: `sess-scribe-${backend}` }
        : { backend: "codex", threadId: `th-scribe-${backend}` },
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
      text: mergedDesign,
      structuredOutput: undefined,
    },
  };
}

function makeRoundResponse(
  agent: CollaborationAgent,
  round: number,
  decision: CollaborationDecision,
  opts: {
    designDocument?: string;
    openQuestions?: CollaborationOpenQuestion[];
    agreements?: string[];
    overallAssessment?: string;
  } = {},
): CollaborationRoundResponse {
  return {
    agent,
    round,
    overallAssessment:
      opts.overallAssessment ?? `${agent} round ${round} assessment`,
    agreements: opts.agreements ?? [],
    disagreements: [],
    openQuestions: opts.openQuestions ?? [],
    designDocument: opts.designDocument ?? `${agent} round ${round} design`,
    decision,
  };
}

interface BuiltDeps {
  deps: CollaborationSliceDeps;
  capturedEnvelopes: StatusBusEnvelope[];
  capturedRegistrations: Array<{ relativePath: string; description: string }>;
  envelopeStore: ReturnType<typeof createInMemoryWorkflowEnvelopeStore>;
  laneStore: ReturnType<typeof createInMemoryLaneStore>;
  scheduledRequests: LaneScheduleRequest[];
}

async function buildDeps(
  programmed: ProgrammedCallAgent,
  _worktreePath: string,
): Promise<BuiltDeps> {
  const laneStore = createInMemoryLaneStore();
  const laneService = createLaneService({ store: laneStore });
  const envelopeStore = createInMemoryWorkflowEnvelopeStore();

  const capturedRegistrations: Array<{
    relativePath: string;
    description: string;
  }> = [];
  const registration: ArtifactRegistration = {
    registerReferenceDocument: async (input) => {
      capturedRegistrations.push({
        relativePath: input.relativePath,
        description: input.description,
      });
    },
  };
  const artifactRegistry = createArtifactRegistry({
    writeFile: (absolutePath, contents) => fs.writeFile(absolutePath, contents),
    ensureDir: (absolutePath) =>
      fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
    registration,
  });

  const capturedEnvelopes: StatusBusEnvelope[] = [];
  const statusBus = createStatusBus({
    broadcast: (envelope) => capturedEnvelopes.push(envelope),
  });

  const baseScheduler = createLaneScheduler();
  const scheduledRequests: LaneScheduleRequest[] = [];
  const laneScheduler: LaneScheduler = {
    schedule: (request, fn) => {
      scheduledRequests.push(request);
      return baseScheduler.schedule(request, fn);
    },
  };

  const deps: CollaborationSliceDeps = {
    callAgent: programmed.callAgent,
    laneService,
    laneScheduler,
    envelopeStore,
    artifactRegistry,
    statusBus,
  };

  return {
    deps,
    capturedEnvelopes,
    capturedRegistrations,
    envelopeStore,
    laneStore,
    scheduledRequests,
  };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-slice-"));
});

describe("runCollaborationSlice — round 1 convergence", () => {
  it("runs round 1 in parallel, gathers both lanes' accept votes, runs the scribe, and registers all three artifacts", async () => {
    const claudeRound1 = makeRoundResponse("claude", 1, "accept", {
      designDocument: "# Claude design v1",
    });
    const codexRound1 = makeRoundResponse("codex", 1, "accept", {
      designDocument: "# Codex design v1",
    });
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", claudeRound1),
        makeScribeResult("claude", "# Merged design\n\nFinal."),
      ],
      codex: [makeAgentCallResult("codex", codexRound1)],
    });

    const built = await buildDeps(programmed, workingDir);
    const input: CollaborationSliceInput = {
      workflowId: "collab-1",
      brief: "Design a thing.",
      worktreePath: workingDir,
      sessionKey: "tests/collab-shared",
      maxIterations: 5,
      scribeBackend: "claude",
    };

    const result = await runCollaborationSlice(input, built.deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.rounds).toBe(1);
    expect(result.mergedDesignArtifactId).toBeTruthy();
    expect(result.transcriptArtifactId).toBeTruthy();
    expect(result.openQuestionsArtifactId).toBeTruthy();

    const envelope = await built.envelopeStore.read("collab-1");
    expect(envelope?.status).toBe("completed");
    expect(envelope?.workflowType).toBe("collaboration");
    expect(envelope?.completedAt).toBeTruthy();

    const claudeLane = await built.laneStore.read({
      workflowId: "collab-1",
      laneId: "claude",
    });
    const codexLane = await built.laneStore.read({
      workflowId: "collab-1",
      laneId: "codex",
    });
    expect(claudeLane?.backend).toBe("claude");
    expect(codexLane?.backend).toBe("codex");

    const registeredPaths = built.capturedRegistrations
      .map((r) => r.relativePath)
      .sort();
    expect(registeredPaths).toEqual([
      "memory-bank/collaboration/collab-1/merged-design.md",
      "memory-bank/collaboration/collab-1/open-questions.md",
      "memory-bank/collaboration/collab-1/transcript.md",
    ]);

    const merged = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/collab-1/merged-design.md",
      ),
      "utf-8",
    );
    expect(merged).toContain("# Merged design");

    const transcript = await fs.readFile(
      path.join(workingDir, "memory-bank/collaboration/collab-1/transcript.md"),
      "utf-8",
    );
    expect(transcript).toContain("Claude design v1");
    expect(transcript).toContain("Codex design v1");
  });

  it("uses the configured scribeBackend for the final merge call", async () => {
    const claudeRound1 = makeRoundResponse("claude", 1, "accept");
    const codexRound1 = makeRoundResponse("codex", 1, "accept");
    const programmed = makeProgrammedCallAgent({
      claude: [makeAgentCallResult("claude", claudeRound1)],
      codex: [
        makeAgentCallResult("codex", codexRound1),
        makeScribeResult("codex", "# Codex-scribed merged design"),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-2",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "codex",
      },
      built.deps,
    );

    expect(result.kind).toBe("completed");
    const merged = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/collab-2/merged-design.md",
      ),
      "utf-8",
    );
    expect(merged).toContain("Codex-scribed merged design");

    const codexRequests = programmed.receivedRequests.filter(
      (r) => r.kind === "task_run" && r.backend === "codex",
    );
    expect(codexRequests.length).toBe(2);
  });

  it("publishes scoped collaboration envelopes for round_started and completed", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-3",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const collabEnvelopes = built.capturedEnvelopes.filter(
      (e) => e.scope === "collaboration",
    );
    expect(collabEnvelopes.length).toBeGreaterThanOrEqual(2);
    expect(collabEnvelopes[0]?.scopeId).toBe("collab-3");
    expect(collabEnvelopes[0]?.status).toBe("running");
    expect(collabEnvelopes[collabEnvelopes.length - 1]?.status).toBe(
      "completed",
    );
  });
});

describe("runCollaborationSlice — pause for user input", () => {
  it("pauses the workflow with a post_turn human_approval gate when any open question requires user input", async () => {
    const claudeRound1 = makeRoundResponse("claude", 1, "accept", {
      openQuestions: [
        {
          question: "Which storage backend should we use?",
          requiresUserInput: true,
        },
      ],
    });
    const codexRound1 = makeRoundResponse("codex", 1, "accept");
    const programmed = makeProgrammedCallAgent({
      claude: [makeAgentCallResult("claude", claudeRound1)],
      codex: [makeAgentCallResult("codex", codexRound1)],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-pause",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("paused");
    if (result.kind !== "paused") return;
    expect(result.reason).toBe("user_input_required");
    expect(result.resumeToken).toBeTruthy();
    expect(result.openQuestions.length).toBe(1);
    expect(result.openQuestions[0]?.question).toBe(
      "Which storage backend should we use?",
    );

    const envelope = await built.envelopeStore.read("collab-pause");
    expect(envelope?.status).toBe("paused");
    expect(envelope?.pause?.gateKind).toBe("human_approval");
    expect(envelope?.pause?.pauseKind).toBe("post_turn");
    expect(envelope?.pause?.resumeToken).toBe(result.resumeToken);

    const pausedEnvelope = built.capturedEnvelopes.find(
      (e) => e.scope === "collaboration" && e.status === "paused",
    );
    expect(pausedEnvelope).toBeTruthy();
  });

  it("does not run the scribe pass when paused for user input", async () => {
    const claudeRound1 = makeRoundResponse("claude", 1, "accept", {
      openQuestions: [{ question: "Which DB?", requiresUserInput: true }],
    });
    const codexRound1 = makeRoundResponse("codex", 1, "accept");
    const programmed = makeProgrammedCallAgent({
      claude: [makeAgentCallResult("claude", claudeRound1)],
      codex: [makeAgentCallResult("codex", codexRound1)],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-pause-2",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(programmed.receivedRequests.length).toBe(2);
  });
});

describe("runCollaborationSlice — review rounds", () => {
  it("runs a second round after a reject vote and feeds the prior round's design + review into each lane's prompt", async () => {
    const claudeRound1 = makeRoundResponse("claude", 1, "accept", {
      designDocument: "# Claude r1",
    });
    const codexRound1 = makeRoundResponse("codex", 1, "reject", {
      designDocument: "# Codex r1",
      overallAssessment: "needs more detail",
    });
    const claudeRound2 = makeRoundResponse("claude", 2, "accept", {
      designDocument: "# Claude r2",
    });
    const codexRound2 = makeRoundResponse("codex", 2, "accept", {
      designDocument: "# Codex r2",
    });

    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", claudeRound1),
        makeAgentCallResult("claude", claudeRound2),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", codexRound1),
        makeAgentCallResult("codex", codexRound2),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-r2",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.rounds).toBe(2);

    const round2ClaudePrompt = programmed.receivedRequests[2]?.prompt;
    expect(round2ClaudePrompt).toContain("# Codex r1");
    expect(round2ClaudePrompt).toContain("needs more detail");

    const round2CodexPrompt = programmed.receivedRequests[3]?.prompt;
    expect(round2CodexPrompt).toContain("# Claude r1");
  });
});

describe("runCollaborationSlice — max iterations exceeded", () => {
  it("halts after maxIterations rounds without convergence and marks the envelope failed", async () => {
    const reject = (agent: CollaborationAgent, round: number) =>
      makeRoundResponse(agent, round, "reject");
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", reject("claude", 1)),
        makeAgentCallResult("claude", reject("claude", 2)),
      ],
      codex: [
        makeAgentCallResult("codex", reject("codex", 1)),
        makeAgentCallResult("codex", reject("codex", 2)),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-halt",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 2,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("halted");
    if (result.kind !== "halted") return;
    expect(result.reason).toBe("max_iterations_exceeded");
    expect(result.rounds).toBe(2);

    const envelope = await built.envelopeStore.read("collab-halt");
    expect(envelope?.status).toBe("completed");
    expect(envelope?.errorSummary).toBeTruthy();

    const completedEnvelope = built.capturedEnvelopes.find(
      (e) => e.scope === "collaboration" && e.status === "completed",
    );
    expect(completedEnvelope).toBeTruthy();
  });
});

describe("runCollaborationSlice — lane lifecycle", () => {
  it("initializes one lane per agent with the correct backend, write capability, and policy", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-lanes",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const claudeLane = await built.laneStore.read({
      workflowId: "collab-lanes",
      laneId: "claude",
    });
    expect(claudeLane?.backend).toBe("claude");
    expect(claudeLane?.writeCapability).toBe("write_capable");
    expect(claudeLane?.policy.continuityEnabled).toBe(true);

    const codexLane = await built.laneStore.read({
      workflowId: "collab-lanes",
      laneId: "codex",
    });
    expect(codexLane?.backend).toBe("codex");
    expect(codexLane?.writeCapability).toBe("write_capable");
    expect(codexLane?.policy.continuityEnabled).toBe(false);
  });

  it("records lane outcomes after each round (conversationId / threadId carry through)", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-outcome",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const claudeLane = await built.laneStore.read({
      workflowId: "collab-outcome",
      laneId: "claude",
    });
    if (claudeLane?.backendState.backend !== "claude") {
      throw new Error("expected claude backendState branch");
    }
    expect(claudeLane.backendState.conversationId).toBe("sess-claude");

    const codexLane = await built.laneStore.read({
      workflowId: "collab-outcome",
      laneId: "codex",
    });
    if (codexLane?.backendState.backend !== "codex") {
      throw new Error("expected codex backendState branch");
    }
    expect(codexLane.backendState.threadId).toBe("th-codex");
  });

  it("preserves existing lane continuity when resuming a paused workflow", async () => {
    const observedBeforeCall: Record<string, string | undefined> = {};
    let laneStore: BuiltDeps["laneStore"] | null = null;
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 2, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 2, "accept")),
      ],
    });
    const built = await buildDeps(
      {
        receivedRequests: programmed.receivedRequests,
        callAgent: async (request) => {
          if (request.laneRef?.laneId === "claude") {
            const lane = await laneStore?.read(request.laneRef);
            observedBeforeCall.claude =
              lane?.backendState.backend === "claude"
                ? lane.backendState.conversationId
                : undefined;
          }
          if (request.laneRef?.laneId === "codex") {
            const lane = await laneStore?.read(request.laneRef);
            observedBeforeCall.codex =
              lane?.backendState.backend === "codex"
                ? lane.backendState.threadId
                : undefined;
          }
          return programmed.callAgent(request);
        },
      },
      workingDir,
    );
    laneStore = built.laneStore;
    await built.laneStore.write({
      workflowId: "collab-resume-lanes",
      laneId: "claude",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude", conversationId: "existing-claude" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T09:00:00.000Z",
    });
    await built.laneStore.write({
      workflowId: "collab-resume-lanes",
      laneId: "codex",
      backend: "codex",
      writeCapability: "write_capable",
      policy: { continuityEnabled: false },
      backendState: { backend: "codex", threadId: "existing-codex" },
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T09:00:00.000Z",
    });
    await built.envelopeStore.upsert("collab-resume-lanes", () => ({
      workflowId: "collab-resume-lanes",
      workflowType: "collaboration",
      status: "paused",
      phase: "paused_round_1",
      createdAt: "2026-04-28T09:00:00.000Z",
      updatedAt: "2026-04-28T09:00:00.000Z",
      featureSnapshot: {},
      pause: {
        pauseKind: "post_turn",
        gateKind: "human_approval",
        resumeToken: "token",
      },
    }));

    await runCollaborationSlice(
      {
        workflowId: "collab-resume-lanes",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 2,
        scribeBackend: "claude",
        resume: {
          resumeFromRound: 1,
          priorTranscript: [
            [
              makeRoundResponse("claude", 1, "reject"),
              makeRoundResponse("codex", 1, "reject"),
            ],
          ],
          userAnswersByRound: { 1: { q1: "answer" } },
        },
      },
      built.deps,
    );

    expect(observedBeforeCall).toEqual({
      claude: "existing-claude",
      codex: "existing-codex",
    });
  });
});

describe("runCollaborationSlice — request shapes", () => {
  it("sends a conversation_turn for the claude lane and a task_run for the codex lane, both with laneRef", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-shapes",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const round1Requests = programmed.receivedRequests.slice(0, 2);
    const claudeRequest = round1Requests.find(
      (r) => r.kind === "conversation_turn",
    );
    const codexRequest = round1Requests.find((r) => r.kind === "task_run");
    expect(claudeRequest).toBeTruthy();
    expect(codexRequest).toBeTruthy();
    expect(claudeRequest?.laneRef).toEqual({
      workflowId: "collab-shapes",
      laneId: "claude",
    });
    expect(codexRequest?.laneRef).toEqual({
      workflowId: "collab-shapes",
      laneId: "codex",
    });
  });

  it("does not leak the other lane's draft into the first round's prompt (write-capable lanes serialize through the scheduler)", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult(
          "claude",
          makeRoundResponse("claude", 1, "accept", {
            designDocument: "# Claude only",
          }),
        ),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult(
          "codex",
          makeRoundResponse("codex", 1, "accept", {
            designDocument: "# Codex only",
          }),
        ),
      ],
    });

    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-no-leak",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );
    expect(result.kind).toBe("completed");

    const round1Requests = programmed.receivedRequests.slice(0, 2);
    for (const request of round1Requests) {
      expect(request.prompt).not.toContain("# Claude only");
      expect(request.prompt).not.toContain("# Codex only");
    }
  });
});

describe("runCollaborationSlice — workflow envelope snapshot", () => {
  it("stores the brief and accumulating transcript as the envelope's featureSnapshot", async () => {
    const claudeR1 = makeRoundResponse("claude", 1, "accept", {
      designDocument: "# claude design",
    });
    const codexR1 = makeRoundResponse("codex", 1, "accept", {
      designDocument: "# codex design",
    });
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", claudeR1),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [makeAgentCallResult("codex", codexR1)],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-snap",
        brief: "Snapshot brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 5,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const envelope = await built.envelopeStore.read("collab-snap");
    expect(envelope).toBeTruthy();
    const snapshot = envelope?.featureSnapshot as {
      brief: string;
      transcript: CollaborationRoundResponse[][];
    };
    expect(snapshot.brief).toBe("Snapshot brief.");
    expect(snapshot.transcript.length).toBe(1);
    expect(snapshot.transcript[0]?.length).toBe(2);
  });
});

describe("runCollaborationSlice — lane scheduling", () => {
  it("serializes write-capable Claude and Codex round-1 calls through the LaneScheduler when sharing the same sessionKey", async () => {
    const order: string[] = [];
    let releaseClaude!: () => void;
    const claudeRelease = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    let releaseCodex!: () => void;
    const codexRelease = new Promise<void>((resolve) => {
      releaseCodex = resolve;
    });

    const callAgent: CollaborationSliceDeps["callAgent"] = async (request) => {
      const backend =
        request.kind === "conversation_turn"
          ? (request.backend ?? "claude")
          : request.backend;
      order.push(`${backend}:start`);
      if (backend === "claude" && order.length === 1) {
        await claudeRelease;
        order.push("claude:end");
        return makeAgentCallResult(
          "claude",
          makeRoundResponse("claude", 1, "accept"),
        );
      }
      if (backend === "codex" && order.length === 3) {
        await codexRelease;
        order.push("codex:end");
        return makeAgentCallResult(
          "codex",
          makeRoundResponse("codex", 1, "accept"),
        );
      }
      return makeScribeResult("claude", "# merged");
    };

    const built = await buildDeps(
      { callAgent, receivedRequests: [] },
      workingDir,
    );

    const slicePromise = runCollaborationSlice(
      {
        workflowId: "collab-sched-1",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "proj-x/collab-sched",
        maxIterations: 1,
        scribeBackend: "claude",
      },
      built.deps,
    );

    // Drain enough microtasks so the first scheduled task starts.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(["claude:start"]);

    releaseClaude();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(["claude:start", "claude:end", "codex:start"]);

    releaseCodex();
    await slicePromise;

    expect(order.slice(0, 4)).toEqual([
      "claude:start",
      "claude:end",
      "codex:start",
      "codex:end",
    ]);

    const laneScheduleCalls = built.scheduledRequests.filter(
      (r) => r.sessionKey === "proj-x/collab-sched",
    );
    expect(laneScheduleCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of laneScheduleCalls) {
      expect(call.writeCapability ?? "write_capable").toBe("write_capable");
    }
    const laneIds = laneScheduleCalls.map((c) => c.laneId).sort();
    expect(laneIds).toContain("claude");
    expect(laneIds).toContain("codex");
  });

  it("passes workflowId, laneId, sessionKey, and write_capable on every scheduled lane execution", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-sched-meta",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "proj-y/collab-meta",
        maxIterations: 1,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const laneScheduleCalls = built.scheduledRequests.filter(
      (r) => r.workflowId === "collab-sched-meta",
    );
    expect(laneScheduleCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of laneScheduleCalls) {
      expect(call.sessionKey).toBe("proj-y/collab-meta");
      expect(call.writeCapability).toBe("write_capable");
      expect(call.laneId).toMatch(/^(claude|codex)$/);
    }
  });
});

describe("runCollaborationSlice — structured output requests", () => {
  it("includes outputSchema matching CollaborationRoundResponse on every per-lane round request", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-schema-1",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 1,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const laneRequests = programmed.receivedRequests.filter(
      (r) => r.laneRef !== undefined,
    );
    expect(laneRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of laneRequests) {
      expect(request.outputSchema).toEqual(
        COLLABORATION_ROUND_RESPONSE_OUTPUT_SCHEMA,
      );
    }
  });

  it("does not request structured output on the scribe call (plain merged design text only)", async () => {
    const programmed = makeProgrammedCallAgent({
      claude: [
        makeAgentCallResult("claude", makeRoundResponse("claude", 1, "accept")),
        makeScribeResult("claude", "# merged"),
      ],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    await runCollaborationSlice(
      {
        workflowId: "collab-schema-scribe",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 1,
        scribeBackend: "claude",
      },
      built.deps,
    );

    const scribeRequest = programmed.receivedRequests.find(
      (r) => r.laneRef === undefined,
    );
    expect(scribeRequest).toBeTruthy();
    expect(scribeRequest?.outputSchema).toBeUndefined();
  });
});

describe("runCollaborationSlice — failure handling", () => {
  it("marks the envelope failed and publishes a failed status when an agent call returns a failed outcome (e.g. schema_validation)", async () => {
    const failedResult: AgentCallResult = {
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
      usage: { durationMs: 10 },
      artifacts: [],
      outcome: {
        kind: "failed",
        error: {
          failureKind: "schema_validation",
          backend: "claude",
          message: "structured output failed validation: missing 'agent'",
        },
      },
    };
    const programmed = makeProgrammedCallAgent({
      claude: [failedResult],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-fail-1",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 2,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).toBe("agent_call_failed");
    expect(result.errorSummary).toContain("schema_validation");

    const envelope = await built.envelopeStore.read("collab-fail-1");
    expect(envelope?.status).toBe("failed");
    expect(envelope?.errorSummary).toBeTruthy();
    expect(envelope?.errorSummary).toContain("schema_validation");

    const failedEnvelope = built.capturedEnvelopes.find(
      (e) => e.scope === "collaboration" && e.status === "failed",
    );
    expect(failedEnvelope).toBeTruthy();
  });

  it("marks the envelope failed when an agent call pauses unexpectedly mid-turn", async () => {
    const pausedResult: AgentCallResult = {
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
      usage: { durationMs: 10 },
      artifacts: [],
      outcome: {
        kind: "paused",
        pauseKind: "mid_turn",
        resumeToken: "resume-1",
      },
    };
    const programmed = makeProgrammedCallAgent({
      claude: [pausedResult],
      codex: [
        makeAgentCallResult("codex", makeRoundResponse("codex", 1, "accept")),
      ],
    });
    const built = await buildDeps(programmed, workingDir);

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-fail-2",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 2,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("failed");
    const envelope = await built.envelopeStore.read("collab-fail-2");
    expect(envelope?.status).toBe("failed");
    expect(envelope?.errorSummary).toBeTruthy();
  });

  it("marks the envelope failed when the callAgent dependency throws", async () => {
    const callAgent: CollaborationSliceDeps["callAgent"] = async (request) => {
      const backend =
        request.kind === "conversation_turn"
          ? (request.backend ?? "claude")
          : request.backend;
      if (backend === "claude") {
        throw new Error("backend registry unavailable");
      }
      return makeAgentCallResult(
        "codex",
        makeRoundResponse("codex", 1, "accept"),
      );
    };
    const built = await buildDeps(
      { callAgent, receivedRequests: [] },
      workingDir,
    );

    const result = await runCollaborationSlice(
      {
        workflowId: "collab-throw-1",
        brief: "Brief.",
        worktreePath: workingDir,
        sessionKey: "tests/collab-shared",
        maxIterations: 2,
        scribeBackend: "claude",
      },
      built.deps,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorSummary).toContain("backend registry unavailable");

    const envelope = await built.envelopeStore.read("collab-throw-1");
    expect(envelope?.status).toBe("failed");
    expect(envelope?.errorSummary).toContain("backend registry unavailable");

    const failedEnvelope = built.capturedEnvelopes.find(
      (e) => e.scope === "collaboration" && e.status === "failed",
    );
    expect(failedEnvelope).toBeTruthy();
  });
});
