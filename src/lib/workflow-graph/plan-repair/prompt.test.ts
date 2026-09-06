import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "../test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowValidationAdvisory,
} from "../schemas";
import {
  buildPlanRepairPrompt,
  toPlanRepairValidationVerdict,
  type PlanRepairPromptInput,
} from "./prompt";

function makeInput(
  overrides: Partial<PlanRepairPromptInput> = {},
): PlanRepairPromptInput {
  const base = createWorkflowExecution({
    status: "halted",
    haltReason: {
      type: "circuit_breaker",
      contextId: "context-implement",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
  });
  const execution: GraphWorkflowExecution = {
    ...base,
    taskStates: {
      ...base.taskStates,
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: "endpoint /v2/users does not exist",
        failureHistory: [
          {
            message: "endpoint /v2/users does not exist",
            timestamp: "2026-07-29T00:01:00.000Z",
          },
        ],
      },
    },
  };
  return {
    execution,
    contextId: "context-implement",
    haltReason: execution.haltReason!,
    attempt: 1,
    validationHistory: [
      {
        pass: false,
        summary: "AC requires calling /v2/users which was removed",
        issues: [
          {
            taskId: "task-implement-1",
            title: "Impossible endpoint",
            description: "The API surface has no /v2/users route",
          },
        ],
      },
    ],
    ...overrides,
  };
}

it("directs repair toward an appended correction when the halted context has frozen tasks", () => {
  const input = makeInput();
  const task = input.execution.taskStates["task-implement-1"];
  const context = input.execution.contextStates["context-implement"];
  if (!task || !context) throw new Error("missing repair fixture");
  task.status = "completed";
  context.status = "halted";
  const prompt = buildPlanRepairPrompt(input);
  expect(prompt).toContain("task-implement-1: frozen");
  expect(prompt).toContain("context-implement: editable");
  expect(prompt).toContain("Append a correction with add-task");
});

/** Two blocking seats refusing the contract, as the engine records the halt. */
function planDefectHalt(): GraphWorkflowHaltReason {
  return {
    type: "plan_defect",
    contextId: "context-implement",
    planDefects: [
      {
        assignmentId: "general",
        title: "Criterion 2 names a context this one cannot touch",
        description: "The publisher belongs to a later context in the graph.",
        whyNotLocallyRemediable:
          "Every task here is scoped to the reader; none may edit the publisher.",
        conflictingContract: "Acceptance criterion 2",
      },
      {
        assignmentId: "security",
        title: "The charter forbids the only viable approach",
        description: "The criterion can only be met by writing to the DB.",
        whyNotLocallyRemediable:
          "No task can satisfy the criterion without breaking the invariant.",
        conflictingContract: "Charter invariant no-direct-db-writes",
      },
    ],
    roundSeq: 3,
    summary: null,
  };
}

describe("buildPlanRepairPrompt", () => {
  it("embeds the failure evidence, plan artifacts, and budgets", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    // Halt + budgets
    expect(prompt).toContain("circuit_breaker");
    expect(prompt).toContain("3"); // failure count vs threshold rendering
    // Context plan artifacts
    expect(prompt).toContain("Feature implemented"); // fixture AC
    // Failure evidence
    expect(prompt).toContain("endpoint /v2/users does not exist");
    expect(prompt).toContain("AC requires calling /v2/users which was removed");
    // Charter digest (fixture charter content renders)
    expect(prompt.toLowerCase()).toContain("charter");
    // Decision framework + guardrail
    expect(prompt).toContain("Do not weaken acceptance criteria");
    expect(prompt).toContain("planningDefect");
    // Op vocabulary with EXACT JSON shapes (live-proof regression: the agent
    // emitted typeless operations when only prose named the vocabulary).
    expect(prompt).toContain('"type": "amend-charter"');
    expect(prompt).toContain('"type": "update-context"');
    expect(prompt).toContain('"type": "update-task"');
    expect(prompt).toContain('"payload"');
    expect(prompt).toContain("Do not repeat `type` inside `payload`");
    expect(prompt).toContain('"appliesTo": {"contextIds": ["..."]}');
  });

  // The op vocabulary is the agent's ONLY view of what it may change: a field
  // absent from these shapes is a capability it never uses. An
  // `output_schema_validation` breaker trip is unrepairable without it.
  it("offers outputSchema on update-context so a too-tight output contract is repairable", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).toContain('"outputSchema"');
    const updateContextShape = prompt
      .split("\n")
      .find((line) => line.includes('"type": "update-context"'));
    expect(updateContextShape).toBeDefined();
    expect(updateContextShape).toContain('"outputSchema"');
    // `null` is the only way to return a context to free-form output.
    expect(updateContextShape).toContain("null");
  });

  it("frames an output_schema_validation trip as a contract failure and shows the declared schema", () => {
    const base = makeInput();
    const outputSchema = {
      type: "object",
      properties: { migrationId: { type: "string" } },
      required: ["migrationId"],
      additionalProperties: false,
    };
    const contexts = base.execution.workingDefinition.executionContexts.map(
      (context) =>
        context.id === "context-implement"
          ? { ...context, outputSchema }
          : context,
    );
    const haltReason = {
      type: "circuit_breaker" as const,
      contextId: "context-implement",
      condition: "output_schema_validation" as const,
      failureCount: 3,
      summary: "$.migrationId: required property is missing",
    };
    const execution: GraphWorkflowExecution = {
      ...base.execution,
      haltReason,
      workingDefinition: {
        ...base.execution.workingDefinition,
        executionContexts: contexts,
      },
    };

    const prompt = buildPlanRepairPrompt({ ...base, execution, haltReason });

    expect(prompt).toContain("### Declared output schema");
    expect(prompt).toContain('"migrationId"');
    expect(prompt).toContain("output-contract failure, not a work failure");
    // A retry_exhaustion trip must not pick up the contract framing.
    expect(buildPlanRepairPrompt(makeInput())).not.toContain(
      "output-contract failure",
    );
  });

  // A plan-defect halt arrives pre-classified: a blocking seat already said
  // WHAT is wrong with the contract and WHY no task can fix it. Rendering that
  // after the round history would bury the one reading this round exists to
  // answer under the verdicts that merely surrounded it.
  it("renders every plan-defect finding ahead of the validation history", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({ haltReason: planDefectHalt() }),
    );

    const section = prompt.indexOf("## Plan defect");
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeLessThan(prompt.indexOf("## Validation history"));

    const defects = prompt.slice(section, prompt.indexOf("## Validation"));
    // Every field the seat is required to supply, attributed to the seat —
    // two reviewers refusing the same contract is a different reading from one
    // reviewer refusing it twice.
    expect(defects).toContain("general");
    expect(defects).toContain(
      "Criterion 2 names a context this one cannot touch",
    );
    expect(defects).toContain(
      "The publisher belongs to a later context in the graph.",
    );
    expect(defects).toContain(
      "Every task here is scoped to the reader; none may edit the publisher.",
    );
    expect(defects).toContain("Acceptance criterion 2");
    expect(defects).toContain("security");
    expect(defects).toContain("The charter forbids the only viable approach");
    expect(defects).toContain("Charter invariant no-direct-db-writes");
  });

  it("renders no plan-defect section for a halt that carries no defect", () => {
    expect(buildPlanRepairPrompt(makeInput())).not.toContain("## Plan defect");
  });

  // #69 change 4 stage 1: the op vocabulary is the agent's only view of the
  // acceptanceCriteria shape, and the whole-value semantics — replace the
  // array, no per-criterion ops — are not discoverable from the shape alone.
  it("documents acceptanceCriteria as ordered records that update-context replaces wholesale", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    const updateContextShape = prompt
      .split("\n")
      .find((line) => line.startsWith('{"type": "update-context"'));
    expect(updateContextShape).toContain(
      '"acceptanceCriteria": [{"id": "<kebab-case>", "statement": "..."}]',
    );
    expect(prompt).toContain("replaces the WHOLE value");
    expect(prompt).toContain("per-criterion operations do not exist");
  });

  // The evidence cites criterion ids (validator-runner binds them to the
  // context's record ids), so the AC list the agent reads must show the ids
  // those citations and its own whole-array rewrites line up against.
  it("renders prose criteria as the single wrapped ac-1 record", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).toContain("1. [ac-1] Feature implemented");
  });

  it("renders record criteria as the numbered list citing each stored id", () => {
    const base = makeInput();
    const contexts = base.execution.workingDefinition.executionContexts.map(
      (context) =>
        context.id === "context-implement"
          ? {
              ...context,
              acceptanceCriteria: [
                {
                  id: "list-endpoint",
                  statement: "GET /v2/users returns the roster",
                },
                {
                  id: "auth-guard",
                  statement: "Unauthenticated calls get 401",
                },
              ],
            }
          : context,
    );
    const execution: GraphWorkflowExecution = {
      ...base.execution,
      workingDefinition: {
        ...base.execution.workingDefinition,
        executionContexts: contexts,
      },
    };

    const prompt = buildPlanRepairPrompt({ ...base, execution });

    expect(prompt).toContain(
      "1. [list-endpoint] GET /v2/users returns the roster",
    );
    expect(prompt).toContain("2. [auth-guard] Unauthenticated calls get 401");
  });

  it("cites the criterion id a finding carries, and stays silent when absent", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        validationHistory: [
          {
            pass: false,
            summary: "the endpoint criterion fails",
            issues: [
              {
                taskId: "task-implement-1",
                criterionId: "ac-1",
                title: "Impossible endpoint",
                description: "The API surface has no /v2/users route",
              },
            ],
          },
        ],
      }),
    );

    expect(prompt).toContain(
      "task-implement-1 (criterion ac-1): Impossible endpoint",
    );
    // The default history carries no criterionId, so no citation renders —
    // an invented or placeholder id would be worse than none.
    expect(buildPlanRepairPrompt(makeInput())).not.toContain("(criterion");
  });

  it("caps the validation history at the five most recent verdicts", () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      pass: false,
      summary: `verdict-${i + 1}`,
      issues: [],
    }));
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: history }),
    );

    expect(prompt).not.toContain("verdict-1");
    expect(prompt).not.toContain("verdict-2");
    expect(prompt).toContain("verdict-3");
    expect(prompt).toContain("verdict-7");
  });

  it("adds the budget-mechanics warning for max_iterations halts", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        haltReason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 10,
          summary: null,
        },
      }),
    );

    expect(prompt).toContain("maxIterations");
    expect(prompt).toContain("re-halt immediately");
  });

  // The trigger admits this halt on the claim that its remedies are
  // `update-context` repairs — placement above all. An agent shown neither the
  // halt's mechanics nor a placement field can only decline.
  it("frames a candidate_unstable halt around placement and scope, and offers placement in the vocabulary", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        haltReason: {
          type: "candidate_unstable",
          contextId: "context-implement",
          stage: "post_script",
          driftedComponents: "candidateTreeHash",
          consecutiveCount: 5,
          lastIncident: "candidate_mismatch",
          message: "the reviewed candidate never held still",
          summary: null,
        },
      }),
    );

    expect(prompt).toContain("placement");
    expect(prompt).toContain("never reached a verdict");
    const updateContextShape = prompt
      .split("\n")
      .find((line) => line.includes('"type": "update-context"'));
    expect(updateContextShape).toContain('"placement"');
  });

  it("renders prior repair rounds so the agent sees what already failed", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({
        attempt: 2,
        priorRounds: [
          {
            seq: 1,
            contextId: "context-implement",
            haltType: "circuit_breaker",
            loopGroupId: null,
            startedAt: "2026-07-28T00:00:00.000Z",
            settledAt: "2026-07-28T00:05:00.000Z",
            outcome: "repaired",
            planningDefect: true,
            diagnosis: "First repair clarified the AC wording",
            operationCount: 1,
            resumed: true,
            conversationId: "conv-1",
          },
        ],
      }),
    );

    expect(prompt).toContain("First repair clarified the AC wording");
    expect(prompt).toContain("attempt 2");
  });
});

// R14.1: a breaker trip from a multi-validator cohort. What the repair agent
// must be able to tell apart is "one reviewer keeps failing the same thing"
// from "several lenses each found something different" — the first is usually
// an implementation problem, the second is where a planning defect lives.
describe("buildPlanRepairPrompt: cohort evidence", () => {
  const COHORT_VERDICT = {
    pass: false,
    summary: "general: ok\nsecurity: no\nperf: no",
    issues: [
      {
        taskId: "task-implement-1",
        title: "Secrets in the log line",
        description: "The handler logs the bearer token.",
        assignmentId: "security",
      },
      {
        taskId: "task-implement-1",
        title: "N+1 on the members query",
        description: "One query per row.",
        assignmentId: "perf",
      },
    ],
    specialists: [
      {
        assignmentId: "general",
        profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
        pass: true,
        summary: "general: ok",
        issues: [],
      },
      {
        assignmentId: "security",
        profile: { tier: "project", id: "security-reviewer", revision: 4 },
        pass: false,
        summary: "security: no",
        issues: [
          {
            taskId: "task-implement-1",
            title: "Secrets in the log line",
            description: "The handler logs the bearer token.",
            assignmentId: "security",
          },
        ],
      },
      {
        assignmentId: "perf",
        profile: { tier: "global", id: "perf-reviewer", revision: 7 },
        pass: false,
        summary: "perf: no",
        issues: [
          {
            taskId: "task-implement-1",
            title: "N+1 on the members query",
            description: "One query per row.",
            assignmentId: "perf",
          },
        ],
      },
    ],
  };

  it("groups findings by assignment and names the profile that produced each", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: [COHORT_VERDICT] }),
    );

    expect(prompt).toContain(
      "- security (project/security-reviewer rev 4) [fail]",
    );
    expect(prompt).toContain("- perf (global/perf-reviewer rev 7) [fail]");
    // A passing member is shown too: "two of three objected" is a different
    // diagnosis from "the whole cohort objected".
    expect(prompt).toContain(
      "- general (builtin/general-reviewer rev 1) [pass]",
    );

    // Each finding sits under the specialist that raised it.
    const securityBlock = prompt.slice(
      prompt.indexOf("- security ("),
      prompt.indexOf("- perf ("),
    );
    expect(securityBlock).toContain("Secrets in the log line");
    expect(securityBlock).not.toContain("N+1 on the members query");
  });

  it("keeps the flat rendering for a single-reviewer round", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).toContain("Impossible endpoint");
    expect(prompt).not.toContain("rev 1) [");
  });

  it("carries a specialist's criterion citation into its grouped finding", () => {
    const verdict = {
      ...COHORT_VERDICT,
      specialists: COHORT_VERDICT.specialists.map((specialist) =>
        specialist.assignmentId === "security"
          ? {
              ...specialist,
              issues: [{ ...specialist.issues[0]!, criterionId: "ac-1" }],
            }
          : specialist,
      ),
    };

    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: [verdict] }),
    );

    expect(prompt).toContain(
      "task-implement-1 (criterion ac-1): Secrets in the log line",
    );
  });

  // D10: the repair agent may narrow ONE named assignment and may never write
  // the cohort. A vocabulary that offered roster operations would let a repair
  // remove the reviewer that keeps objecting instead of fixing what it objects
  // to — and one that offered promotion would let a halt mint new ways to fail.
  it("offers narrowing on a named assignment and no roster operations", () => {
    const prompt = buildPlanRepairPrompt(
      makeInput({ validationHistory: [COHORT_VERDICT] }),
    );

    const vocabulary = prompt.slice(
      prompt.indexOf("## Allowed repair operations"),
    );
    for (const forbidden of [
      "add-validator",
      "remove-validator",
      "set-validator",
      "add-assignment",
      "remove-assignment",
      "contextValidator",
      "assignments",
      "profileSnapshot",
      "implementer",
    ]) {
      expect(vocabulary).not.toContain(forbidden);
    }
    // The allowed vocabulary is the plan-artifact set plus the narrowing op.
    expect(
      // Line-anchored: each operation shape occupies its own line, so a
      // nested `{"type": "object"}` inside a JSON Schema example is not one.
      [...vocabulary.matchAll(/^\{"type": "([a-z-]+)"/gm)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "amend-charter",
      "update-context",
      "add-task",
      "update-task",
      "remove-task",
      "reorder-tasks",
      "update-validator-assignment",
    ]);
    // The one authority value the op shape shows is the one it accepts.
    const narrowingShape = vocabulary
      .split("\n")
      .find((line) =>
        line.startsWith('{"type": "update-validator-assignment"'),
      );
    expect(narrowingShape).toContain('"authority": "advisory"');
  });
});

// R10/D10: the advisories a run raised are evidence about the plan that nobody
// was obliged to act on, so the repair agent — the one reader whose job IS the
// plan — must see them, together with what the implementer decided about each.
describe("buildPlanRepairPrompt: advisory evidence", () => {
  function advisory(
    overrides: Partial<GraphWorkflowValidationAdvisory> & {
      identity: GraphWorkflowValidationAdvisory["identity"];
    },
  ): GraphWorkflowValidationAdvisory {
    return {
      kind: "implementation",
      title: "Consider extracting the helper",
      description: "The same shape appears in two places.",
      deliveredAt: null,
      disposition: null,
      ...overrides,
    };
  }

  function withRound(
    execution: GraphWorkflowExecution,
    contextId: string,
    seq: number,
    seats: Record<string, GraphWorkflowValidationAdvisory[]>,
  ): GraphWorkflowExecution {
    const contextState = execution.contextStates[contextId];
    if (!contextState) throw new Error(`no runtime state for ${contextId}`);
    return {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        [contextId]: {
          ...contextState,
          validationRound: {
            seq,
            candidate: {
              identityScope: "wholeTree",
              headSha: "head-1",
              candidateTreeHash: "tree-1",
              taskStateHash: "tasks-1",
            },
            roster: Object.keys(seats).map((assignmentId) => ({
              assignmentId,
              profileRef: { tier: "builtin" as const, id: "general-reviewer" },
              revision: 1,
              resolvedInstructionHash: `sha256:${assignmentId}`,
              strategy: "conversation" as const,
            })),
            specialists: Object.fromEntries(
              Object.entries(seats).map(([assignmentId, advisories]) => [
                assignmentId,
                {
                  state: "verdict_pass" as const,
                  attempts: 1,
                  summary: `${assignmentId} reviewed the work.`,
                  issues: [],
                  advisories,
                  questionToken: null,
                  sessionRef: null,
                  reviewArtifact: null,
                  lastInfraFailure: null,
                },
              ]),
            ),
            phase: "concluded" as const,
            outcome: "failed" as const,
            startedAt: "2026-07-29T00:00:00.000Z",
          },
        },
      },
    };
  }

  it("carries the tripped context's advisories and their dispositions", () => {
    const base = makeInput();
    const execution = withRound(base.execution, "context-implement", 2, {
      security: [
        advisory({
          identity: { roundSeq: 2, assignmentId: "security", ordinal: 1 },
          kind: "implementation",
          title: "The handler logs the bearer token",
          description: "Redact it before the log line.",
          deliveredAt: "2026-07-29T00:02:00.000Z",
          disposition: {
            outcome: "declined",
            reason: "The log sink is already private",
            recordedAt: "2026-07-29T00:03:00.000Z",
          },
        }),
      ],
      perf: [
        advisory({
          identity: { roundSeq: 2, assignmentId: "perf", ordinal: 1 },
          kind: "plan",
          title: "The rollback step belongs in its own task",
          description: "Reverting the migration is work in its own right.",
        }),
      ],
    });

    const prompt = buildPlanRepairPrompt({ ...base, execution });

    expect(prompt).toContain("The handler logs the bearer token");
    expect(prompt).toContain("Redact it before the log line.");
    expect(prompt).toContain("declined");
    expect(prompt).toContain("The log sink is already private");
    // The undisposed one reads as undisposed rather than as an unanswered
    // demand: a repair agent that cannot tell them apart invents obligations.
    expect(prompt).toContain("The rollback step belongs in its own task");
    expect(prompt).toContain("not yet delivered");
  });

  it("carries another context's long-lived advisories and drops its round-local ones", () => {
    const base = makeInput();
    const execution = withRound(base.execution, "context-plan", 1, {
      general: [
        advisory({
          identity: { roundSeq: 1, assignmentId: "general", ordinal: 1 },
          kind: "plan",
          title: "The plan assumes an endpoint nobody owns",
          description: "No task in this workflow creates /v2/users.",
          deliveredAt: "2026-07-28T00:02:00.000Z",
        }),
        advisory({
          identity: { roundSeq: 1, assignmentId: "general", ordinal: 2 },
          kind: "implementation",
          title: "The planning doc has a stale heading",
          description: "Cosmetic only.",
        }),
      ],
    });

    const prompt = buildPlanRepairPrompt({ ...base, execution });

    // A `plan` advisory outlives the round that raised it (D9) and is exactly
    // what this agent exists to weigh, wherever in the run it was raised.
    expect(prompt).toContain("The plan assumes an endpoint nobody owns");
    expect(prompt).toContain("context-plan");
    // An `implementation` advisory was answered inside its own context's round
    // by the implementer who owned that work; replaying it here is noise.
    expect(prompt).not.toContain("The planning doc has a stale heading");
  });

  it("omits the section entirely for a run whose validators raised nothing", () => {
    expect(buildPlanRepairPrompt(makeInput())).not.toContain("## Advisories");
  });
});

describe("toPlanRepairValidationVerdict", () => {
  it("carries the aggregate's specialist entries into the prompt's evidence", () => {
    const verdict = toPlanRepairValidationVerdict({
      pass: false,
      summary: "security: no",
      issues: [{ taskId: "t", title: "a", description: "b" }],
      specialists: [
        {
          assignmentId: "security",
          profile: { tier: "project", id: "security-reviewer", revision: 4 },
          pass: false,
          summary: "security: no",
          issues: [{ taskId: "t", title: "a", description: "b" }],
        },
      ],
    });

    expect(verdict.specialists).toHaveLength(1);
    expect(verdict.specialists?.[0]?.profile.revision).toBe(4);
  });

  it("omits the grouping entirely for a legacy row with no entries", () => {
    const verdict = toPlanRepairValidationVerdict({
      pass: true,
      summary: "ok",
      issues: [],
      specialists: [],
    });

    expect(verdict.specialists).toBeUndefined();
  });
});

describe("the loop halt briefing (R12.1)", () => {
  function loopInput(
    overrides: Partial<PlanRepairPromptInput> = {},
  ): PlanRepairPromptInput {
    const base = makeInput();
    const definition = base.execution.workingDefinition;
    const worker = definition.executionContexts[0]!;
    const haltReason = {
      type: "loop_limit_reached" as const,
      scope: "loop" as const,
      loopGroupId: "refine",
      pass: 3,
      maxPasses: 3,
      verdict: "unsatisfied" as const,
      passCount: 3,
      totalPassCount: 3,
      contextId: "refine__p3__judge",
      message: 'loop "refine" reached its 3-pass budget',
      summary: null,
    };
    const execution: GraphWorkflowExecution = {
      ...base.execution,
      haltReason,
      workingDefinition: {
        ...definition,
        loopGroups: [
          {
            id: "refine",
            entryContextId: "worker",
            exitContextId: "judge",
            until: {
              schema: {
                type: "object",
                properties: { verdict: { const: "pass" } },
                required: ["verdict"],
              },
            },
            maxPasses: 3,
            templateVersion: 2,
            template: {
              contexts: [{ ...worker, id: "worker", title: "Worker" }],
              tasks: [],
              edges: [],
            },
            planRepair: { enabled: true, maxAttemptsPerContext: 2 },
          },
        ],
      },
    };
    return {
      ...base,
      execution,
      haltReason,
      contextId: "refine__p3__judge",
      loop: { loopGroupId: "refine", scope: "loop" },
      ...overrides,
    };
  }

  it("briefs the loop, its predicate, and the three ops it may use", () => {
    const prompt = buildPlanRepairPrompt(loopInput());

    // The loop the agent is repairing, and the bar its passes were judged on.
    expect(prompt).toContain("refine");
    expect(prompt).toContain("### Exit predicate");
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain("template version 2");
    // The op vocabulary, in the same EXACT-shape form the plan ops use.
    expect(prompt).toContain('"type": "raise-loop-max-passes"');
    expect(prompt).toContain('"type": "amend-loop-predicate"');
    expect(prompt).toContain('"type": "edit-loop-template"');
    // The two rules the agent cannot discover from the shapes alone.
    expect(prompt).toContain("rationale");
    expect(prompt).toMatch(/never retroactive|not retroactive/i);
  });

  // The template edit's update-context replaces acceptanceCriteria wholesale
  // too — the nested shape must show the records form for the same reason the
  // plan-op shape does.
  it("shows the records shape in the template-edit vocabulary too", () => {
    const prompt = buildPlanRepairPrompt(loopInput());

    const templateEditShape = prompt
      .split("\n")
      .find((line) => line.startsWith('{"type": "edit-loop-template"'));
    expect(templateEditShape).toContain(
      '"acceptanceCriteria": [{"id": "<kebab-case>", "statement": "..."}]',
    );
  });

  it("withholds the cap raise on a backstop halt, naming the remedy that works", () => {
    const base = loopInput();
    const prompt = buildPlanRepairPrompt({
      ...base,
      loop: { loopGroupId: "refine", scope: "execution" },
    });

    expect(prompt).not.toContain('"type": "raise-loop-max-passes"');
    expect(prompt).toMatch(/backstop/i);
    expect(prompt).toContain('"type": "amend-loop-predicate"');
  });

  it("offers no loop ops on an ordinary context halt", () => {
    const prompt = buildPlanRepairPrompt(makeInput());

    expect(prompt).not.toContain('"type": "raise-loop-max-passes"');
    expect(prompt).not.toContain('"type": "amend-loop-predicate"');
    expect(prompt).not.toContain('"type": "edit-loop-template"');
  });
});
