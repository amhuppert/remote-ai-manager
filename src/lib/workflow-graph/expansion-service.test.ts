import { describe, expect, it } from "vitest";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  seedAssignment,
} from "./test-fixtures";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { getEligibleContextIds } from "./validation";
import {
  classifyExpansionPayloadRefusal,
  compileExpansionBatch,
  createGraphWorkflowExpansionService,
  graphExpansionRequestSchema,
  type GraphExpansionRequest,
  type GraphWorkflowExpansionServiceDeps,
} from "./expansion-service";
import { EXPANSION_CAPS } from "./expansion-caps";
import {
  countExpansionCreatedContexts,
  expansionCanonicalPayload,
  expansionPayloadHash,
  resolveExpansionProvenance,
} from "./expansion-receipts";
import type { LiveEditDeps, ResolvedContextConfig } from "./runtime-edits";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExpansionAcceptanceReceipt,
  GraphWorkflowExpansionRefusalReceipt,
} from "./schemas";
import { appendPendingJoin } from "./lane-join";
import type { GraphWorkflowSSEEvent } from "./event-schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { prepareLiveEditAssignmentSnapshots } from "./live-edit-preparation";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const INVOKER = "context-plan";
const CONVERSATION_ID = "conversation-7";

const RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: seedAssignment({
    id: "default-implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  }),
  contextValidator: { enabled: false, assignments: [] },
  scriptValidator: { commands: [] },
  scriptValidatorSource: "global",
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: false, source: "global" },
    secondAgent: {
      value: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  },
  agentValidation: {
    implementer: {
      value: { mode: "all", except: [] },
      source: "global",
      commands: ["lint", "test", "typecheck"],
    },
    contextValidator: {
      value: { mode: "only", commands: [] },
      source: "global",
      commands: [],
    },
  },
};

const LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
  validationCommandPreflight: () => ({
    commandCosts: { lint: 1, test: 1, typecheck: 1 },
    concurrencyLimit: 8,
  }),
  snapshotFor() {
    throw new Error(
      "expansion assignments must use prepared snapshots before live-edit validation",
    );
  },
  now: () => "2026-08-04T00:00:00.000Z",
};

/**
 * A running execution whose `context-plan` lane holds expansion authority:
 * plan → implement → verify, plan running, everything downstream untouched.
 */
function runningExecution(
  mutate: (execution: GraphWorkflowExecution) => void = () => {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  const plan = execution.workingDefinition.executionContexts.find(
    (context) => context.id === INVOKER,
  );
  if (plan) {
    plan.mutability = { allowAgentTaskAdd: true, allowAgentContextAdd: true };
  }
  execution.activeContextIds = [INVOKER];
  const planState = execution.contextStates[INVOKER];
  if (planState) {
    planState.status = "running";
    planState.iterationCount = 1;
  }
  const planTask = execution.taskStates["task-plan-1"];
  if (planTask) {
    planTask.status = "running";
    planTask.lastConversationId = CONVERSATION_ID;
  }
  mutate(execution);
  return execution;
}

/**
 * Every expansion context must declare a placement (lwp R10.1). Tests about
 * OTHER refusals get the neutral one — a single-member lane of the handle's own,
 * which is concurrency-comparable with nothing and overlaps nothing — so a
 * placement they never meant to reason about cannot decide their verdict. A test
 * that DOES reason about placement states it and this default steps aside.
 */
function withDefaultPlacement(
  contexts: GraphExpansionRequest["contexts"],
): GraphExpansionRequest["contexts"] {
  return contexts.map((context) => ({
    placement: { lane: `${context.handle}-lane`, mode: "full" as const },
    ...context,
  }));
}

function makeRequest(
  overrides: Partial<GraphExpansionRequest> = {},
): GraphExpansionRequest {
  const merged = {
    requestId: "req-1",
    rationale: "Fan out one candidate per approach and let the filter pick.",
    contexts: [
      {
        handle: "candidate-a",
        title: "Candidate A",
        acceptanceCriteria: "Candidate A is implemented and self-checked",
      },
    ],
    tasks: [
      {
        contextHandle: "candidate-a",
        title: "Build candidate A",
        instructions: "Implement approach A end to end and run its tests.",
      },
    ],
    edges: [{ from: INVOKER, to: "candidate-a" }],
    ...overrides,
  };
  return graphExpansionRequestSchema.parse({
    ...merged,
    contexts: withDefaultPlacement(merged.contexts),
  });
}

interface Harness {
  deps: GraphWorkflowExpansionServiceDeps;
  current(): GraphWorkflowExecution;
  broadcasts: GraphWorkflowSSEEvent[];
  /** Every event row the repository committed, in commit order. */
  committed(): GraphWorkflowSSEEvent[];
  snapshotPreparationInsideMutation: boolean[];
}

function makeHarness(initial: GraphWorkflowExecution): Harness {
  let execution = initial;
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  const committedRows: GraphWorkflowSSEEvent[] = [];
  const snapshotPreparationInsideMutation: boolean[] = [];
  let insideMutation = false;

  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast: (event) => {
      broadcasts.push(event);
    },
  });

  // The REAL repository, so `executionStateRevision` / `structuralRevision` are
  // stamped by the code the staging fence actually reads.
  const repository = createGraphWorkflowExecutionRepository({
    getSession: () =>
      Promise.resolve({ sessionName: SESSION_NAME } as SessionState),
    getActiveGraphWorkflowExecution: () => Promise.resolve(execution),
    mutateActiveGraphWorkflowExecution: async (
      _projectPath,
      _sessionName,
      _label,
      mutate,
    ) => {
      insideMutation = true;
      let result;
      try {
        result = mutate(execution);
      } finally {
        insideMutation = false;
      }
      execution = result.execution;
      committedRows.push(...result.events.map((row) => row.event));
      return {
        execution,
        delivery: { events: result.events, pushes: result.pushes ?? [] },
      };
    },
    archiveActiveGraphWorkflowExecution: () =>
      Promise.resolve({ archived: false as const, reason: "no_active" as const }),
    markGraphWorkflowContextEventsPreReset: () => Promise.resolve(0),
    eventPublisher,
  });

  return {
    current: () => execution,
    broadcasts,
    committed: () => committedRows,
    snapshotPreparationInsideMutation,
    deps: {
      getActiveExecution: () => Promise.resolve(execution),
      mutateActive: repository.mutateActive,
      buildLiveEditDeps: () => Promise.resolve(LIVE_EDIT_DEPS),
      prepareAssignmentSnapshots: (_projectPath, operations) =>
        prepareLiveEditAssignmentSnapshots({
          operations,
          composeSnapshot: async (assignment) => {
            snapshotPreparationInsideMutation.push(insideMutation);
            return makeProfileSnapshot({
              tier: assignment.profile.tier,
              id: assignment.profile.id,
              name: `Prepared ${assignment.id}`,
            });
          },
        }),
      publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
      publishGraphExpansion: eventPublisher.publishGraphExpansion,
      deliver: eventPublisher.deliver,
      now: () => "2026-08-04T00:00:00.000Z",
    },
  };
}

function expandWith(
  harness: Harness,
  request: GraphExpansionRequest,
  overrides: { contextId?: string; conversationId?: string } = {},
) {
  const service = createGraphWorkflowExpansionService(harness.deps);
  return service.expand({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    executionId: "execution-1",
    contextId: overrides.contextId ?? INVOKER,
    conversationId: overrides.conversationId ?? CONVERSATION_ID,
    request,
  });
}

describe("compileExpansionBatch — handle → deterministic id compilation", () => {
  it("mints ids deterministically from the invoker and requestId", () => {
    const execution = runningExecution();
    const request = makeRequest();

    const first = compileExpansionBatch({
      execution,
      invokerContextId: INVOKER,
      resolvedGlobalDefaults: RESOLVED_DEFAULTS,
      request,
    });
    const second = compileExpansionBatch({
      execution,
      invokerContextId: INVOKER,
      resolvedGlobalDefaults: RESOLVED_DEFAULTS,
      request,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.compiled.createdContextIds).toEqual(
      second.compiled.createdContextIds,
    );
    expect(first.compiled.createdContextIds[0]).toContain("candidate-a");
    // A different requestId is a different batch and must not reuse the ids.
    const other = compileExpansionBatch({
      execution,
      invokerContextId: INVOKER,
      resolvedGlobalDefaults: RESOLVED_DEFAULTS,
      request: makeRequest({ requestId: "req-2" }),
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.compiled.createdContextIds).not.toEqual(
      first.compiled.createdContextIds,
    );
  });

  it("compiles only additive operations — never remove/update/move/reorder", () => {
    const compiled = compileExpansionBatch({
      execution: runningExecution(),
      invokerContextId: INVOKER,
      resolvedGlobalDefaults: RESOLVED_DEFAULTS,
      request: makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "A works",
          },
          {
            handle: "candidate-b",
            title: "Candidate B",
            acceptanceCriteria: "B works",
          },
        ],
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "Build A",
            instructions: "Build A.",
          },
          {
            contextHandle: "candidate-b",
            title: "Build B",
            instructions: "Build B.",
          },
        ],
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: INVOKER, to: "candidate-b" },
          { from: "candidate-a", to: "context-verify" },
          { from: "candidate-b", to: "context-verify" },
        ],
      }),
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(
      [...new Set(compiled.compiled.operations.map((op) => op.type))].sort(),
    ).toEqual(["add-context", "add-edge", "add-task"]);
    expect(compiled.compiled.rejoinContextIds).toEqual(["context-verify"]);
    const contextOperations = compiled.compiled.operations.filter(
      (operation) => operation.type === "add-context",
    );
    expect(contextOperations).toHaveLength(2);
    for (const operation of contextOperations) {
      expect(operation.configFromContextId).toBe(INVOKER);
      expect(operation).not.toHaveProperty("contextValidator");
      expect(operation).not.toHaveProperty("humanApprovalGate");
      expect(operation).not.toHaveProperty("askUserQuestions");
      expect(operation).not.toHaveProperty("collaboration");
      expect(operation).not.toHaveProperty("planRepair");
      expect(operation).not.toHaveProperty("agentValidation");
    }
  });
});

describe("graph expansion — accepted request (R6.1)", () => {
  it("adds contexts, tasks, and edges atomically while the execution keeps running", async () => {
    const harness = makeHarness(runningExecution());
    const before = harness.current();

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = harness.current();
    const addedId = outcome.createdContextIds[0] ?? "";

    expect(after.status).toBe("running");
    expect(after.activeContextIds).toEqual(before.activeContextIds);
    expect(
      after.workingDefinition.executionContexts.map((context) => context.id),
    ).toContain(addedId);
    expect(
      after.workingDefinition.tasks.filter(
        (task) => task.contextId === addedId,
      ),
    ).toHaveLength(1);
    expect(
      after.workingDefinition.edges.some(
        (edge) =>
          edge.sourceContextId === INVOKER && edge.targetContextId === addedId,
      ),
    ).toBe(true);
    // Every task the agent generated is agent-authored provenance.
    expect(
      after.workingDefinition.tasks.find((task) => task.contextId === addedId)
        ?.source,
    ).toBe("agent");
  });

  it("bumps liveRevision exactly once and emits the live-edit event plus a typed expansion event", async () => {
    const harness = makeHarness(runningExecution());
    const before = harness.current().liveRevision;

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(harness.current().liveRevision).toBe(before + 1);
    expect(outcome.liveRevision).toBe(before + 1);

    const liveEdits = harness
      .committed()
      .filter((event) => event.type === "graph-workflow-live-edit-applied");
    expect(liveEdits).toHaveLength(1);
    expect(liveEdits[0]).toMatchObject({ source: "lane-agent" });

    const expansions = harness
      .committed()
      .filter((event) => event.type === "graph-workflow-graph-expanded");
    expect(expansions).toHaveLength(1);
    expect(expansions[0]).toMatchObject({
      executionId: "execution-1",
      invokerContextId: INVOKER,
      outcome: "accepted",
      requestId: "req-1",
      addedContextIds: outcome.createdContextIds,
    });
  });

  it("leaves the addition eligible for the very next scheduler tick", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = harness.current();
    const addedId = outcome.createdContextIds[0] ?? "";
    // Blocked only by its running upstream — no pause/resume was involved, and
    // the context is a first-class member of the scheduled graph.
    expect(after.contextStates[addedId]?.status).toBe("pending");
    expect(getEligibleContextIds(after.workingDefinition, after)).not.toContain(
      addedId,
    );

    const planCompleted = structuredClone(after);
    const planState = planCompleted.contextStates[INVOKER];
    if (planState) planState.status = "completed";
    const planTask = planCompleted.taskStates["task-plan-1"];
    if (planTask) planTask.status = "completed";
    planCompleted.activeContextIds = [];
    expect(
      getEligibleContextIds(planCompleted.workingDefinition, planCompleted),
    ).toContain(addedId);
  });

  it("feeds multiple pre-declared rejoin targets from one batch", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "A works",
          },
        ],
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "Build A",
            instructions: "Build A.",
          },
        ],
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-implement" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejoinContextIds.sort()).toEqual([
      "context-implement",
      "context-verify",
    ]);
  });
});

describe("graph expansion — envelope refusals (R6.2)", () => {
  async function expectRefusal(
    harness: Harness,
    request: GraphExpansionRequest,
    code: string,
    overrides: { contextId?: string; conversationId?: string } = {},
  ) {
    const before = structuredClone(harness.current());
    const outcome = await expandWith(harness, request, overrides);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(code);

    // Fail-closed: nothing about the graph or the revision moved.
    const after = harness.current();
    expect(after.workingDefinition).toEqual(before.workingDefinition);
    expect(after.liveRevision).toBe(before.liveRevision);
    expect(after.contextStates).toEqual(before.contextStates);
    expect(after.taskStates).toEqual(before.taskStates);

    const refusals = harness.broadcasts.filter(
      (event) =>
        event.type === "graph-workflow-graph-expanded" &&
        event.outcome === "refused",
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.at(-1)).toMatchObject({ refusalCode: code });
  }

  it("refuses a lane whose context does not hold expansion authority", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        const plan = execution.workingDefinition.executionContexts.find(
          (context) => context.id === INVOKER,
        );
        if (plan) {
          plan.mutability = {
            allowAgentTaskAdd: true,
            allowAgentContextAdd: false,
          };
        }
      }),
    );

    await expectRefusal(harness, makeRequest(), "expansion-not-authorized");
  });

  it("refuses a lane whose conversation is not the context's bound implementer", async () => {
    const harness = makeHarness(runningExecution());

    await expectRefusal(harness, makeRequest(), "expansion-lane-not-bound", {
      conversationId: "conversation-stale",
    });
  });

  it("refuses a capability whose scope went stale between validation and the commit", async () => {
    // A capability proves the lane was HANDED credentials, never that the
    // binding is still current. The batch validates against a live binding and
    // the lane is rebound before the write queue runs it — the in-lock re-check
    // is the only thing standing between that and a stale lane's edit landing.
    const harness = makeHarness(runningExecution());
    const before = structuredClone(harness.current());
    const service = createGraphWorkflowExpansionService({
      ...harness.deps,
      mutateActive: (projectPath, sessionName, fn) => {
        const planTask = harness.current().taskStates["task-plan-1"];
        if (planTask) planTask.lastConversationId = "conversation-successor";
        return harness.deps.mutateActive(projectPath, sessionName, fn);
      },
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: makeRequest(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("forbidden");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-lane-not-bound",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);
    expect(harness.current().contextStates).toEqual(before.contextStates);
  });

  it("refuses a batch whose new context is unreachable from the invoker", async () => {
    const harness = makeHarness(runningExecution());

    await expectRefusal(
      harness,
      makeRequest({ edges: [] }),
      "expansion-context-unreachable",
    );
  });

  it("refuses a task targeting the invoker", async () => {
    const harness = makeHarness(runningExecution());

    await expectRefusal(
      harness,
      makeRequest({
        tasks: [
          {
            contextHandle: INVOKER,
            title: "Sneak a task home",
            instructions: "Add work to the invoking context.",
          },
        ],
      }),
      "expansion-task-target-not-in-batch",
    );
  });

  it("refuses a task targeting a rejoin context", async () => {
    const harness = makeHarness(runningExecution());

    await expectRefusal(
      harness,
      makeRequest({
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "Build A",
            instructions: "Build A.",
          },
          {
            contextHandle: "context-verify",
            title: "Extra verification",
            instructions: "Add work to the filter.",
          },
        ],
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
      "expansion-task-target-not-in-batch",
    );
  });

  it("refuses an edge sourced outside the invoker and the batch", async () => {
    const harness = makeHarness(runningExecution());

    await expectRefusal(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "context-implement", to: "candidate-a" },
        ],
      }),
      "expansion-edge-source-outside-batch",
    );
  });

  it("refuses an edge into a started context", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        const verify = execution.contextStates["context-verify"];
        if (verify) verify.status = "running";
      }),
    );

    await expectRefusal(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
      "expansion-rejoin-started",
    );
  });

  it("refuses an edge into a reserved context", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        const verify = execution.contextStates["context-verify"];
        if (verify) verify.reservedByBatchId = "batch-9";
      }),
    );

    await expectRefusal(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
      "expansion-rejoin-reserved",
    );
  });

  it("refuses an edge into a context that is not downstream of the invoker", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        // A root sibling of the invoker: it exists, it is unstarted and
        // unreserved, and it is still not a legal rejoin target because
        // nothing connects it to the invoker.
        const verify = execution.workingDefinition.executionContexts.find(
          (context) => context.id === "context-verify",
        );
        const verifyState = execution.contextStates["context-verify"];
        if (!verify || !verifyState) throw new Error("fixture drift");
        execution.workingDefinition.executionContexts.push({
          ...structuredClone(verify),
          id: "context-sibling",
          title: "Sibling",
          acceptanceCriteria: "Unrelated work",
        });
        execution.contextStates["context-sibling"] = {
          ...structuredClone(verifyState),
          contextId: "context-sibling",
          totalTaskCount: 0,
          completedTaskCount: 0,
        };
      }),
    );

    await expectRefusal(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-sibling" },
        ],
      }),
      "expansion-rejoin-not-downstream",
    );
  });

  it("refuses a batch that creates no new context", () => {
    expect(
      graphExpansionRequestSchema.safeParse({
        requestId: "req-1",
        rationale: "nothing to add",
        contexts: [],
        tasks: [],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("refuses a payload that smuggles a non-additive operation", () => {
    const smuggled = {
      requestId: "req-1",
      rationale: "remove the filter",
      contexts: [{ handle: "a", title: "A", acceptanceCriteria: "A works" }],
      tasks: [{ contextHandle: "a", title: "T", instructions: "Do it." }],
      edges: [],
      operations: [{ type: "remove-context", contextId: "context-verify" }],
    };

    expect(graphExpansionRequestSchema.safeParse(smuggled).success).toBe(false);
    // The refusal is typed, not just "unrecognized key": R6.2 names the
    // non-additive op as its own envelope violation, and the event the lane's
    // operator sees should say which rule the lane broke.
    expect(classifyExpansionPayloadRefusal(smuggled)).toBe(
      "expansion-non-additive-operation",
    );
  });

  it("classifies every non-additive live-edit verb, and nothing else", () => {
    for (const type of [
      "remove-context",
      "remove-task",
      "remove-edge",
      "update-context",
      "update-task",
      "update-edge",
      "move-task",
      "reorder-tasks",
    ]) {
      expect(
        classifyExpansionPayloadRefusal({ request: { ops: [{ type }] } }),
        type,
      ).toBe("expansion-non-additive-operation");
    }

    // An additive verb is not the violation R6.2 names, and neither is prose
    // that merely reads like one — only a `type` field decides.
    expect(
      classifyExpansionPayloadRefusal({ ops: [{ type: "add-context" }] }),
    ).toBe("expansion-payload-invalid");
    expect(
      classifyExpansionPayloadRefusal({
        rationale: "update-task ordering is wrong",
      }),
    ).toBe("expansion-payload-invalid");
    expect(classifyExpansionPayloadRefusal(undefined)).toBe(
      "expansion-payload-invalid",
    );
  });

  it("reads only own properties when classifying a payload", () => {
    // A node that INHERITS `type` never declared one; only what the payload
    // itself carries decides the refusal code.
    const inherited: unknown = Object.create({ type: "remove-context" }) as {
      type?: string;
    };
    expect(classifyExpansionPayloadRefusal({ ops: [inherited] })).toBe(
      "expansion-payload-invalid",
    );

    // Its own-property twin is a genuine declaration and still classifies.
    expect(
      classifyExpansionPayloadRefusal({ ops: [{ type: "remove-context" }] }),
    ).toBe("expansion-non-additive-operation");
  });

  it("refuses a generated context with no tasks", () => {
    expect(
      graphExpansionRequestSchema.safeParse({
        requestId: "req-1",
        rationale: "empty child",
        contexts: [{ handle: "a", title: "A", acceptanceCriteria: "A works" }],
        tasks: [],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("refuses a batch whose SECOND generated context carries no tasks", async () => {
    // The schema's `tasks.min(1)` only proves the batch has SOME task. R7's
    // refusal is per generated context, so a batch that feeds one child and
    // leaves its sibling empty is the case that actually exercises it.
    const harness = makeHarness(runningExecution());

    await expectRefusal(
      harness,
      makeRequest({
        contexts: [
          { handle: "candidate-a", title: "A", acceptanceCriteria: "A works" },
          { handle: "candidate-b", title: "B", acceptanceCriteria: "B works" },
        ],
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "A",
            instructions: "Build A.",
          },
        ],
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: INVOKER, to: "candidate-b" },
        ],
      }),
      "expansion-context-without-task",
    );
  });
});

describe("graph expansion — inherited core refusals", () => {
  /**
   * The service composes its batch through `applyLiveExecutionEdits`' shared
   * core rather than writing to the repository, so every gate that core runs
   * applies to expansion too. The execution contract is the one an expansion
   * entry point can silently LOSE — the lane-agent `add_task` wrapper
   * deliberately builds deps without one — so this pins that expansion's deps
   * carry it through to the frontier.
   */
  it("is refused when the registered execution contract rejects the batch", async () => {
    const harness = makeHarness(runningExecution());
    const before = structuredClone(harness.current());
    const service = createGraphWorkflowExpansionService({
      ...harness.deps,
      buildLiveEditDeps: () =>
        Promise.resolve({
          ...LIVE_EDIT_DEPS,
          executionContract: {
            validateDefinition: () => ({ ok: true as const }),
            validateLiveEdit: () => ({
              ok: false as const,
              code: "spec_grouping_frozen",
              issues: [
                {
                  code: "spec-grouping-frozen",
                  message: "task grouping is frozen for this spec execution",
                },
              ],
              instruction: "re-plan the spec instead",
            }),
            validateTaskCompletion: () => ({ ok: true as const }),
            deriveContextAcceptanceCriteria: () => ({
              ok: true as const,
              acceptanceCriteriaByContextId: {},
            }),
            deriveCriterionContextCoverage: () => ({}),
          },
        }),
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: makeRequest(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "spec-grouping-frozen",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);
  });

  it("is refused when the batch would make the graph cyclic", async () => {
    const harness = makeHarness(runningExecution());
    const before = structuredClone(harness.current());

    // candidate-a → context-implement is a legal rejoin on its own, but
    // context-implement already reaches nothing back into the batch... so build
    // the cycle explicitly: the batch's own two contexts point at each other.
    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          { handle: "a", title: "A", acceptanceCriteria: "A works" },
          { handle: "b", title: "B", acceptanceCriteria: "B works" },
        ],
        tasks: [
          { contextHandle: "a", title: "Build A", instructions: "Build A." },
          { contextHandle: "b", title: "Build B", instructions: "Build B." },
        ],
        edges: [
          { from: INVOKER, to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);
  });
});

/**
 * Expansion speaks the placement vocabulary (lwp R10.1): a generated context
 * declares where it runs and what it may write, exactly as an authored one does,
 * and every placement refusal the authored tier can raise reaches it through the
 * shared live-edit core.
 */
describe("graph expansion — placement (lwp R10.1)", () => {
  const SHARED_LANE = "shared";

  /** Put the untouched, downstream `context-verify` on a shared group lane. */
  function withSharedLaneMember(ownedPaths: string[]) {
    return (execution: GraphWorkflowExecution): void => {
      const verify = execution.workingDefinition.executionContexts.find(
        (context) => context.id === "context-verify",
      );
      if (!verify) throw new Error("fixture lost context-verify");
      verify.placement = { lane: SHARED_LANE, mode: "owned", ownedPaths };
    };
  }

  function placementOf(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): unknown {
    return execution.workingDefinition.executionContexts.find(
      (context) => context.id === contextId,
    )?.placement;
  }

  it("refuses a generated context that declares no placement", async () => {
    const harness = makeHarness(runningExecution());
    const before = structuredClone(harness.current());

    // Built through the schema directly: `makeRequest` fills the neutral default
    // in, and the omission is exactly what this test is about.
    const outcome = await expandWith(
      harness,
      graphExpansionRequestSchema.parse({
        requestId: "req-1",
        rationale: "Fan out one candidate.",
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "Candidate A is implemented",
          },
        ],
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "Build candidate A",
            instructions: "Implement approach A.",
          },
        ],
        edges: [{ from: INVOKER, to: "candidate-a" }],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-placement-missing",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("compiles a valid expansion onto a BRAND-NEW lane and runs it there", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "Candidate A is implemented",
            placement: {
              lane: "candidate-a-lane",
              mode: "owned",
              ownedPaths: ["src/candidate-a"],
            },
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const addedId = outcome.createdContextIds[0] ?? "";
    expect(placementOf(harness.current(), addedId)).toEqual({
      lane: "candidate-a-lane",
      mode: "owned",
      ownedPaths: ["src/candidate-a"],
    });
  });

  it("compiles a valid expansion onto an EXISTING open lane", async () => {
    const harness = makeHarness(
      runningExecution(withSharedLaneMember(["docs"])),
    );

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "Candidate A is implemented",
            placement: {
              lane: SHARED_LANE,
              mode: "owned",
              ownedPaths: ["src/candidate-a"],
            },
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const addedId = outcome.createdContextIds[0] ?? "";
    expect(placementOf(harness.current(), addedId)).toEqual({
      lane: SHARED_LANE,
      mode: "owned",
      ownedPaths: ["src/candidate-a"],
    });
  });

  it("refuses ownership overlapping a concurrency-comparable same-lane member", async () => {
    // Nothing sequences the generated context against `context-verify`, so both
    // could hold the shared lane's one worktree at once.
    const harness = makeHarness(
      runningExecution(withSharedLaneMember(["src"])),
    );
    const before = structuredClone(harness.current());

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "Candidate A is implemented",
            placement: {
              lane: SHARED_LANE,
              mode: "owned",
              ownedPaths: ["src/candidate-a"],
            },
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "placement-owned-paths-overlap",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("counts placement as part of the request's identity", async () => {
    // A retry is recognised by hashing the canonical payload. If placement sat
    // outside that hash, re-posting a used requestId with the candidate moved to
    // a different lane would replay the ORIGINAL receipt and the move would
    // silently never happen.
    const harness = makeHarness(runningExecution());
    const onLane = (lane: string) =>
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "Candidate A is implemented",
            placement: { lane, mode: "owned", ownedPaths: ["src/candidate-a"] },
          },
        ],
      });

    expect((await expandWith(harness, onLane("lane-one"))).ok).toBe(true);

    const outcome = await expandWith(harness, onLane("lane-two"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-request-id-reused",
    );
  });

  /** The join intent that promises SHARED_LANE's content to the `landing` lane. */
  const SHARED_LANE_JOIN: GraphWorkflowExecutionJoinState = {
    joinId: "join-1",
    kind: "context_merge",
    contextId: "context-implement",
    targetLaneId: "landing",
    sourceLaneIds: [SHARED_LANE, "landing"],
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    completedAt: null,
  };

  const ONTO_SHARED_LANE = makeRequest({
    contexts: [
      {
        handle: "candidate-a",
        title: "Candidate A",
        acceptanceCriteria: "Candidate A is implemented",
        placement: {
          lane: SHARED_LANE,
          mode: "owned",
          ownedPaths: ["src/candidate-a"],
        },
      },
    ],
  });

  it("refuses an expansion onto a lane whose join intent already exists", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        withSharedLaneMember(["docs"])(execution);
        execution.joins = { "join-1": SHARED_LANE_JOIN };
      }),
    );
    const before = structuredClone(harness.current());

    const outcome = await expandWith(harness, ONTO_SHARED_LANE);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain("lane_closed");
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("refuses an expansion whose target lane a join claimed after the batch validated", async () => {
    // The production race. Closure is validated OUTSIDE the write queue, so the
    // scheduler can plan the lane's join between that validation and the staged
    // install. Planning a join moves `joins` and the downstream context's
    // `joinId` — it never touches `workingDefinition`, so `structuralRevision`
    // does not move, and it is not a live edit, so `liveRevision` does not
    // either. Nothing the staging fence carried before would notice, and the
    // added member would land on a lane already promised to a merge.
    const harness = makeHarness(
      runningExecution(withSharedLaneMember(["docs"])),
    );
    const before = structuredClone(harness.current());
    let planned = false;
    const service = createGraphWorkflowExpansionService({
      ...harness.deps,
      mutateActive: async (projectPath, sessionName, fn) => {
        if (!planned) {
          planned = true;
          await harness.deps.mutateActive(projectPath, sessionName, (draft) =>
            appendPendingJoin(draft, SHARED_LANE_JOIN),
          );
        }
        return harness.deps.mutateActive(projectPath, sessionName, fn);
      },
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: ONTO_SHARED_LANE,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain("lane_closed");
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);
  });
});

describe("graph expansion — generated child authority", () => {
  it("stamps expansion authority off on every generated child", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const added = harness
      .current()
      .workingDefinition.executionContexts.find(
        (context) => context.id === outcome.createdContextIds[0],
      );
    expect(added?.mutability.allowAgentContextAdd).toBe(false);
    // The invoker's own authority is untouched — the stamp is per-child.
    expect(
      harness
        .current()
        .workingDefinition.executionContexts.find(
          (context) => context.id === INVOKER,
        )?.mutability.allowAgentContextAdd,
    ).toBe(true);
  });
});

describe("graph expansion — generated child config (R7.2)", () => {
  const ENABLED_VALIDATOR = {
    enabled: true,
    assignments: [
      seedAssignment({
        id: "invoker-reviewer",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation" as const,
        authority: "blocking" as const,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      }),
    ],
  };

  /**
   * The invoker holds an ENABLED context validator and human approval gate;
   * `context-implement` holds neither. Seeding a child from `context-implement`
   * is therefore an attempt to launder a weakening through inheritance.
   */
  function gatedExecution(
    mutate: (execution: GraphWorkflowExecution) => void = () => {},
  ): GraphWorkflowExecution {
    return runningExecution((execution) => {
      const plan = execution.workingDefinition.executionContexts.find(
        (context) => context.id === INVOKER,
      );
      if (plan) {
        plan.contextValidator = { ...ENABLED_VALIDATOR };
        plan.humanApprovalGate = { enabled: true };
        plan.askUserQuestions = { enabled: true };
        plan.planRepair = { enabled: true, maxAttemptsPerContext: 4 };
        plan.agentValidation = {
          implementer: {
            value: { mode: "only", commands: ["test"] },
            source: "workflow",
            commands: ["test"],
          },
          contextValidator: {
            value: { mode: "only", commands: ["lint"] },
            source: "per-node",
            commands: ["lint"],
          },
        };
      }
      mutate(execution);
    });
  }

  function childOf(
    harness: Harness,
    outcome: Extract<Awaited<ReturnType<typeof expandWith>>, { ok: true }>,
  ) {
    return harness
      .current()
      .workingDefinition.executionContexts.find(
        (context) => context.id === outcome.createdContextIds[0],
      );
  }

  function requestWithChildConfig(
    child: Partial<GraphExpansionRequest["contexts"][number]>,
  ): GraphExpansionRequest {
    return makeRequest({
      contexts: [
        {
          handle: "candidate-a",
          title: "Candidate A",
          acceptanceCriteria: "Candidate A is implemented and self-checked",
          ...child,
        },
      ],
    });
  }

  it("derives protected blocks from the invoker even when seeding from a weaker context", async () => {
    const harness = makeHarness(gatedExecution());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({ configFromContextId: "context-implement" }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const child = childOf(harness, outcome);
    // Invoker-derived, NOT the seed's (which has no validator and no gate).
    expect(child?.contextValidator).toEqual(ENABLED_VALIDATOR);
    expect(child?.humanApprovalGate).toEqual({ enabled: true });
    expect(child?.askUserQuestions).toEqual({ enabled: true });
    expect(child?.planRepair).toEqual({
      enabled: true,
      maxAttemptsPerContext: 4,
    });
    expect(child?.agentValidation).toEqual(
      harness
        .current()
        .workingDefinition.executionContexts.find(
          (context) => context.id === INVOKER,
        )?.agentValidation,
    );
    expect(child?.mutability).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: false,
    });
  });

  it("seeds tuning blocks from configFromContextId and applies payload overrides", async () => {
    const harness = makeHarness(gatedExecution());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({
        configFromContextId: "context-implement",
        config: {
          circuitBreaker: { consecutiveFailureThreshold: 1 },
          scriptValidator: { commands: ["test"] },
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const child = childOf(harness, outcome);
    // Seeded from `context-implement`, whose implementer/iteration policy differ
    // from the invoker's.
    expect(child?.implementer).toMatchObject({
      agent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
    });
    expect(child?.iterationPolicy).toEqual({
      maxIterations: 3,
      continuity: { enabled: true },
    });
    // Overridden by the payload with an additive command set.
    expect(child?.circuitBreaker).toEqual({ consecutiveFailureThreshold: 1 });
    expect(child?.scriptValidator).toEqual({ commands: ["test"] });
    expect(child?.scriptValidatorSource).toBe("per-node");
  });

  it("resolves a payload implementer assignment before the write queue and stores the prepared snapshot", async () => {
    const harness = makeHarness(gatedExecution());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({
        config: {
          implementer: {
            id: "child-implementer",
            profile: { tier: "project", id: "child-specialist" },
            focus: "candidate implementation",
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const child = childOf(harness, outcome);
    expect(child?.implementer).toMatchObject({
      id: "child-implementer",
      profile: { tier: "project", id: "child-specialist" },
      focus: "candidate implementation",
      profileSnapshot: {
        tier: "project",
        id: "child-specialist",
        name: "Prepared child-implementer",
      },
    });
    expect(harness.snapshotPreparationInsideMutation.length).toBeGreaterThan(0);
    expect(harness.snapshotPreparationInsideMutation).toEqual(
      harness.snapshotPreparationInsideMutation.map(() => false),
    );
  });

  it("preserves inherited execution snapshots while resolving a same-key payload override afresh", async () => {
    const frozenImplementerSnapshot = makeProfileSnapshot({
      tier: "project",
      id: "shared-specialist",
      name: "Execution-pinned seeded specialist",
      revision: 7,
    });
    const frozenValidatorSnapshot = makeProfileSnapshot({
      tier: "project",
      id: "retired-reviewer",
      name: "Execution-pinned dormant reviewer",
      revision: 4,
    });
    const harness = makeHarness(
      gatedExecution((execution) => {
        const invoker = execution.workingDefinition.executionContexts.find(
          (context) => context.id === INVOKER,
        );
        if (invoker) {
          invoker.contextValidator = {
            enabled: false,
            assignments: [
              seedAssignment(
                {
                  id: "retired-reviewer",
                  profile: { tier: "project", id: "retired-reviewer" },
                  strategy: "conversation",
                  authority: "advisory",
                  continuity: { enabled: true },
                  agent: {
                    backend: "claude",
                    model: "sonnet",
                    reasoningEffort: "medium",
                  },
                },
                frozenValidatorSnapshot,
              ),
            ],
          };
          invoker.agentValidation = {
            implementer: {
              value: { mode: "all", except: [] },
              source: "workflow",
              commands: ["test"],
            },
            contextValidator: {
              value: { mode: "only", commands: ["lint"] },
              source: "per-node",
              commands: ["lint"],
            },
          };
        }
        const seed = execution.workingDefinition.executionContexts.find(
          (context) => context.id === "context-implement",
        );
        if (seed) {
          seed.implementer = seedAssignment(
            {
              id: "seeded-specialist",
              profile: { tier: "project", id: "shared-specialist" },
              focus: "shared focus",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
            },
            frozenImplementerSnapshot,
          );
        }
      }),
    );
    const preparedAssignmentIds: string[] = [];
    harness.deps.prepareAssignmentSnapshots = (_projectPath, operations) =>
      prepareLiveEditAssignmentSnapshots({
        operations,
        composeSnapshot: async (assignment) => {
          preparedAssignmentIds.push(assignment.id);
          if (assignment.id !== "fresh-specialist") {
            throw new Error(`Profile ${assignment.id} is no longer available`);
          }
          return makeProfileSnapshot({
            tier: assignment.profile.tier,
            id: assignment.profile.id,
            name: "Fresh payload specialist",
            revision: 11,
          });
        },
      });

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "seeded-child",
            title: "Seeded child",
            acceptanceCriteria: "Uses the execution-pinned seed",
            configFromContextId: "context-implement",
          },
          {
            handle: "fresh-child",
            title: "Fresh child",
            acceptanceCriteria: "Uses a freshly resolved payload override",
            config: {
              implementer: {
                id: "fresh-specialist",
                profile: { tier: "project", id: "shared-specialist" },
                focus: "shared focus",
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
              },
            },
          },
        ],
        tasks: [
          {
            contextHandle: "seeded-child",
            title: "Use seeded specialist",
            instructions: "Run with the execution-pinned profile bytes.",
          },
          {
            contextHandle: "fresh-child",
            title: "Use fresh specialist",
            instructions: "Run with freshly composed profile bytes.",
          },
        ],
        edges: [
          { from: INVOKER, to: "seeded-child" },
          { from: INVOKER, to: "fresh-child" },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [seededChildId, freshChildId] = outcome.createdContextIds;
    const seededChild = harness
      .current()
      .workingDefinition.executionContexts.find(
        (context) => context.id === seededChildId,
      );
    const freshChild = harness
      .current()
      .workingDefinition.executionContexts.find(
        (context) => context.id === freshChildId,
      );
    const invoker = harness
      .current()
      .workingDefinition.executionContexts.find(
        (context) => context.id === INVOKER,
      );

    expect(seededChild?.implementer.profileSnapshot).toEqual(
      frozenImplementerSnapshot,
    );
    expect(freshChild?.implementer.profileSnapshot).toMatchObject({
      tier: "project",
      id: "shared-specialist",
      name: "Fresh payload specialist",
      revision: 11,
    });
    expect(seededChild?.contextValidator).toEqual(invoker?.contextValidator);
    expect(freshChild?.contextValidator).toEqual(invoker?.contextValidator);
    expect(
      seededChild?.contextValidator.assignments[0]?.profileSnapshot,
    ).toEqual(frozenValidatorSnapshot);
    expect(seededChild?.agentValidation).toEqual(invoker?.agentValidation);
    expect(freshChild?.agentValidation).toEqual(invoker?.agentValidation);
    expect(seededChild?.agentValidation?.implementer.commands).toEqual([
      "test",
    ]);
    expect(preparedAssignmentIds).toEqual(["fresh-specialist"]);
  });

  it("refuses a payload that overrides a protected block", async () => {
    const harness = makeHarness(gatedExecution());
    const before = structuredClone(harness.current());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({
        config: { humanApprovalGate: { enabled: false } },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-protected-config-override",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("refuses a seed that removes an inherited script command", async () => {
    const harness = makeHarness(
      gatedExecution((execution) => {
        const plan = execution.workingDefinition.executionContexts.find(
          (context) => context.id === INVOKER,
        );
        if (plan) plan.scriptValidator = { commands: ["typecheck"] };
      }),
    );
    const before = structuredClone(harness.current());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({ configFromContextId: "context-implement" }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-script-validator-weakened",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("refuses a configFromContextId naming a context this execution does not have", async () => {
    const harness = makeHarness(gatedExecution());
    const before = structuredClone(harness.current());

    const outcome = await expandWith(
      harness,
      requestWithChildConfig({ configFromContextId: "context-nowhere" }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-config-source-unknown",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
  });

  it("refuses a configFromContextId naming a context created by the same batch", async () => {
    // Sibling seeding would make the compiled config depend on op ORDER, and a
    // batch is one proposition — every child seeds from committed state.
    const harness = makeHarness(gatedExecution());

    const outcome = await expandWith(
      harness,
      makeRequest({
        contexts: [
          {
            handle: "candidate-a",
            title: "Candidate A",
            acceptanceCriteria: "A works",
          },
          {
            handle: "candidate-b",
            title: "Candidate B",
            acceptanceCriteria: "B works",
            configFromContextId: "candidate-a",
          },
        ],
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "A",
            instructions: "Build A.",
          },
          {
            contextHandle: "candidate-b",
            title: "B",
            instructions: "Build B.",
          },
        ],
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: INVOKER, to: "candidate-b" },
        ],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-config-source-unknown",
    );
  });

  it("inherits the invoker's config when the payload names no seed", async () => {
    const harness = makeHarness(gatedExecution());

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const child = childOf(harness, outcome);
    expect(child?.implementer).toMatchObject({
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
    });
    expect(child?.iterationPolicy).toEqual({
      maxIterations: 4,
      continuity: { enabled: true },
    });
    expect(child?.contextValidator).toEqual(ENABLED_VALIDATOR);
  });
});

// ============================================================
// Idempotency, caps, and receipts (R6.3, R6.4, R8.1)
// ============================================================

/** The identity the service keys receipts on, computed the production way. */
function hashOf(request: GraphExpansionRequest): string {
  return expansionPayloadHash(expansionCanonicalPayload(request));
}

/** A refusal receipt already durable on the ledger for this exact attempt. */
function seedRefusal(
  request: GraphExpansionRequest,
  refusalCode: string,
): GraphWorkflowExpansionRefusalReceipt {
  return {
    requestId: request.requestId,
    payloadHash: hashOf(request),
    invokerContextId: INVOKER,
    refusalCode,
    refusedAt: "2026-08-03T00:00:00.000Z",
  };
}

/** One acceptance receipt charging `contextCount` contexts to `invokerContextId`. */
function seedAcceptance(input: {
  requestId: string;
  invokerContextId: string;
  contextCount: number;
}): GraphWorkflowExpansionAcceptanceReceipt {
  return {
    requestId: input.requestId,
    payloadHash: "f".repeat(64),
    invokerContextId: input.invokerContextId,
    initiatorConversationId: CONVERSATION_ID,
    rationale: "earlier fan-out",
    addedContextIds: Array.from(
      { length: input.contextCount },
      (_, i) => `${input.invokerContextId}-prior-${input.requestId}-${i}`,
    ),
    addedTaskIds: [],
    rejoinContextIds: [],
    liveRevision: 2,
    acceptedAt: "2026-08-03T00:00:00.000Z",
  };
}

/**
 * The receipts a lane would really have accrued to reach `contextCount`
 * contexts: no single request may exceed the per-request ceiling, so a budget
 * larger than that is spread over as many receipts as it actually took.
 */
function seedAcceptancesFor(
  invokerContextId: string,
  contextCount: number,
): GraphWorkflowExpansionAcceptanceReceipt[] {
  const receipts: GraphWorkflowExpansionAcceptanceReceipt[] = [];
  let remaining = contextCount;
  while (remaining > 0) {
    const chunk = Math.min(remaining, EXPANSION_CAPS.contextsPerRequest);
    receipts.push(
      seedAcceptance({
        requestId: `req-prior-${invokerContextId}-${receipts.length}`,
        invokerContextId,
        contextCount: chunk,
      }),
    );
    remaining -= chunk;
  }
  return receipts;
}

/** A syntactically valid request that creates `count` reachable contexts. */
function fanOutRequest(
  count: number,
  requestId = "req-1",
): GraphExpansionRequest {
  return graphExpansionRequestSchema.parse({
    requestId,
    rationale: "fan out candidates",
    contexts: Array.from({ length: count }, (_, i) => ({
      handle: `candidate-${i}`,
      title: `Candidate ${i}`,
      acceptanceCriteria: `Candidate ${i} works`,
      placement: { lane: `candidate-${i}-lane`, mode: "full" },
    })),
    tasks: Array.from({ length: count }, (_, i) => ({
      contextHandle: `candidate-${i}`,
      title: `Build ${i}`,
      instructions: `Implement approach ${i}.`,
    })),
    edges: Array.from({ length: count }, (_, i) => ({
      from: INVOKER,
      to: `candidate-${i}`,
    })),
  });
}

describe("graph expansion — idempotency (R6.3)", () => {
  it("replays the acceptance receipt for a repeated request without mutating the graph twice", async () => {
    const harness = makeHarness(runningExecution());
    const request = makeRequest();

    const first = await expandWith(harness, request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const afterFirst = structuredClone(harness.current());

    const second = await expandWith(harness, request);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.liveRevision).toBe(first.liveRevision);
    expect(second.createdContextIds).toEqual(first.createdContextIds);
    expect(second.createdTaskIds).toEqual(first.createdTaskIds);

    // No duplicate mutation: the definition, the revision, and the permanent
    // ledger are all exactly where the first acceptance left them.
    const afterSecond = harness.current();
    expect(afterSecond.workingDefinition).toEqual(afterFirst.workingDefinition);
    expect(afterSecond.liveRevision).toBe(afterFirst.liveRevision);
    expect(afterSecond.executionStateRevision).toBe(
      afterFirst.executionStateRevision,
    );
    expect(afterSecond.expansionReceipts.accepted).toHaveLength(1);

    // And exactly one acceptance was ever announced.
    expect(
      harness
        .committed()
        .filter(
          (event) =>
            event.type === "graph-workflow-graph-expanded" &&
            event.outcome === "accepted",
        ),
    ).toHaveLength(1);
  });

  it("replays an acceptance that consumed the last of the execution's budget", async () => {
    // Idempotency has to be decided BEFORE the caps, or the very request that
    // spent the final slot would be refused when its own lane retried it.
    const harness = makeHarness(runningExecution());
    const request = makeRequest();
    const first = await expandWith(harness, request);
    expect(first.ok).toBe(true);

    const saturated = structuredClone(harness.current());
    saturated.expansionReceipts = {
      accepted: [
        ...saturated.expansionReceipts.accepted,
        ...seedAcceptancesFor(
          "context-implement",
          EXPANSION_CAPS.contextsPerExecution -
            countExpansionCreatedContexts(saturated.expansionReceipts),
        ),
      ],
      refusals: saturated.expansionReceipts.refusals,
    };
    const saturatedHarness = makeHarness(saturated);

    const replay = await expandWith(saturatedHarness, request);

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
  });

  it("refuses the same requestId under a different payload and retains the refusal record", async () => {
    const harness = makeHarness(runningExecution());
    const accepted = makeRequest();
    expect((await expandWith(harness, accepted)).ok).toBe(true);

    const reused = makeRequest({ rationale: "a different reason entirely" });
    const before = structuredClone(harness.current());

    const outcome = await expandWith(harness, reused);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toEqual([
      "expansion-request-id-reused",
    ]);
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);

    // The refusal is DURABLE, not just broadcast — that is what lets the next
    // identical retry be answered from the ledger.
    expect(harness.current().expansionReceipts.refusals).toEqual([
      {
        requestId: "req-1",
        payloadHash: hashOf(reused),
        invokerContextId: INVOKER,
        refusalCode: "expansion-request-id-reused",
        refusedAt: "2026-08-04T00:00:00.000Z",
      },
    ]);
    expect(
      harness.broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-graph-expanded" &&
          event.outcome === "refused",
      ),
    ).toHaveLength(1);
  });

  it("re-refuses a retained refusal identically, without re-validating against current state", async () => {
    // The seeded refusal names a rejoin conflict that no longer exists: the
    // request below would be ACCEPTED if it were re-validated. Answering it from
    // the retained record is what "the refusal record is retained" buys.
    const request = makeRequest();
    const harness = makeHarness(
      runningExecution((execution) => {
        execution.expansionReceipts = {
          accepted: [],
          refusals: [seedRefusal(request, "expansion-rejoin-started")],
        };
      }),
    );
    const before = structuredClone(harness.current());

    const outcome = await expandWith(harness, request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toEqual([
      "expansion-rejoin-started",
    ]);
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    // Replaying a refusal records nothing new — the ring already holds it.
    expect(harness.current().expansionReceipts).toEqual(
      before.expansionReceipts,
    );
    expect(harness.current().executionStateRevision).toBe(
      before.executionStateRevision,
    );
    expect(
      harness.broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-graph-expanded" &&
          event.outcome === "refused",
      ),
    ).toMatchObject([{ refusalCode: "expansion-rejoin-started" }]);
  });

  it("re-validates an attempt whose refusal record was evicted from the ring", async () => {
    // The honest half of the eviction contract (decision D5): the ring is full
    // of LATER attempts, so this one is unknown — and an unknown attempt is a
    // new attempt, validated against current state rather than re-refused.
    const request = makeRequest();
    const harness = makeHarness(
      runningExecution((execution) => {
        execution.expansionReceipts = {
          accepted: [],
          refusals: Array.from(
            { length: EXPANSION_CAPS.refusalRingSize },
            (_, i) => ({
              requestId: `req-later-${i}`,
              payloadHash: `${i}`.padStart(64, "0"),
              invokerContextId: INVOKER,
              refusalCode: "expansion-cap-contexts-per-request",
              refusedAt: "2026-08-03T00:00:00.000Z",
            }),
          ),
        };
      }),
    );

    const outcome = await expandWith(harness, request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replayed).toBe(false);
    expect(harness.current().expansionReceipts.accepted).toHaveLength(1);
  });

  it("scopes the idempotency key to the invoking context", async () => {
    // Two lanes are independent authors; one lane's requestId must not make
    // another lane's identical id a replay or a reuse conflict.
    const harness = makeHarness(
      runningExecution((execution) => {
        execution.expansionReceipts = {
          accepted: [
            seedAcceptance({
              requestId: "req-1",
              invokerContextId: "context-implement",
              contextCount: 1,
            }),
          ],
          refusals: [],
        };
      }),
    );

    const outcome = await expandWith(harness, makeRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replayed).toBe(false);
  });

  it("persists the acceptance receipt with its provenance in the same mutation as the graph change", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const receipts = harness.current().expansionReceipts;
    expect(receipts.accepted).toEqual([
      {
        requestId: "req-1",
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        invokerContextId: INVOKER,
        initiatorConversationId: CONVERSATION_ID,
        rationale:
          "Fan out one candidate per approach and let the filter pick.",
        addedContextIds: outcome.createdContextIds,
        addedTaskIds: outcome.createdTaskIds,
        rejoinContextIds: ["context-verify"],
        liveRevision: outcome.liveRevision,
        acceptedAt: "2026-08-04T00:00:00.000Z",
      },
    ]);

    // Node-level provenance: every id the batch minted resolves back to the
    // receipt that authorized it, and a planner-authored context does not.
    for (const contextId of outcome.createdContextIds) {
      expect(resolveExpansionProvenance(receipts, contextId)).toMatchObject({
        nodeKind: "context",
        receipt: { requestId: "req-1" },
      });
    }
    for (const taskId of outcome.createdTaskIds) {
      expect(resolveExpansionProvenance(receipts, taskId)).toMatchObject({
        nodeKind: "task",
      });
    }
    expect(resolveExpansionProvenance(receipts, "context-verify")).toBeNull();
  });
});

describe("graph expansion — caps (R8.1)", () => {
  async function expectCapRefusal(
    harness: Harness,
    request: GraphExpansionRequest,
    code: string,
  ) {
    const before = structuredClone(harness.current());
    const outcome = await expandWith(harness, request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toEqual([code]);

    // Nothing about the graph moved, and no revision was spent on a refusal.
    const after = harness.current();
    expect(after.workingDefinition).toEqual(before.workingDefinition);
    expect(after.liveRevision).toBe(before.liveRevision);
    expect(after.contextStates).toEqual(before.contextStates);
    expect(after.taskStates).toEqual(before.taskStates);
    expect(after.expansionReceipts.accepted).toEqual(
      before.expansionReceipts.accepted,
    );

    // A typed refusal event, and a durable receipt carrying the same code.
    const refusals = harness.broadcasts.filter(
      (event) =>
        event.type === "graph-workflow-graph-expanded" &&
        event.outcome === "refused",
    );
    expect(refusals.at(-1)).toMatchObject({
      refusalCode: code,
      requestId: request.requestId,
      invokerContextId: INVOKER,
      addedContextIds: [],
    });
    expect(after.expansionReceipts.refusals.at(-1)).toEqual({
      requestId: request.requestId,
      payloadHash: hashOf(request),
      invokerContextId: INVOKER,
      refusalCode: code,
      refusedAt: "2026-08-04T00:00:00.000Z",
    });
  }

  it("admits a request sitting exactly on the per-request context ceiling", async () => {
    const harness = makeHarness(runningExecution());

    const outcome = await expandWith(
      harness,
      fanOutRequest(EXPANSION_CAPS.contextsPerRequest),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdContextIds).toHaveLength(
      EXPANSION_CAPS.contextsPerRequest,
    );
  });

  it("refuses a request one context past the per-request ceiling", async () => {
    const harness = makeHarness(runningExecution());

    await expectCapRefusal(
      harness,
      fanOutRequest(EXPANSION_CAPS.contextsPerRequest + 1),
      "expansion-cap-contexts-per-request",
    );
  });

  it("refuses a request one task past the per-request ceiling", async () => {
    const harness = makeHarness(runningExecution());

    await expectCapRefusal(
      harness,
      makeRequest({
        tasks: Array.from(
          { length: EXPANSION_CAPS.tasksPerRequest + 1 },
          (_, i) => ({
            contextHandle: "candidate-a",
            title: `Build step ${i}`,
            instructions: `Do step ${i}.`,
          }),
        ),
      }),
      "expansion-cap-tasks-per-request",
    );
  });

  it("refuses a request one edge past the per-request ceiling", async () => {
    const harness = makeHarness(runningExecution());

    await expectCapRefusal(
      harness,
      makeRequest({
        edges: Array.from(
          { length: EXPANSION_CAPS.edgesPerRequest + 1 },
          () => ({ from: INVOKER, to: "candidate-a" }),
        ),
      }),
      "expansion-cap-edges-per-request",
    );
  });

  it("refuses a payload past the canonical byte ceiling", async () => {
    const harness = makeHarness(runningExecution());

    await expectCapRefusal(
      harness,
      makeRequest({
        tasks: [
          {
            contextHandle: "candidate-a",
            title: "Build candidate A",
            instructions: "x".repeat(EXPANSION_CAPS.canonicalPayloadBytes + 1),
          },
        ],
      }),
      "expansion-cap-payload-bytes",
    );
  });

  it("refuses the request that would push one adding context past its ceiling", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        execution.expansionReceipts = {
          accepted: seedAcceptancesFor(
            INVOKER,
            EXPANSION_CAPS.contextsPerAddingContext,
          ),
          refusals: [],
        };
      }),
    );

    await expectCapRefusal(
      harness,
      makeRequest(),
      "expansion-cap-contexts-per-adding-context",
    );
  });

  it("refuses the request that would push the execution past its cumulative ceiling", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        // Spread across other invokers so the per-invoker ceiling cannot fire
        // first — the cumulative cap has to be what refuses.
        execution.expansionReceipts = {
          accepted: Array.from({ length: 5 }, (_, lane) =>
            seedAcceptance({
              requestId: `req-prior-${lane}`,
              invokerContextId: `context-other-${lane}`,
              contextCount: EXPANSION_CAPS.contextsPerExecution / 5,
            }),
          ),
          refusals: [],
        };
      }),
    );

    await expectCapRefusal(
      harness,
      makeRequest(),
      "expansion-cap-contexts-per-execution",
    );
  });

  it("still answers and audits the refusal when the receipt cannot be committed", async () => {
    // Durability is the receipt's job; ANSWERING the lane and emitting the
    // typed refusal event are not conditional on it. A commit that fails
    // degrades to the pre-receipt behaviour rather than swallowing the refusal.
    const harness = makeHarness(runningExecution());
    const service = createGraphWorkflowExpansionService({
      ...harness.deps,
      mutateActive: () => Promise.reject(new Error("write queue unavailable")),
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: fanOutRequest(EXPANSION_CAPS.contextsPerRequest + 1),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toEqual([
      "expansion-cap-contexts-per-request",
    ]);
    expect(
      harness.broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-graph-expanded" &&
          event.outcome === "refused",
      ),
    ).toMatchObject([{ refusalCode: "expansion-cap-contexts-per-request" }]);
  });

  it("keeps the refusal ring bounded under sustained refusals", async () => {
    const harness = makeHarness(runningExecution());

    for (let i = 0; i < EXPANSION_CAPS.refusalRingSize + 3; i += 1) {
      await expandWith(
        harness,
        fanOutRequest(EXPANSION_CAPS.contextsPerRequest + 1, `req-${i}`),
      );
    }

    const refusals = harness.current().expansionReceipts.refusals;
    expect(refusals).toHaveLength(EXPANSION_CAPS.refusalRingSize);
    expect(refusals[0]?.requestId).toBe("req-3");
    expect(refusals.at(-1)?.requestId).toBe(
      `req-${EXPANSION_CAPS.refusalRingSize + 2}`,
    );
  });

  it("never commits a refusal receipt into a replacement execution", async () => {
    // The receipt ledger is per-EXECUTION state, and `mutateActive` writes
    // whatever is active NOW, not what was validated a moment ago. If the
    // active execution is replaced between validation and the refusal commit,
    // an unfenced write would file execution-1's attempt in execution-2's
    // ledger while the event still names execution-1 — and R6.3 would then
    // answer a genuinely unknown request in the replacement from a foreign
    // receipt instead of validating it as NEW.
    const original = runningExecution();
    const replacement = runningExecution((execution) => {
      execution.id = "execution-2";
    });
    const replacementHarness = makeHarness(replacement);

    const service = createGraphWorkflowExpansionService({
      ...replacementHarness.deps,
      // Validated against execution-1; every commit lands on execution-2.
      getActiveExecution: () => Promise.resolve(original),
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: fanOutRequest(EXPANSION_CAPS.contextsPerRequest + 1, "req-swap"),
    });

    // The lane is still answered and the refusal still audited — only the
    // durability is given up, exactly as when the commit itself fails.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((entry) => entry.code)).toEqual([
      "expansion-cap-contexts-per-request",
    ]);
    expect(
      replacementHarness.broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-graph-expanded" &&
          event.outcome === "refused",
      ),
    ).toMatchObject([{ refusalCode: "expansion-cap-contexts-per-request" }]);

    // The replacement's ledger stays untouched: no foreign receipt, and no
    // graph change smuggled in alongside it.
    const after = replacementHarness.current();
    expect(after.id).toBe("execution-2");
    expect(after.expansionReceipts).toEqual({ accepted: [], refusals: [] });
    expect(after.liveRevision).toBe(replacement.liveRevision);
  });

  it("validates a request the replacement execution has never seen as NEW", async () => {
    // The consequence the fence protects (R6.3): after a swap, the same
    // (contextId, requestId) is unknown to the replacement's ledger, so it must
    // be re-validated against current state rather than answered from the
    // attempt that belonged to the previous execution.
    const original = runningExecution();
    const replacement = runningExecution((execution) => {
      execution.id = "execution-2";
    });
    const replacementHarness = makeHarness(replacement);

    const swapped = createGraphWorkflowExpansionService({
      ...replacementHarness.deps,
      getActiveExecution: () => Promise.resolve(original),
    });
    await swapped.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: fanOutRequest(EXPANSION_CAPS.contextsPerRequest + 1, "req-swap"),
    });

    // Same key, now a well-formed batch, addressed to the replacement. A
    // foreign refusal receipt would re-refuse it as a reused single-use id.
    const outcome = await createGraphWorkflowExpansionService(
      replacementHarness.deps,
    ).expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-2",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: makeRequest({ requestId: "req-swap" }),
    });

    expect(outcome.ok).toBe(true);
    const accepted = replacementHarness.current().expansionReceipts.accepted;
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.requestId).toBe("req-swap");
  });
});

describe("graph expansion — whole-batch rejoin admission (R6.4)", () => {
  it("refuses the whole batch when one of several rejoin targets has moved", async () => {
    const harness = makeHarness(
      runningExecution((execution) => {
        const verify = execution.contextStates["context-verify"];
        if (verify) verify.status = "running";
      }),
    );
    const before = structuredClone(harness.current());

    const outcome = await expandWith(
      harness,
      makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          // Legal on its own …
          { from: "candidate-a", to: "context-implement" },
          // … and refused, which takes the whole proposition with it.
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toEqual([
      "expansion-rejoin-started",
    ]);
    // Not even the legal half landed: no new context, and no edge into the
    // rejoin target that WOULD have been admitted.
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(
      harness
        .current()
        .workingDefinition.edges.filter(
          (edge) => edge.targetContextId === "context-implement",
        ),
    ).toEqual(
      before.workingDefinition.edges.filter(
        (edge) => edge.targetContextId === "context-implement",
      ),
    );
    expect(harness.current().expansionReceipts.accepted).toEqual([]);
  });

  it("refuses the whole batch when a rejoin target is reserved after the batch validated", async () => {
    // The per-target conditions are re-checked INSIDE the serialized mutation,
    // so a target reserved between validation and commit still refuses whole.
    const harness = makeHarness(runningExecution());
    const before = structuredClone(harness.current());
    const service = createGraphWorkflowExpansionService({
      ...harness.deps,
      mutateActive: (projectPath, sessionName, fn) => {
        const verify = harness.current().contextStates["context-verify"];
        if (verify) verify.reservedByBatchId = "batch-9";
        return harness.deps.mutateActive(projectPath, sessionName, fn);
      },
    });

    const outcome = await service.expand({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: INVOKER,
      conversationId: CONVERSATION_ID,
      request: makeRequest({
        edges: [
          { from: INVOKER, to: "candidate-a" },
          { from: "candidate-a", to: "context-implement" },
          { from: "candidate-a", to: "context-verify" },
        ],
      }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      "expansion-rejoin-reserved",
    );
    expect(harness.current().workingDefinition).toEqual(
      before.workingDefinition,
    );
    expect(harness.current().liveRevision).toBe(before.liveRevision);
  });
});
