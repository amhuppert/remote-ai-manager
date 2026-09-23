import { createContextIterationFixture } from "@/lib/workflow-graph/testing/iteration-fixture";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createContextTestCapabilities } from "@/lib/workflow-graph/testing/context-capabilities";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import { _resetForTesting as resetTaskRuntime } from "@/lib/workflows/conversation/runtime-state";

/**
 * R2.1 end-to-end: engine → production capture runner → conversation turn on
 * the lane's live runtime → canonical AgentCall gate → FAKE AGENT BACKEND.
 *
 * Every other D2 test replaces one of those hops with a double, so none of them
 * can show that a real agent reply becomes a persisted, schema-conformant
 * output. Here only the backend is faked: it returns raw assistant text, and
 * the real `executeAgentCall` gate does the extraction fall-through, bounded
 * repair, and validation (its default validator IS the canonical
 * `validateJsonSchemaSubset`), the real capture runner translates the verdict,
 * and the real orchestrator decides whether the context may complete.
 *
 * The production conversation manager and actor carry the original AgentCall
 * result to the runner. Only the provider runtime and external infrastructure
 * are substituted; persistence uses an isolated SQLite fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendTurnInput,
} from "@/lib/agent-backends/conversation";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import { DEFAULT_STRUCTURED_OUTPUT_REPAIR_ATTEMPTS } from "@/lib/workflows/primitives/agent-call-facade";
import type { ConversationTurnSubmission } from "@/lib/workflows/conversation/turn-spec";

import { createMockBackendRuntime } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
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

interface BackendCapture {
  runtimes: ConversationBackendCreateInput[];
  turns: ConversationBackendTurnInput[];
}

/**
 * The fake conversation backend. Each turn returns assistant TEXT only — never
 * a native structured payload — so the gate's extraction path is what turns a
 * reply into a candidate, exactly as a Claude lane behaves.
 */
function fakeConversationBackend(
  replies: readonly string[],
  capture: BackendCapture,
): ConversationBackendFactory {
  let index = 0;
  return {
    backend: "claude",
    validateModelSelection() {},
    async createRuntime(input) {
      capture.runtimes.push(input);
      return createMockBackendRuntime({
        modelSelection: input.modelSelection,
        ...(input.fsWritePolicy ? { fsWritePolicy: input.fsWritePolicy } : {}),
        async sendTurn(turn) {
          capture.turns.push(turn);
          await turn.onEvent({ type: "input_accepted" });
          const text = replies[Math.min(index, replies.length - 1)] ?? "";
          index += 1;
          return {
            backendRef: RESUMED_BACKEND_REF,
            continuationDisposition: "retain",
            costUsd: null,
            durationMs: 1,
            numTurns: 1,
            contextTokens: 0,
            contextWindowMax: null,
            contentBlocks: [{ type: "text", text }],
            compacted: false,
            aborted: false,
            failure: null,
          };
        },
      });
    },
  };
}

/**
 * The production conversation path for the lane conversation, with only the
 * provider runtime faked: the real manager and actor run the real
 * `executeAgentCall` gate and project its outcome. Every branch the engine
 * depends on — accepted payload with its provenance, schema rejection with
 * per-issue errors and the refused text — is decided by production code here.
 */
async function laneConversation(
  replies: readonly string[],
  capture: BackendCapture,
) {
  const lifecycle = await createLifecycleFixture({
    address: {
      projectPath: "/repo",
      target: {
        scope: "session",
        projectName: "repo",
        sessionName: "session-1",
        conversationId: "conversation-lane",
      },
    },
    conversation: { agentBackend: "claude", backendRef: RESUMED_BACKEND_REF },
    actorDeps: {
      getConversationBackendFactory: () =>
        fakeConversationBackend(replies, capture),
    },
  });
  return {
    executeConversationTurn: (input: ConversationTurnSubmission) =>
      lifecycle.manager.executeConversationTurn({
        ...input,
        binding: {
          ...input.binding,
          worktreePath: input.binding.worktreePath ?? "/repo",
        },
      }),
    close: () => lifecycle.close(),
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
    };
  });
}

function buildOrchestrator(
  repository: Repository,
  lane: Awaited<ReturnType<typeof laneConversation>>,
  signalHalt?: ReturnType<typeof vi.fn>,
) {
  // PRODUCTION capture runner over the production conversation path.
  const outputCaptureRunner = createGraphWorkflowOutputCaptureRunner({
    executeConversationTurn: lane.executeConversationTurn,
  });

  return createContextIterationFixture({
    ...createContextTestCapabilities(),
    materializeWorkflowDocuments: async ({ execution }) => execution,

    executionContract: createTestGraphExecutionContract(),

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
    const capture: BackendCapture = { runtimes: [], turns: [] };
    // Fenced JSON with prose around it: the gate's extraction fall-through is
    // what must recover the payload, since the fake backend returns no native
    // structured output.
    const lane = await laneConversation(
      [
        'Here is the output you asked for:\n\n```json\n{"summary":"Migrate the store first","risks":["schema drift"]}\n```\n',
      ],
      capture,
    );

    const result = await buildOrchestrator(repository, lane).runIteration(
      ITERATION_INPUT,
    );
    await lane.close();

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

    // The declared contract reached the backend verbatim, on a turn of the
    // lane's existing session.
    const captureTurn = capture.turns.at(-1);
    expect(captureTurn?.outputFormat).toEqual({
      type: "json_schema",
      schema: PLAN_OUTPUT_SCHEMA,
    });
    expect(captureTurn?.promptText).toContain("Final Output");
    expect(capture.runtimes.at(-1)?.persistedRef).toEqual(RESUMED_BACKEND_REF);
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
    "carries the exact $label write policy and existing lane ref to the backend runtime",
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
      const capture: BackendCapture = { runtimes: [], turns: [] };
      const lane = await laneConversation(
        ['{"summary":"Policy retained","risks":[]}'],
        capture,
      );

      await buildOrchestrator(repository, lane).runIteration({
        ...ITERATION_INPUT,
        executionTarget,
      });
      await lane.close();

      expect(capture.turns).toHaveLength(1);
      expect(capture.runtimes).toHaveLength(1);
      expect(capture.runtimes[0]).toMatchObject({
        worktreePath: executionTarget.worktreePath,
        persistedRef: RESUMED_BACKEND_REF,
        fsWritePolicy: expectedPolicy,
      });
    },
  );

  it("does not complete the context when the backend's payload cannot satisfy the schema, and records the gate's issues", async () => {
    const repository = createRepository(executionWithSchema());
    const capture: BackendCapture = { runtimes: [], turns: [] };
    // `risks` is a string, not an array of strings — the real subset validator
    // refuses it, and the bounded repair attempt gets the same reply back.
    const lane = await laneConversation(
      ['{"summary":"Migrate the store first","risks":"schema drift"}'],
      capture,
    );

    const result = await buildOrchestrator(repository, lane).runIteration(
      ITERATION_INPUT,
    );
    await lane.close();

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
    expect(capture.turns.length).toBeGreaterThan(1);
    // …and the rejection record says so. This is the halt surfaces' only
    // honest repair provenance, propagated from the gate that spent it —
    // through backendDetails, the actor, the task-run result and the capture
    // outcome — rather than re-derived from D1's unrelated plan-repair rounds.
    expect(failure).toMatchObject({
      gateRepairAttempts: capture.turns.length - 1,
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
    const capture: BackendCapture = { runtimes: [], turns: [] };
    const lane = await laneConversation(
      [
        // First reply is unusable; the gate's repair turn gets a valid one.
        "I could not produce that.",
        '{"summary":"Migrate the store first","risks":[]}',
      ],
      capture,
    );

    await buildOrchestrator(repository, lane).runIteration(ITERATION_INPUT);
    await lane.close();

    const persisted = repository.read();
    expect(persisted.contextOutputs["context-plan"]?.value).toEqual({
      summary: "Migrate the store first",
      risks: [],
    });
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(capture.turns.length).toBeGreaterThan(1);
  });
});

afterEach(() => resetTaskRuntime());
