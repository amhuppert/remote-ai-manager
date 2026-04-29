/**
 * End-to-end Collaboration Mode tests.
 *
 * These tests exercise the full path from HTTP route handler down to the
 * primitive-native slice without mocking any internal module:
 *
 *   route handlers --> manager --> runCollaborationSlice --> primitives
 *
 * The boundary that gets stubbed is the agent backend itself (`callAgent`),
 * because hitting real Claude/Codex backends in unit tests would be slow and
 * non-deterministic. Every other dependency is the real production
 * implementation, wired via dependency injection and an in-memory envelope
 * store + temp worktree directory so the test does not depend on the
 * file-system-backed session state.
 *
 * Scenarios covered (per the Collaboration Mode end-to-end wiring task):
 *  - start: POST creates an envelope and 2 lanes
 *  - converge: a successful run writes 3 artifacts and completes the envelope
 *  - pause: a `requiresUserInput: true` open-question parks the envelope
 *  - resume: POSTing the matching token resumes the envelope to running
 *  - max-iterations: a non-converging run halts with `failed` status
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { createCollaborationRouteHandlers } from "./route-handlers";
import {
  createCollaborationManager,
  type CollaborationManagerDeps,
} from "./manager";
import { runCollaborationSlice, type CollaborationSliceResult } from "./slice";
import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  type CollaborationAgent,
  type CollaborationDecision,
  type CollaborationOpenQuestion,
  type CollaborationRoundResponse,
} from "./types";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createLaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import {
  createInMemoryWorkflowEnvelopeStore,
  type WorkflowEnvelopeStore,
} from "@/lib/workflows/primitives/workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import { createStatusBus } from "@/lib/workflows/primitives/status-bus";
import type {
  AgentTaskRunner,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type {
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";

interface ProgrammedAgent {
  receivedRequests: AgentCallRequest[];
  taskRunners: Record<"claude" | "codex", AgentTaskRunner>;
  conversationFactories: Record<"claude" | "codex", ConversationBackendFactory>;
}

/**
 * Builds programmable backend stubs that the production caller resolves via
 * its `getTaskRunner` / `getConversationBackendFactory` injection points.
 *
 * Tests still describe responses as `AgentCallResult` (the post-facade shape
 * the slice consumes). The stubs translate each programmed result back into
 * the backend-level shape (`AgentTaskResult` / `ConversationBackendTurnResult`)
 * so the facade re-derives the slice-facing AgentCallResult exactly the way
 * production does. This guarantees the test traverses
 * `createCollaborationProductionCallAgent` end-to-end — including the
 * lane-aware path for round calls and the lane-less path for the scribe.
 */
function makeProgrammedAgent(
  responsesByBackend: Record<"claude" | "codex", AgentCallResult[]>,
): ProgrammedAgent {
  const queues: Record<"claude" | "codex", AgentCallResult[]> = {
    claude: [...responsesByBackend.claude],
    codex: [...responsesByBackend.codex],
  };
  const receivedRequests: AgentCallRequest[] = [];

  const popResult = (backend: "claude" | "codex"): AgentCallResult => {
    const next = queues[backend].shift();
    if (!next) {
      throw new Error(
        `programmed backend stub ran out of responses for "${backend}"`,
      );
    }
    return next;
  };

  const buildTaskRunner = (backend: "claude" | "codex"): AgentTaskRunner => ({
    backend,
    async run(): Promise<AgentTaskResult> {
      const result = popResult(backend);
      if (result.outcome.kind !== "completed") {
        return {
          backendRef: result.backendRef ?? null,
          text: null,
          structuredOutput: undefined,
          usage: null,
          error:
            result.outcome.kind === "failed"
              ? result.outcome.error.message
              : `unexpected outcome kind: ${result.outcome.kind}`,
          timedOut: false,
        };
      }
      return {
        backendRef: result.backendRef ?? null,
        text: result.outcome.text,
        ...(result.outcome.structuredOutput !== undefined
          ? { structuredOutput: result.outcome.structuredOutput }
          : {}),
        usage: null,
        error: null,
        timedOut: false,
      };
    },
  });

  const buildConversationFactory = (
    backend: "claude" | "codex",
  ): ConversationBackendFactory => ({
    backend,
    async createRuntime(): Promise<ConversationBackendRuntime> {
      const runtime: ConversationBackendRuntime = {
        backend,
        status: "alive",
        capabilities: {
          queueWhileRunning: backend === "claude",
          askUserQuestion: backend === "claude",
          preciseFork: backend === "claude",
          portableMcpAtStart: backend === "codex",
          portableMcpBetweenTurns: backend === "claude",
          contextWindowMetrics: backend === "claude",
        },
        modelId: undefined,
        reasoningEffort: undefined,
        outputFormat: undefined,
        async sendTurn(
          _input: ConversationBackendTurnInput,
        ): Promise<ConversationBackendTurnResult> {
          const result = popResult(backend);
          if (result.outcome.kind !== "completed") {
            return {
              backendRef: result.backendRef ?? null,
              costUsd: null,
              durationMs: null,
              numTurns: null,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [],
              aborted: false,
              error:
                result.outcome.kind === "failed"
                  ? result.outcome.error.message
                  : `unexpected outcome kind: ${result.outcome.kind}`,
            };
          }
          return {
            backendRef: result.backendRef ?? null,
            costUsd: null,
            durationMs: null,
            numTurns: null,
            contextTokens: null,
            contextWindowMax: null,
            contentBlocks:
              result.outcome.text !== null && result.outcome.text.length > 0
                ? [{ type: "text", text: result.outcome.text }]
                : [],
            ...(result.outcome.structuredOutput !== undefined
              ? { structuredOutput: result.outcome.structuredOutput }
              : {}),
            aborted: false,
            error: null,
          };
        },
        close(): void {
          // no-op
        },
      };
      return runtime;
    },
  });

  return {
    receivedRequests,
    taskRunners: {
      claude: buildTaskRunner("claude"),
      codex: buildTaskRunner("codex"),
    },
    conversationFactories: {
      claude: buildConversationFactory("claude"),
      codex: buildConversationFactory("codex"),
    },
  };
}

function roundResponse(
  agent: CollaborationAgent,
  round: number,
  decision: CollaborationDecision,
  opts: {
    designDocument?: string;
    openQuestions?: CollaborationOpenQuestion[];
  } = {},
): CollaborationRoundResponse {
  return {
    agent,
    round,
    overallAssessment: `${agent} round ${round} assessment`,
    agreements: [],
    disagreements: [],
    openQuestions: opts.openQuestions ?? [],
    designDocument: opts.designDocument ?? `${agent} round ${round} design`,
    decision,
  };
}

function agentResult(
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
    usage: { durationMs: 50 },
    artifacts: [],
    outcome: {
      kind: "completed",
      text: structuredOutput.designDocument,
      structuredOutput,
    },
  };
}

function scribeResult(
  backend: "claude" | "codex",
  text: string,
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
    usage: { durationMs: 50 },
    artifacts: [],
    outcome: { kind: "completed", text, structuredOutput: undefined },
  };
}

interface E2EHarness {
  envelopeStore: WorkflowEnvelopeStore;
  laneStore: ReturnType<typeof createInMemoryLaneStore>;
  worktreePath: string;
  programmed: ProgrammedAgent;
  manager: ReturnType<typeof createCollaborationManager>;
  handlers: ReturnType<typeof createCollaborationRouteHandlers>;
  sliceCompletions: Promise<CollaborationSliceResult>[];
  awaitNextSlice(): Promise<CollaborationSliceResult>;
}

async function buildHarness(input: {
  programmed: ProgrammedAgent;
  worktreePath: string;
  envelopeStore?: WorkflowEnvelopeStore;
  workflowId?: string;
}): Promise<E2EHarness> {
  const envelopeStore =
    input.envelopeStore ?? createInMemoryWorkflowEnvelopeStore();
  const laneStore = createInMemoryLaneStore();

  const sliceCompletions: Promise<CollaborationSliceResult>[] = [];
  const pendingResolvers: Array<{
    resolve: (r: CollaborationSliceResult) => void;
    reject: (e: Error) => void;
  }> = [];

  const queueNext = (): void => {
    let resolveSlice: (result: CollaborationSliceResult) => void = () =>
      undefined;
    let rejectSlice: (err: Error) => void = () => undefined;
    const p = new Promise<CollaborationSliceResult>((resolve, reject) => {
      resolveSlice = resolve;
      rejectSlice = reject;
    });
    sliceCompletions.push(p);
    pendingResolvers.push({ resolve: resolveSlice, reject: rejectSlice });
  };
  queueNext();

  const managerDeps: Partial<CollaborationManagerDeps> = {
    resolveSession: async () => ({ worktreePath: input.worktreePath }),
    createDeps: (createDepsInput) => {
      const laneService =
        createDepsInput.laneService ?? createLaneService({ store: laneStore });
      const laneScheduler = createLaneScheduler();
      const artifactRegistry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        registration: {
          registerReferenceDocument: async () => undefined,
        },
      });
      const statusBus = createStatusBus({ broadcast: () => undefined });

      return {
        callAgent: createDepsInput.callAgent,
        laneService,
        laneScheduler,
        envelopeStore,
        artifactRegistry,
        statusBus,
      };
    },
    buildLaneService: () => createLaneService({ store: laneStore }),
    buildCallAgent: (buildInput) =>
      createCollaborationProductionCallAgent({
        workflowId: buildInput.workflowId,
        projectPath: buildInput.projectPath,
        sessionName: buildInput.sessionName,
        worktreePath: buildInput.worktreePath,
        sessionKey: `${buildInput.projectPath}::${buildInput.sessionName}`,
        laneService: buildInput.laneService,
        getTaskRunner: (backend) => {
          if (backend !== "claude" && backend !== "codex") {
            throw new Error(`unsupported backend in test: ${backend}`);
          }
          return input.programmed.taskRunners[backend];
        },
        getConversationBackendFactory: (backend) => {
          if (backend !== "claude" && backend !== "codex") {
            throw new Error(`unsupported backend in test: ${backend}`);
          }
          return input.programmed.conversationFactories[backend];
        },
      }),
    createEnvelopeRepository: () =>
      createWorkflowEnvelopeRepository({ store: envelopeStore }),
    runSlice: async (sliceInput, sliceDeps) => {
      const next = pendingResolvers.shift();
      try {
        const result = await runCollaborationSlice(sliceInput, sliceDeps);
        next?.resolve(result);
        queueNext();
        return result;
      } catch (err) {
        next?.reject(err as Error);
        queueNext();
        throw err;
      }
    },
    newWorkflowId: () => input.workflowId ?? "wf-e2e",
    now: () => new Date().toISOString(),
  };

  const manager = createCollaborationManager(managerDeps);
  const handlers = createCollaborationRouteHandlers({
    resolveProjectPath: async () => "/projects/e2e",
    manager,
  });

  let consumed = 0;
  const awaitNextSlice = (): Promise<CollaborationSliceResult> => {
    const p = sliceCompletions[consumed];
    consumed++;
    if (!p) throw new Error("no slice run pending");
    return p;
  };

  return {
    envelopeStore,
    laneStore,
    worktreePath: input.worktreePath,
    programmed: input.programmed,
    manager,
    handlers,
    sliceCompletions,
    awaitNextSlice,
  };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-e2e-"));
});

function buildContext(
  projectName: string,
  sessionName: string,
): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({ name: projectName, session: sessionName }),
  };
}

function buildWorkflowContext(
  projectName: string,
  sessionName: string,
  workflowId: string,
): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({
      name: projectName,
      session: sessionName,
      workflowId,
    }),
  };
}

describe("Collaboration Mode end-to-end", () => {
  it("start → converge: returns 202 then writes 3 artifacts and marks the envelope completed", async () => {
    const programmed = makeProgrammedAgent({
      claude: [
        agentResult("claude", roundResponse("claude", 1, "accept")),
        scribeResult("claude", "# Merged design\n\nFinal."),
      ],
      codex: [agentResult("codex", roundResponse("codex", 1, "accept"))],
    });
    const harness = await buildHarness({
      programmed,
      worktreePath: workingDir,
      workflowId: "wf-converge",
    });

    const response = await harness.handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "Design a thing.",
          maxIterations: 5,
          scribeBackend: "claude",
        }),
      }),
      buildContext("e2e-project", "sess-converge"),
    );

    expect(response.status).toBe(202);
    const startBody = (await response.json()) as {
      workflowId: string;
      status: string;
      statusUrl: string;
    };
    expect(startBody.workflowId).toBe("wf-converge");
    expect(startBody.status).toBe("started");
    expect(startBody.statusUrl).toContain("wf-converge");
    expect(startBody.statusUrl).toContain("collaboration");

    const result = await harness.awaitNextSlice();
    expect(result.kind).toBe("completed");

    const lanes = await harness.laneStore.listByWorkflow("wf-converge");
    expect(lanes.length).toBe(2);
    const laneIds = lanes.map((l) => l.laneId);
    expect(laneIds).toContain("claude");
    expect(laneIds).toContain("codex");

    const envelope = await harness.envelopeStore.read("wf-converge");
    expect(envelope?.status).toBe("completed");
    expect(envelope?.workflowType).toBe("collaboration");
    expect(envelope?.completedAt).toBeTruthy();

    const merged = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/wf-converge/merged-design.md",
      ),
      "utf-8",
    );
    expect(merged).toContain("Merged design");

    const transcript = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/wf-converge/transcript.md",
      ),
      "utf-8",
    );
    expect(transcript).toContain("claude round 1 design");
    expect(transcript).toContain("codex round 1 design");

    const openQuestions = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/wf-converge/open-questions.md",
      ),
      "utf-8",
    );
    expect(openQuestions).toBeTruthy();
  });

  it("start: a 200 LIST after a successful run surfaces the completed envelope", async () => {
    const programmed = makeProgrammedAgent({
      claude: [
        agentResult("claude", roundResponse("claude", 1, "accept")),
        scribeResult("claude", "# Merged"),
      ],
      codex: [agentResult("codex", roundResponse("codex", 1, "accept"))],
    });
    const harness = await buildHarness({
      programmed,
      worktreePath: workingDir,
      workflowId: "wf-list",
    });

    await harness.handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "Brief.",
          maxIterations: 3,
          scribeBackend: "claude",
        }),
      }),
      buildContext("e2e-project", "sess-list"),
    );
    await harness.awaitNextSlice();

    const listResponse = await harness.handlers.LIST(
      new Request("http://test/collab", { method: "GET" }),
      buildContext("e2e-project", "sess-list"),
    );

    expect(listResponse.status).toBe(200);
    // listActive filters out completed envelopes (they are not "active"
    // anymore), so the list MUST be empty after convergence — proves the
    // route returns a fresh repo read rather than a stale snapshot.
    const listBody = (await listResponse.json()) as {
      envelopes: { workflowId: string; status: string }[];
    };
    expect(listBody.envelopes).toEqual([]);
  });

  it("pause: requiresUserInput: true open-question parks the envelope as paused with a resume token", async () => {
    const pauseQuestion: CollaborationOpenQuestion = {
      question: "Should we use Postgres or SQLite?",
      requiresUserInput: true,
    };
    const programmed = makeProgrammedAgent({
      claude: [
        agentResult(
          "claude",
          roundResponse("claude", 1, "reject", {
            openQuestions: [pauseQuestion],
          }),
        ),
      ],
      codex: [agentResult("codex", roundResponse("codex", 1, "accept"))],
    });
    const harness = await buildHarness({
      programmed,
      worktreePath: workingDir,
      workflowId: "wf-paused",
    });

    await harness.handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "Brief.",
          maxIterations: 5,
          scribeBackend: "claude",
        }),
      }),
      buildContext("e2e-project", "sess-paused"),
    );

    const result = await harness.awaitNextSlice();
    expect(result.kind).toBe("paused");

    const envelope = await harness.envelopeStore.read("wf-paused");
    expect(envelope?.status).toBe("paused");
    expect(envelope?.pause?.gateKind).toBe("human_approval");
    expect(envelope?.pause?.resumeToken).toBeTruthy();
  });

  it("resume: POSTing the matching token re-enters the slice and lets the workflow converge", async () => {
    const pauseQuestion: CollaborationOpenQuestion = {
      question: "Pick one option, please.",
      requiresUserInput: true,
    };
    const programmed = makeProgrammedAgent({
      claude: [
        agentResult(
          "claude",
          roundResponse("claude", 1, "reject", {
            openQuestions: [pauseQuestion],
          }),
        ),
        agentResult("claude", roundResponse("claude", 2, "accept")),
        scribeResult("claude", "# Merged design\n\nFinal."),
      ],
      codex: [
        agentResult("codex", roundResponse("codex", 1, "accept")),
        agentResult("codex", roundResponse("codex", 2, "accept")),
      ],
    });
    const harness = await buildHarness({
      programmed,
      worktreePath: workingDir,
      workflowId: "wf-resume",
    });

    await harness.handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "Brief.",
          maxIterations: 5,
          scribeBackend: "claude",
        }),
      }),
      buildContext("e2e-project", "sess-resume"),
    );
    await harness.awaitNextSlice();

    const paused = await harness.envelopeStore.read("wf-resume");
    const resumeToken = paused?.pause?.resumeToken;
    expect(resumeToken).toBeTruthy();

    const wrongResponse = await harness.handlers.RESUME(
      new Request("http://test/collab/wf-resume/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "definitely-wrong",
          userAnswers: { "q-r1": "Postgres" },
        }),
      }),
      buildWorkflowContext("e2e-project", "sess-resume", "wf-resume"),
    );
    expect(wrongResponse.status).toBe(403);

    const goodResponse = await harness.handlers.RESUME(
      new Request("http://test/collab/wf-resume/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken,
          userAnswers: { "Pick one option, please.": "Postgres" },
        }),
      }),
      buildWorkflowContext("e2e-project", "sess-resume", "wf-resume"),
    );
    expect(goodResponse.status).toBe(200);
    const resumedBody = (await goodResponse.json()) as {
      workflowId: string;
      status: string;
    };
    expect(resumedBody).toEqual({
      workflowId: "wf-resume",
      status: "resumed",
    });

    const resumeResult = await harness.awaitNextSlice();
    expect(resumeResult.kind).toBe("completed");

    const reread = await harness.envelopeStore.read("wf-resume");
    expect(reread?.status).toBe("completed");
    expect(reread?.pause).toBeUndefined();
    const snapshot = reread?.featureSnapshot as Record<string, unknown>;
    const userAnswers = snapshot["userAnswersByRound"] as Record<
      string,
      Record<string, string>
    >;
    expect(userAnswers).toBeDefined();
    expect(Object.values(userAnswers)[0]).toEqual({
      "Pick one option, please.": "Postgres",
    });
  });

  it("max-iterations: a never-converging run halts and marks the envelope completed (with errorSummary)", async () => {
    const programmed = makeProgrammedAgent({
      claude: [
        agentResult("claude", roundResponse("claude", 1, "reject")),
        agentResult("claude", roundResponse("claude", 2, "reject")),
      ],
      codex: [
        agentResult("codex", roundResponse("codex", 1, "reject")),
        agentResult("codex", roundResponse("codex", 2, "reject")),
      ],
    });
    const harness = await buildHarness({
      programmed,
      worktreePath: workingDir,
      workflowId: "wf-max",
    });

    await harness.handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "Brief.",
          maxIterations: 2,
          scribeBackend: "claude",
        }),
      }),
      buildContext("e2e-project", "sess-max"),
    );

    const result = await harness.awaitNextSlice();
    expect(result.kind).toBe("halted");

    const envelope = await harness.envelopeStore.read("wf-max");
    expect(envelope?.status).toBe("completed");
    expect(envelope?.errorSummary).toBeTruthy();

    const transcript = await fs.readFile(
      path.join(workingDir, "memory-bank/collaboration/wf-max/transcript.md"),
      "utf-8",
    );
    expect(transcript).toContain("claude round 1 design");
  });
});
