import { createContextIterationFixture } from "@/lib/workflow-graph/testing/iteration-fixture";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createContextTestCapabilities } from "@/lib/workflow-graph/testing/context-capabilities";
import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import { _resetForTesting as resetTaskRuntime } from "@/lib/workflows/conversation/runtime-state";

/**
 * R2.1 end-to-end: engine → production capture runner → canonical AgentCall
 * gate → FAKE AGENT BACKEND.
 *
 * Every other D2 test replaces one of those hops with a double, so none of them
 * can show that a real agent reply becomes a persisted, schema-conformant
 * output. Here only the backend is faked: it returns raw assistant text, and
 * the real `executeAgentCall` gate does the extraction fall-through, bounded
 * repair, and validation (its default validator IS the canonical
 * `validateJsonSchemaSubset`), the real capture runner translates the verdict,
 * and the real orchestrator decides whether the context may complete.
 *
 * The production host and admitted completion handle carry the original AgentCall
 * result through the task facade. Only provider execution and external
 * infrastructure are substituted; persistence uses an isolated SQLite fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import { DEFAULT_STRUCTURED_OUTPUT_REPAIR_ATTEMPTS } from "@/lib/workflows/primitives/agent-call-facade";
import { type ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";

import { createActorDependenciesFixture } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowOutputCaptureRunner } from "./context-output-capture-runner";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";

const NOW = "2026-03-27T16:10:00.000Z";
const RESUMED_BACKEND_REF = {
  backend: "claude" as const,
  ref: "sess-existing-lane",
};

const PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "risks"],
  additionalProperties: false,
};

/**
 * The fake agent backend. It returns assistant TEXT only — never a native
 * structured payload — so the gate's extraction path is what turns a reply into
 * a candidate, exactly as a Claude lane behaves.
 */
function fakeBackend(
  replies: readonly string[],
  capture: { requests: AgentTaskRequest[] },
): AgentTaskRunner {
  let index = 0;
  return {
    backend: "claude",
    async run(request) {
      capture.requests.push(request);
      const text = replies[Math.min(index, replies.length - 1)] ?? "";
      index += 1;
      const result: AgentTaskResult = {
        backendRef: { backend: "claude", ref: "sess-capture" },
        text,
        structuredOutput: undefined,
        usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
      return result;
    },
  };
}

/**
 * The production task-run path, with only the backend faked: the real actor
 * implementation (which runs the real `executeAgentCall` gate) followed by the
 * real hosted task facade and outcome projection. Every branch the
 * engine depends on — accepted payload with its provenance, schema rejection
 * with per-issue errors and the refused text, infrastructure failure — is
 * decided by production code here, not by this test.
 */
function productionTaskRun(
  runner: AgentTaskRunner,
): (input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult> {
  const actorDependencies = createActorDependenciesFixture({
    getTaskRunner: vi.fn(() => runner),
  });

  return async (input) => {
    const fixture = await createLifecycleFixture({
      binding: input.binding,
      conversation: { agentBackend: "claude", backendRef: RESUMED_BACKEND_REF },
      actorDeps: actorDependencies,
    });
    try {
      return await fixture.executeWorkflowTaskRun({
        ...input,
        binding: {
          ...input.binding,
          worktreePath: input.binding.worktreePath ?? "/repo",
        },
        resumeRef: input.resumeRef ?? RESUMED_BACKEND_REF,
      });
    } finally {
      await fixture.close();
    }
  };
}

interface Repository {
  getActive(): Promise<GraphWorkflowExecution | null>;
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
  findLatestContextValidationEvent(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowExecutionEvent | null>;
  read(): GraphWorkflowExecution;
  appendedEvents: GraphWorkflowExecutionEvent[];
}

function createRepository(initial: GraphWorkflowExecution): Repository {
  let active = initial;
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];
  return {
    async getActive() {
      return active;
    },
    async mutateActive(_projectPath, _sessionName, fn) {
      return applyFixtureMutation(active, fn, (next, delivery) => {
        active = next;
        appendedEvents.push(...delivery.events);
      });
    },
    async findLatestContextValidationEvent(
      _projectPath,
      _sessionName,
      _executionId,
      contextId,
    ) {
      for (let i = appendedEvents.length - 1; i >= 0; i -= 1) {
        const entry = appendedEvents[i]!;
        if (
          entry.event.type === "graph-workflow-validation-result" &&
          "contextId" in entry.event &&
          entry.event.contextId === contextId
        ) {
          return entry;
        }
      }
      return null;
    },
    read() {
      return active;
    },
    appendedEvents,
  };
}

function executionWithSchema(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
  });
  const planContext = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === "context-plan",
  );
  if (!planContext) throw new Error("fixture missing context-plan");
  planContext.outputSchema = PLAN_OUTPUT_SCHEMA;
  return execution;
}

/** Marks the context's single task done, the way a lane turn would. */
function completePlanTask(repository: Repository) {
  return vi.fn(async () => {
    const current = structuredClone(repository.read());
    current.taskStates["task-plan-1"] = {
      ...current.taskStates["task-plan-1"]!,
      status: "completed",
      summary: "Done",
      completedAt: NOW,
    };
    current.contextStates["context-plan"] = {
      ...current.contextStates["context-plan"]!,
      completedTaskCount: 1,
    };
    await repository
      .mutateActive("/repo", "session-1", () => changed(current))
      .then((mutation) => mutation.execution);
    return {
      conversationId: "conversation-lane",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    };
  });
}

function buildOrchestrator(
  repository: Repository,
  runner: AgentTaskRunner,
  signalHalt?: ReturnType<typeof vi.fn>,
) {
  // PRODUCTION capture runner over the production task-run path.
  const outputCaptureRunner = createGraphWorkflowOutputCaptureRunner({
    executeWorkflowTaskRun: productionTaskRun(runner),
  });

  return createContextIterationFixture({
    ...createContextTestCapabilities(),
    materializeWorkflowDocuments: async ({ execution }) => execution,

    executionContract: createNonParticipatingGraphExecutionContract(),

    executionRepository: repository,
    findLatestContextValidationEvent:
      repository.findLatestContextValidationEvent,
    createConversation: vi.fn(async () => ({ id: "conversation-lane" })),
    runAgentIteration: completePlanTask(repository),
    validationService: {
      validateContextCompletion: vi.fn(async () => ({
        kind: "pass" as const,
        summary: "All checks passed",
        feedback: "Context validation passed.",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: null,
        reviewArtifact: null,
      })),
    },
    outputCaptureService: outputCaptureRunner,
    ...(signalHalt ? { signalHalt } : {}),
    now: () => NOW,
  });
}

const ITERATION_INPUT = {
  projectPath: "/repo",
  projectName: "repo",
  sessionName: "session-1",
  contextId: "context-plan",
};

describe("context output capture against a fake agent backend (R2.1)", () => {
  beforeEach(() => {});

  it("drives a schema-declaring context to completed and persists a payload that parses against the declared schema", async () => {
    const repository = createRepository(executionWithSchema());
    const capture = { requests: [] as AgentTaskRequest[] };
    // Fenced JSON with prose around it: the gate's extraction fall-through is
    // what must recover the payload, since the fake backend returns no native
    // structured output.
    const runner = fakeBackend(
      [
        'Here is the output you asked for:\n\n```json\n{"summary":"Migrate the store first","risks":["schema drift"]}\n```\n',
      ],
      capture,
    );

    const result = await buildOrchestrator(repository, runner).runIteration(
      ITERATION_INPUT,
    );

    const persisted = repository.read();
    const captured = persisted.contextOutputs["context-plan"];
    expect(captured).toBeDefined();
    expect(captured?.value).toEqual({
      summary: "Migrate the store first",
      risks: ["schema drift"],
    });
    // The criterion's own check: the PERSISTED payload parses against the
    // DECLARED schema, verified by the same validator the gate used.
    expect(
      validateJsonSchemaSubset(PLAN_OUTPUT_SCHEMA, captured?.value).valid,
    ).toBe(true);
    // Recovered from text, not handed over natively — the gate did the work.
    expect(captured?.parse.source).toBe("fenced");

    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(result.decision.kind).toBe("ready_to_land");

    // The declared contract reached the backend verbatim.
    const captureRequest = capture.requests.at(-1);
    expect(captureRequest?.outputSchema).toEqual(PLAN_OUTPUT_SCHEMA);
    expect(captureRequest?.prompt).toContain("Final Output");
  });

  it.each([
    {
      label: "owned",
      placement: {
        lane: "shared",
        mode: "owned" as const,
        ownedPaths: ["reports"],
      },
      ownedPaths: ["reports"],
      payloadLocation: "worktree" as const,
    },
    {
      label: "read-only",
      placement: { lane: "reports", mode: "readOnly" as const },
      ownedPaths: [],
      payloadLocation: "scratch" as const,
    },
  ])(
    "carries the exact $label write policy and existing lane ref to the backend request",
    async ({ placement, ownedPaths, payloadLocation }) => {
      const execution = executionWithSchema();
      const context = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      );
      if (!context) throw new Error("fixture missing context-plan");
      context.placement = placement;

      const executionTarget = {
        worktreePath: process.cwd(),
        branchName: "integration-output-capture",
        isolation: "worktree" as const,
        laneId: placement.lane,
      };
      const expectedPolicy = composeImplementerLaneWriteEnvelope({
        executionId: execution.id,
        contextId: context.id,
        worktreePath: executionTarget.worktreePath,
        ownedPaths,
        payloadLocation,
      }).policy;
      const repository = createRepository(execution);
      const capture = { requests: [] as AgentTaskRequest[] };
      const runner = fakeBackend(
        ['{"summary":"Policy retained","risks":[]}'],
        capture,
      );

      await buildOrchestrator(repository, runner).runIteration({
        ...ITERATION_INPUT,
        executionTarget,
      });

      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0]).toMatchObject({
        workingDirectory: executionTarget.worktreePath,
        resumeRef: RESUMED_BACKEND_REF,
        fsWritePolicy: expectedPolicy,
      });
    },
  );

  it("does not complete the context when the backend's payload cannot satisfy the schema, and records the gate's issues", async () => {
    const repository = createRepository(executionWithSchema());
    const capture = { requests: [] as AgentTaskRequest[] };
    // `risks` is a string, not an array of strings — the real subset validator
    // refuses it, and the bounded repair attempt gets the same reply back.
    const runner = fakeBackend(
      ['{"summary":"Migrate the store first","risks":"schema drift"}'],
      capture,
    );

    const result = await buildOrchestrator(repository, runner).runIteration(
      ITERATION_INPUT,
    );

    const persisted = repository.read();
    expect(persisted.contextOutputs["context-plan"]).toBeUndefined();
    expect(persisted.contextStates["context-plan"]?.status).not.toBe(
      "completed",
    );
    expect(result.decision.kind).toBe("continue");
    expect(
      persisted.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    const failure = repository.appendedEvents
      .map((entry) => entry.event)
      .find(
        (event) =>
          event.type === "graph-workflow-validation-result" &&
          event.kind === "output_schema",
      );
    expect(failure).toMatchObject({ pass: false, kind: "output_schema" });
    // The issues came from the real validator, addressed by instance path.
    expect(
      failure?.type === "graph-workflow-validation-result"
        ? failure.issues.map((issue) => issue.path)
        : [],
    ).toContain("$.risks");

    // The gate's bounded repair really ran: more than one backend turn.
    expect(capture.requests.length).toBeGreaterThan(1);
    // …and the rejection record says so. This is the halt surfaces' only
    // honest repair provenance, propagated from the gate that spent it —
    // through backendDetails, the actor, the task-run result and the capture
    // outcome — rather than re-derived from D1's unrelated plan-repair rounds.
    expect(failure).toMatchObject({
      gateRepairAttempts: capture.requests.length - 1,
      gateRepairBudget: DEFAULT_STRUCTURED_OUTPUT_REPAIR_ATTEMPTS,
    });
    // The contract that refused travels WITH the refusal: the halt surfaces'
    // Edit-schema action can replace it while the halt is open, and a rejection
    // captioned by whatever the context declares later is evidence that never
    // met (R3.2).
    expect(failure).toMatchObject({
      rejectedAgainstSchema: PLAN_OUTPUT_SCHEMA,
    });
  });

  it("accepts a payload the gate recovers on its repair attempt", async () => {
    const repository = createRepository(executionWithSchema());
    const capture = { requests: [] as AgentTaskRequest[] };
    const runner = fakeBackend(
      [
        // First reply is unusable; the gate's repair turn gets a valid one.
        "I could not produce that.",
        '{"summary":"Migrate the store first","risks":[]}',
      ],
      capture,
    );

    await buildOrchestrator(repository, runner).runIteration(ITERATION_INPUT);

    const persisted = repository.read();
    expect(persisted.contextOutputs["context-plan"]?.value).toEqual({
      summary: "Migrate the store first",
      risks: [],
    });
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(capture.requests.length).toBeGreaterThan(1);
  });
});

afterEach(() => resetTaskRuntime());
