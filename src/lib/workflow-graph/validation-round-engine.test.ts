import { createContextIterationFixture } from "@/lib/workflow-graph/testing/iteration-fixture";
import { captureContextReviewOrigin } from "./review-origin";
import type { ContextPlacement } from "./definition-schemas";
import type {
  ExecutionMutationDecision as FixtureDecision,
  ExecutionMutationOutcome as FixtureOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createContextTestCapabilities } from "@/lib/workflow-graph/testing/context-capabilities";
import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
} from "@/lib/workflow-graph/execution-events";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";

import type { CandidateScope } from "@/lib/git/diff";
import {
  computeTaskStateHash,
  type ValidationCandidateTreeResolution,
} from "./validation-round";
import type { GraphWorkflowContextValidationOutcome } from "./validator-cohort-runner";
import type { ScriptValidatorOutcome } from "./script-validator-runner";

const NOW = "2026-08-04T12:00:00.000Z";

function createRepository(initial: GraphWorkflowExecution) {
  let active = initial;
  let lock: Promise<void> = Promise.resolve();
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];

  const repository = {
    async getActive() {
      return active;
    },
    async mutateActive<Value, Refusal>(
      _projectPath: string,
      _sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => FixtureDecision<Value, Refusal>,
    ): Promise<FixtureOutcome<Value, Refusal>> {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        return applyFixtureMutation(active, fn, (next, delivery) => {
          active = next;
          appendedEvents.push(...delivery.events);
          repository.deliver(delivery);
        });
      } finally {
        release();
      }
    },
    async findLatestContextValidationEvent() {
      return null;
    },
    read() {
      return active;
    },
    appendedEvents,
    deliver: (_delivery: GraphWorkflowEventDelivery) => {},
  };
  return repository;
}

/**
 * A context whose tasks are all complete, reviewed by a cohort of two, with the
 * deterministic script validator enabled. `runIteration` takes the
 * validation-only re-entry path for it, so every assertion below is about the
 * round rather than about implementer turns.
 */
function createCohortExecution(
  options: { scriptValidator?: boolean; placement?: ContextPlacement } = {},
): GraphWorkflowExecution {
  const base = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: base.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            placement: options.placement ?? context.placement,
            contextValidator: {
              enabled: true,
              assignments: [
                makeSeededValidatorAssignment({ id: "general" }),
                makeSeededValidatorAssignment({ id: "security-reviewer" }),
              ],
            },
            scriptValidator: {
              commands: (options.scriptValidator ?? true) ? ["pre-merge"] : [],
            },
          }
        : context,
    ),
  });

  const execution = createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
  });
  captureContextReviewOrigin(execution, "context-plan", "head-1", NOW);
  execution.contextStates["context-plan"] = {
    ...execution.contextStates["context-plan"]!,
    status: "running",
    completedTaskCount: 1,
    iterationCount: 2,
    consecutiveFailureCount: 1,
    consecutiveCandidateMismatchCount: 0,
  };
  execution.taskStates["task-plan-1"] = {
    ...execution.taskStates["task-plan-1"]!,
    status: "completed",
    summary: "Documented the plan.",
    completedAt: "2026-08-04T11:00:00.000Z",
  };
  return execution;
}

function passingScriptValidator() {
  return {
    runScriptValidator: vi.fn(
      async (): Promise<ScriptValidatorOutcome> => ({
        kind: "pass",
        treeState: { headSha: "head-1", dirty: true },
        command: "bun run pre-merge",
      }),
    ),
  };
}

function passingValidation(): GraphWorkflowContextValidationOutcome {
  return {
    kind: "pass",
    summary: "Looks good.",
    feedback: "Context validation passed.",
    issues: [],
    reopenTaskIds: [],
  };
}

interface Harness {
  repository: ReturnType<typeof createRepository>;
  orchestrator: ReturnType<typeof createContextIterationFixture>;
  run(): Promise<void>;
  probeCount(): number;
  /** Every candidate scope the engine asked a probe for, in probe order. */
  probedScopes(): CandidateScope[];
}

function createHarness(params: {
  execution: GraphWorkflowExecution;
  trees: ValidationCandidateTreeResolution[];
  scriptValidatorService?: {
    runScriptValidator: (input: unknown) => Promise<ScriptValidatorOutcome>;
  };
  validateContextCompletion?: (
    input: unknown,
  ) => Promise<GraphWorkflowContextValidationOutcome>;
}): Harness {
  const repository = createRepository(params.execution);
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    now: () => NOW,
  });
  repository.deliver = eventPublisher.deliver;

  // Successive probes of the same worktree. The engine probes at round start
  // and again after the script phase (and once more before publishing), so a
  // test moves the candidate simply by queueing a different tree.
  let probe = 0;
  const probedScopes: CandidateScope[] = [];
  const resolveCandidateTree = vi.fn(
    async (input: {
      candidateScope: CandidateScope;
    }): Promise<ValidationCandidateTreeResolution> => {
      probedScopes.push(input.candidateScope);
      const tree = params.trees[Math.min(probe, params.trees.length - 1)]!;
      probe += 1;
      return tree;
    },
  );

  // Mirrors what the execution loop does with a halt: stamps the reason on the
  // execution so a test can read the terminal state back from the repository.
  const signalHalt = vi.fn(
    async (halt: { reason: GraphWorkflowExecution["haltReason"] }) => {
      const current = structuredClone(repository.read());
      current.status = "halted";
      current.haltReason = halt.reason;
      await repository
        .mutateActive("/repo", "session-1", () => changed(current))
        .then((mutation) => mutation.execution);
      return current;
    },
  );

  const orchestrator = createContextIterationFixture({
    ...createContextTestCapabilities(),
    materializeWorkflowDocuments: async ({ execution }) => execution,

    executionContract: createNonParticipatingGraphExecutionContract(),

    executionRepository: repository,
    signalHalt,
    findLatestContextValidationEvent:
      repository.findLatestContextValidationEvent,
    createConversation: vi.fn(async () => ({ id: "conversation-impl" })),
    runAgentIteration: vi.fn(async () => {
      throw new Error("the validation-only path must not run the implementer");
    }),
    validationService: {
      validateContextCompletion:
        params.validateContextCompletion ?? (async () => passingValidation()),
    },
    scriptValidatorService:
      params.scriptValidatorService ?? passingScriptValidator(),
    validationRoundService: { resolveCandidateTree },
    eventPublisher,
    now: () => NOW,
  });

  return {
    repository,
    orchestrator,
    async run() {
      await orchestrator.runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
      });
    },
    probeCount: () => probe,
    probedScopes: () => probedScopes,
  };
}

function incidentEvents(repository: ReturnType<typeof createRepository>) {
  return repository.appendedEvents.filter(
    (entry) => entry.event.type === "graph-workflow-validation-incident",
  );
}

function validationResultEvents(
  repository: ReturnType<typeof createRepository>,
) {
  return repository.appendedEvents.filter(
    (entry) => entry.event.type === "graph-workflow-validation-result",
  );
}

const TREE_A: ValidationCandidateTreeResolution = {
  kind: "resolved",
  identityScope: "wholeTree",
  headSha: "head-1",
  candidateTreeHash: "tree-a",
};
const TREE_B: ValidationCandidateTreeResolution = {
  kind: "resolved",
  identityScope: "wholeTree",
  headSha: "head-1",
  candidateTreeHash: "tree-b",
};
const TREE_UNAVAILABLE: ValidationCandidateTreeResolution = {
  kind: "unavailable",
  reason: "fatal: not a git repository",
};

describe("validation round: freeze at round start", () => {
  it("freezes the candidate and the whole roster before the script validator runs", async () => {
    const execution = createCohortExecution();
    let roundAtScriptTime: GraphWorkflowExecution["contextStates"][string]["validationRound"] =
      null;

    const harness = createHarness({
      execution,
      trees: [TREE_A],
      scriptValidatorService: {
        runScriptValidator: vi.fn(async () => {
          roundAtScriptTime =
            harness.repository.read().contextStates["context-plan"]
              ?.validationRound ?? null;
          return {
            kind: "pass" as const,
            treeState: { headSha: "head-1", dirty: true },
            command: "bun run pre-merge",
          };
        }),
      },
    });

    await harness.run();

    expect(roundAtScriptTime).not.toBeNull();
    const round = roundAtScriptTime!;
    expect(round.seq).toBe(1);
    expect(round.phase).toBe("script");
    expect(round.startedAt).toBe(NOW);
    expect(round.candidate).toEqual({
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-a",
      taskStateHash: computeTaskStateHash(execution.taskStates, "context-plan"),
    });
    // The WHOLE cohort is frozen up front — not the one specialist that runs
    // first — so the roster describes who owns the candidate, in cohort order.
    expect(round.roster.map((entry) => entry.assignmentId)).toEqual([
      "general",
      "security-reviewer",
    ]);
    expect(Object.keys(round.specialists).sort()).toEqual([
      "general",
      "security-reviewer",
    ]);
    for (const specialist of Object.values(round.specialists)) {
      expect(specialist.state).toBe("pending");
    }
  });

  it("probes under the candidate scope the reviewed context's placement declares", async () => {
    // R15: an enveloped context is identified by its owned subset, so the engine
    // has to ask for that subset — at the freeze and at every re-probe alike. A
    // whole-tree probe here would put a sibling's writes inside this context's
    // identity and its round could never hold.
    const execution = createCohortExecution({
      placement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/a", "docs/a.md"],
      },
    });

    const harness = createHarness({
      execution,
      trees: [{ ...TREE_A, identityScope: "owned" }],
    });

    await harness.run();

    const scopes = harness.probedScopes();
    expect(scopes.length).toBeGreaterThan(1);
    for (const scope of scopes) {
      expect(scope).toEqual({
        mode: "owned",
        ownedPaths: ["src/a", "docs/a.md"],
      });
    }
    expect(
      harness.repository.read().contextStates["context-plan"]?.validationRound
        ?.candidate.identityScope,
    ).toBe("owned");
  });

  it("probes whole-tree for a full-access context", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
    });

    await harness.run();

    for (const scope of harness.probedScopes()) {
      expect(scope).toEqual({ mode: "wholeTree" });
    }
  });

  it("admits specialists only after the script phase, against the same frozen candidate", async () => {
    const execution = createCohortExecution();
    const seen: { phase: string; treeHash: string | null }[] = [];

    const harness = createHarness({
      execution,
      trees: [TREE_A],
      scriptValidatorService: {
        runScriptValidator: vi.fn(async () => {
          const round =
            harness.repository.read().contextStates["context-plan"]
              ?.validationRound;
          seen.push({
            phase: `script:${round?.phase}`,
            treeHash: round?.candidate.candidateTreeHash ?? null,
          });
          return {
            kind: "pass" as const,
            treeState: { headSha: "head-1", dirty: true },
            command: "bun run pre-merge",
          };
        }),
      },
      validateContextCompletion: async () => {
        const round =
          harness.repository.read().contextStates["context-plan"]
            ?.validationRound;
        seen.push({
          phase: `specialists:${round?.phase}`,
          treeHash: round?.candidate.candidateTreeHash ?? null,
        });
        return passingValidation();
      },
    });

    await harness.run();

    expect(seen).toEqual([
      { phase: "script:script", treeHash: "tree-a" },
      { phase: "specialists:specialists", treeHash: "tree-a" },
    ]);
  });

  it("releases the candidate on conclusion but keeps the round on record", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
    });

    await harness.run();

    const round =
      harness.repository.read().contextStates["context-plan"]?.validationRound;
    // Concluded, so nothing owns the candidate and the implementer may run —
    // but the record survives, because `seq` is what tells the NEXT round apart
    // from this one.
    expect(round?.phase).toBe("concluded");
    expect(round?.outcome).toBe("passed");
    expect(round?.seq).toBe(1);
  });

  it("numbers the next round after the one that already concluded", async () => {
    // Two full passes through the engine. Round 1 ends on a candidate move, so
    // the context returns to ready and round 2 freezes afresh — and must not
    // reuse round 1's sequence number.
    const execution = createCohortExecution();
    const harness = createHarness({
      execution,
      // Each pass freezes, then sees a different tree after the script phase.
      trees: [TREE_A, TREE_B, TREE_A, TREE_B],
    });

    await harness.run();
    expect(
      harness.repository.read().contextStates["context-plan"]?.validationRound
        ?.seq,
    ).toBe(1);

    await harness.run();

    const round =
      harness.repository.read().contextStates["context-plan"]?.validationRound;
    expect(round?.seq).toBe(2);
    expect(round?.candidate.candidateTreeHash).toBe("tree-a");
    // Both rounds are on record as distinct rounds — which is the only thing
    // that lets a result from the first be refused during the second.
    expect(
      incidentEvents(harness.repository).map(
        (entry) =>
          (entry.event as { roundSeq: number; incident: string }).roundSeq,
      ),
    ).toEqual([1, 2]);
  });
});

describe("validation round: an unprovable candidate is never reviewed", () => {
  it("halts instead of opening a round when the candidate tree cannot be read", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_UNAVAILABLE],
      validateContextCompletion,
    });

    await harness.run();

    // No cohort may review a tree the engine cannot identify: without the
    // identity there is nothing to hold still, so "the same candidate" is not a
    // claim this round could make.
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(validationResultEvents(harness.repository)).toHaveLength(0);

    const persisted = harness.repository.read();
    expect(persisted.status).toBe("halted");
    expect(persisted.haltReason).toMatchObject({
      type: "validation_candidate_unavailable",
      contextId: "context-plan",
    });
    expect(
      persisted.contextStates["context-plan"]?.validationRound ?? null,
    ).toBeNull();
    // Terminal, not a spin: a retry-forever incident would loop against the
    // same broken git for as long as the workflow ran.
    expect(harness.probeCount()).toBeGreaterThan(1);
  });

  it("opens the round when a transient read failure resolves on retry", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_UNAVAILABLE, TREE_A],
    });

    await harness.run();

    const persisted = harness.repository.read();
    expect(persisted.status).not.toBe("halted");
    expect(
      persisted.contextStates["context-plan"]?.validationRound?.candidate
        .candidateTreeHash,
    ).toBe("tree-a");
  });

  it("concludes as an incident when the tree stops being readable mid-round", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      // Frozen against tree-a; the post-script probe cannot read git at all.
      trees: [TREE_A, TREE_UNAVAILABLE],
      validateContextCompletion,
    });

    await harness.run();

    expect(validateContextCompletion).not.toHaveBeenCalled();
    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.event).toMatchObject({
      incident: "candidate_mismatch",
      stage: "post_script",
      roundSeq: 1,
    });
    expect(validationResultEvents(harness.repository)).toHaveLength(0);
    expect(
      harness.repository.read().contextStates["context-plan"]?.status,
    ).toBe("ready");
  });
});

describe("validation round: the frozen roster governs dispatch", () => {
  it("hands the validation service the roster it froze, not the live definition", async () => {
    const seenRosters: string[][] = [];
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      validateContextCompletion: async (input) => {
        const round = (input as { round?: { assignments: { id: string }[] } })
          .round;
        seenRosters.push((round?.assignments ?? []).map((entry) => entry.id));
        return passingValidation();
      },
    });

    await harness.run();

    expect(seenRosters).toEqual([["general", "security-reviewer"]]);
  });

  it("names the tree the shared inputs came from when the render diverged", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      validateContextCompletion: async () => ({
        kind: "candidate_mismatch" as const,
        stage: "diff_render" as const,
        assignmentId: null,
        observedTreeHash: "tree-rendered-from",
      }),
    });

    await harness.run();

    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!.event as {
      stage: string;
      driftedComponents: string;
    };
    expect(incident.stage).toBe("diff_render");
    // A re-probe of the worktree would show the frozen tree unchanged and
    // report NOTHING drifted; the divergence only exists in what was rendered.
    expect(incident.driftedComponents).toContain("tree-rendered-from");
  });

  it("refuses to run a cohort the definition changed after the freeze", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      scriptValidatorService: {
        // A live config edit lands while the script validator is running: the
        // round froze a two-seat roster, the definition now declares one.
        runScriptValidator: vi.fn(async () => {
          await harness.repository
            .mutateActive("/repo", "session-1", (latest) => {
              const next = structuredClone(latest);
              next.workingDefinition.executionContexts =
                next.workingDefinition.executionContexts.map((context) =>
                  context.id === "context-plan"
                    ? {
                        ...context,
                        contextValidator: {
                          enabled: true,
                          assignments: [
                            makeSeededValidatorAssignment({ id: "general" }),
                          ],
                        },
                      }
                    : context,
                );
              return changed(next);
            })
            .then((mutation) => mutation.execution);
          return {
            kind: "pass" as const,
            treeState: { headSha: "head-1", dirty: true },
            command: "bun run pre-merge",
          };
        }),
      },
      validateContextCompletion,
    });

    await harness.run();

    // Running the one remaining reviewer would be running a cohort other than
    // the one recorded as owning this candidate. The edit is legal — it belongs
    // to the NEXT round, which will freeze it.
    expect(validateContextCompletion).not.toHaveBeenCalled();
    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.event).toMatchObject({
      incident: "roster_drift",
      roundSeq: 1,
      stage: "post_script",
    });
    expect(validationResultEvents(harness.repository)).toHaveLength(0);

    const contextState =
      harness.repository.read().contextStates["context-plan"];
    expect(contextState?.status).toBe("ready");
    expect(contextState?.consecutiveFailureCount).toBe(1);
    expect(contextState?.validationRound?.outcome).toBe("roster_drift");
  });

  it("refuses a seat repointed at a different profile with identical text", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      scriptValidatorService: {
        // The substitution a hash comparison alone cannot see: same seat id,
        // same revision, byte-identical rendered instructions — a different
        // profile. Running it would leave the persisted roster naming a
        // reviewer that never reviewed this candidate.
        runScriptValidator: vi.fn(async () => {
          await harness.repository
            .mutateActive("/repo", "session-1", (latest) => {
              const next = structuredClone(latest);
              next.workingDefinition.executionContexts =
                next.workingDefinition.executionContexts.map((context) => {
                  if (context.id !== "context-plan") return context;
                  return {
                    ...context,
                    contextValidator: {
                      enabled: true,
                      assignments: context.contextValidator.assignments.map(
                        (assignment) =>
                          assignment.id === "security-reviewer"
                            ? {
                                ...assignment,
                                profile: {
                                  tier: "project" as const,
                                  id: "impostor-reviewer",
                                },
                              }
                            : assignment,
                      ),
                    },
                  };
                });
              return changed(next);
            })
            .then((mutation) => mutation.execution);
          return {
            kind: "pass" as const,
            treeState: { headSha: "head-1", dirty: true },
            command: "bun run pre-merge",
          };
        }),
      },
      validateContextCompletion,
    });

    await harness.run();

    expect(validateContextCompletion).not.toHaveBeenCalled();
    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.event).toMatchObject({
      incident: "roster_drift",
      roundSeq: 1,
    });
    expect(
      harness.repository.read().contextStates["context-plan"]?.validationRound
        ?.outcome,
    ).toBe("roster_drift");
  });
});

describe("validation round: implementer exclusion", () => {
  it("refuses to seed the implementer while a round owns the candidate", async () => {
    // A context with work still to do whose round was left open (the engine
    // clears it on every conclusion, so this is the crash-shaped case the
    // structural guard exists for). Seeding here would let the implementer
    // rewrite the exact tree a cohort is reviewing.
    const execution = createCohortExecution();
    execution.taskStates["task-plan-1"] = {
      ...execution.taskStates["task-plan-1"]!,
      status: "pending",
      summary: null,
      completedAt: null,
    };
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      completedTaskCount: 0,
      validationRound: {
        seq: 3,
        candidate: {
          identityScope: "wholeTree",
          headSha: "head-1",
          candidateTreeHash: "tree-a",
          taskStateHash: "tasks-1",
        },
        roster: [],
        specialists: {},
        phase: "specialists",
        outcome: null,
        startedAt: NOW,
      },
    };

    const harness = createHarness({ execution, trees: [TREE_A] });

    await expect(harness.run()).rejects.toThrow(/validation round/i);
    // The refusal is structural: no iteration was consumed and the round is
    // still there for an operator to see.
    const contextState =
      harness.repository.read().contextStates["context-plan"];
    expect(contextState?.iterationCount).toBe(2);
    expect(contextState?.validationRound?.seq).toBe(3);
  });
});

describe("validation round: script-first short-circuit", () => {
  it("launches zero specialists when the deterministic script validator fails", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      scriptValidatorService: {
        runScriptValidator: vi.fn(async () => ({
          kind: "fail" as const,
          summary: "typecheck failed",
          logFilePath: "/wt/.cc/workflow/execution-1/pre-merge.log",
          logRelativePath: ".cc/workflow/execution-1/pre-merge.log",
          timedOut: false,
          treeState: { headSha: "head-1", dirty: true },
          command: "bun run pre-merge",
        })),
      },
      validateContextCompletion,
    });

    await harness.run();

    expect(validateContextCompletion).not.toHaveBeenCalled();
    // The round is closed on the script failure, and the existing script
    // remediation accounting is untouched by the round machinery.
    const contextState =
      harness.repository.read().contextStates["context-plan"];
    expect(contextState?.validationRound?.phase).toBe("concluded");
    expect(contextState?.validationRound?.outcome).toBe("script_failed");
    expect(contextState?.consecutiveFailureCount).toBe(2);
  });

  it("closes the round as script_failed even when that failure trips the breaker", async () => {
    // The last permitted script failure both closes the round and halts the
    // execution. The halt must not cost the round its outcome: an operator
    // reading the halted execution has to see WHY the last round ended, and
    // "script_failed" is the reason the breaker tripped.
    const execution = createCohortExecution();
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      consecutiveFailureCount: 2,
      consecutiveCandidateMismatchCount: 0,
    };
    const harness = createHarness({
      execution,
      trees: [TREE_A],
      scriptValidatorService: {
        runScriptValidator: vi.fn(async () => ({
          kind: "fail" as const,
          summary: "typecheck failed",
          logFilePath: "/wt/.cc/workflow/execution-1/pre-merge.log",
          logRelativePath: ".cc/workflow/execution-1/pre-merge.log",
          timedOut: false,
          treeState: { headSha: "head-1", dirty: true },
          command: "bun run pre-merge",
        })),
      },
    });

    await harness.run();

    const halted = harness.repository.read();
    expect(halted.status).toBe("halted");
    expect(halted.haltReason).toMatchObject({ type: "circuit_breaker" });

    const contextState = halted.contextStates["context-plan"];
    expect(contextState?.validationRound?.phase).toBe("concluded");
    expect(contextState?.validationRound?.outcome).toBe("script_failed");
    // The breaker's own accounting is unchanged by the round machinery.
    expect(contextState?.consecutiveFailureCount).toBe(3);
  });
});

describe("validation round: candidate identity re-verification", () => {
  it("concludes a post-script candidate move as an infrastructure outcome, not a verdict", async () => {
    const validateContextCompletion = vi.fn(async () => passingValidation());
    const harness = createHarness({
      execution: createCohortExecution(),
      // Frozen against tree-a; the post-script probe sees tree-b.
      trees: [TREE_A, TREE_B],
      validateContextCompletion,
    });

    await harness.run();

    // No specialist may judge a candidate that is no longer the frozen one.
    expect(validateContextCompletion).not.toHaveBeenCalled();

    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!.event;
    expect(incident).toMatchObject({
      type: "graph-workflow-validation-incident",
      contextId: "context-plan",
      incident: "candidate_mismatch",
      roundSeq: 1,
      stage: "post_script",
      assignmentId: null,
      driftedComponents: "candidateTreeHash",
    });

    // Not a verdict: nothing recorded as a validation result, nothing charged.
    expect(validationResultEvents(harness.repository)).toHaveLength(0);
    const contextState =
      harness.repository.read().contextStates["context-plan"];
    expect(contextState?.consecutiveFailureCount).toBe(1);
    expect(contextState?.validationRound?.phase).toBe("concluded");
    expect(contextState?.validationRound?.outcome).toBe("candidate_mismatch");
    // The context returns to ready so the next pass freezes a fresh candidate.
    expect(contextState?.status).toBe("ready");
  });

  it("records nothing for a specialist result the cohort rejected as stale", async () => {
    // `candidate_mismatch` is what the validation service reports when its own
    // re-verification refused a result (proved against the real service in
    // execution-validation.test.ts). Here the engine's handling of it is the
    // subject: an incident, and no trace of the discarded verdict.
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
      validateContextCompletion: async () => ({
        kind: "candidate_mismatch" as const,
        stage: "specialist_result" as const,
        assignmentId: "security-reviewer",
      }),
    });

    await harness.run();

    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.event).toMatchObject({
      incident: "candidate_mismatch",
      stage: "specialist_result",
      assignmentId: "security-reviewer",
      roundSeq: 1,
    });

    // Never recorded: no verdict event, no reopened task, no charge.
    expect(validationResultEvents(harness.repository)).toHaveLength(0);
    const persisted = harness.repository.read();
    expect(persisted.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(
      persisted.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
    expect(
      persisted.contextStates["context-plan"]?.validationRound?.phase,
    ).toBe("concluded");
    expect(persisted.contextStates["context-plan"]?.status).toBe("ready");
  });

  it("refuses to publish an aggregate for a candidate that moved after the verdict", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      // Round start and the post-script check agree; the tree moves between the
      // specialist's verdict and the write that would make it durable.
      trees: [TREE_A, TREE_A, TREE_B],
      validateContextCompletion: async () => ({
        kind: "fail" as const,
        summary: "Missing rollback notes.",
        feedback: "Context validation blocked completion.",
        issues: [
          {
            assignmentId: "general",
            taskId: "task-plan-1",
            title: "Missing rollback notes",
            description: "Add rollback guidance.",
          },
        ],
        reopenTaskIds: ["task-plan-1"],
      }),
    });

    await harness.run();

    const incidents = incidentEvents(harness.repository);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.event).toMatchObject({
      incident: "candidate_mismatch",
      stage: "aggregate",
      roundSeq: 1,
    });

    // The rejection never became durable: no verdict event, no reopened task,
    // no consecutive-failure charge for a review nobody can attribute.
    expect(validationResultEvents(harness.repository)).toHaveLength(0);
    const persisted = harness.repository.read();
    expect(persisted.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(
      persisted.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
    expect(
      persisted.contextStates["context-plan"]?.validationRound?.phase,
    ).toBe("concluded");
  });

  it("records a verdict normally when the candidate held for the whole round", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      trees: [TREE_A],
    });

    await harness.run();

    expect(incidentEvents(harness.repository)).toHaveLength(0);
    const results = validationResultEvents(harness.repository);
    expect(results).toHaveLength(1);
    expect(results[0]!.event).toMatchObject({ pass: true });
    expect(
      harness.repository.read().contextStates["context-plan"]
        ?.consecutiveFailureCount,
    ).toBe(0);
  });
});
