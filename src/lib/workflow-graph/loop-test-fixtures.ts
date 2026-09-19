/**
 * Shared scaffolding for the D4 loop suites (R9/R16).
 *
 * One worker+judge graph, one two-loop graph, and one `runPass` that drives a
 * scheduling pass exactly as the execution loop does — routes settle, loops
 * settle, decided unrolls stage and install. Every loop test reads the same
 * production path from here, so a change to the pass order or the staging seam
 * cannot be papered over by a suite that models it differently.
 */

import type { GlobalConfig } from "@/lib/config/schemas";
import type {
  CascadeWorkflowSemanticDefinition,
  GraphWorkflowCascadeContext,
  GraphWorkflowContextEdge,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowLoopGroup,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
  type GraphWorkflowLandingIntent,
} from "@/lib/workflow-graph/schemas";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "@/lib/workflow-graph/execution-state";
import {
  finalizeLoopPassMaterialization,
  prepareLoopPassMaterialization,
  settleLoops,
  type LoopMaterializationRequest,
} from "@/lib/workflow-graph/loop-settlement";
import { loopInstanceId } from "@/lib/workflow-graph/loop-resolver";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import {
  settleRoutes,
  type LandingBranchEvidence,
} from "@/lib/workflow-graph/route-runtime";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  makeSeededImplementerAssignment,
  makeSeededValidatorCohort,
  seedAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import type {
  LiveEditDeps,
  ResolvedContextConfig,
} from "@/lib/workflow-graph/runtime-edits";

export const NOW = "2026-08-04T00:00:00.000Z";

export const RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: makeSeededImplementerAssignment({
    backend: "claude",
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "medium" },
    },
  }),
  contextValidator: makeSeededValidatorCohort({
    enabled: false,
    assignments: [],
  }),
  scriptValidator: { commands: [] },
  scriptValidatorSource: "global",
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20 },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: true, source: "global" },
    secondAgent: {
      value: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  },
  agentValidation: {
    implementer: {
      value: { mode: "all", except: [] },
      source: "global",
      commands: [],
    },
    contextValidator: {
      value: { mode: "only", commands: [] },
      source: "global",
      commands: [],
    },
  },
  memory: {
    implementer: {
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    },
    validator: {
      read: { value: "off", source: "global" },
      contribute: { value: "off", source: "global" },
    },
  },
};

export function makeLiveEditDeps(): LiveEditDeps {
  let counter = 0;
  return {
    createTaskId: () => `task-minted-${(counter += 1)}`,
    resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
    validationCommandPreflight: () => ({
      commandCosts: {},
      concurrencyLimit: 8,
    }),
    snapshotFor: (assignment) =>
      makeProfileSnapshot({
        tier: assignment.profile.tier,
        id: assignment.profile.id,
      }),
    now: () => NOW,
  };
}

/** The judge (exit) verdict the `until` predicate reads. */
export const JUDGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    notes: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
};

export const UNTIL_PASS: GraphWorkflowLoopGroup["until"] = {
  schema: {
    type: "object",
    properties: { verdict: { const: "pass" } },
    required: ["verdict"],
  },
};

export function context(
  id: string,
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id,
    title: id,
    acceptanceCriteria: `${id} is done`,
    placement: { lane: id, mode: "full" },
    ...overrides,
  };
}

export function task(
  id: string,
  contextId: string,
): GraphWorkflowTaskDefinition {
  return {
    id,
    contextId,
    order: 1,
    title: id,
    instructions: `Do ${id}`,
    source: "user",
  };
}

export function edge(
  id: string,
  sourceContextId: string,
  targetContextId: string,
  when?: GraphWorkflowContextEdge["when"],
): GraphWorkflowContextEdge {
  return {
    id,
    sourceContextId,
    targetContextId,
    ...(when !== undefined ? { when } : {}),
  };
}

function seedContextAssignments(
  context: GraphWorkflowCascadeContext,
): GraphWorkflowResolvedContext {
  return {
    ...context,
    implementer: seedAssignment(context.implementer),
    contextValidator: {
      ...context.contextValidator,
      assignments: context.contextValidator.assignments.map((assignment) =>
        seedAssignment(assignment),
      ),
    },
  };
}

function seedResolvedDefinition(
  definition: CascadeWorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  const { loopGroups, ...definitionWithoutLoops } = definition;
  return {
    ...definitionWithoutLoops,
    executionContexts: definition.executionContexts.map(seedContextAssignments),
    ...(loopGroups === undefined
      ? {}
      : {
          loopGroups: loopGroups.map((group) => ({
            ...group,
            template: {
              ...group.template,
              contexts: group.template.contexts.map(seedContextAssignments),
            },
          })),
        }),
  };
}

function resolveTestDefinition(
  authored: WorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  return seedResolvedDefinition(
    resolveWorkflowDefinition({} as GlobalConfig, authored),
  );
}

/**
 * seed → [worker → judge] → publish. The judge is the loop exit and declares
 * the schema the `until` predicate reads — the worker+judge shape R9 names as
 * the first-slice body.
 */
export function workerJudgeDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
  loopOverrides: Partial<GraphWorkflowLoopGroup> = {},
): ResolvedWorkflowSemanticDefinition {
  const authored = createWorkflowDefinition({
    executionContexts: [
      context("seed", { outputSchema: undefined }),
      context("worker"),
      context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      context("publish"),
    ],
    tasks: [
      task("task-seed", "seed"),
      task("task-worker", "worker"),
      task("task-judge", "judge"),
      task("task-publish", "publish"),
    ],
    edges: [
      edge("seed__worker", "seed", "worker"),
      edge("worker__judge", "worker", "judge"),
      edge("judge__publish", "judge", "publish"),
    ],
    loopGroups: [
      {
        id: "refine",
        bodyContextIds: ["worker", "judge"],
        entryContextId: "worker",
        exitContextId: "judge",
        until: UNTIL_PASS,
        maxPasses: 3,
        ...loopOverrides,
      },
    ],
    ...overrides,
  });
  return resolveTestDefinition(authored);
}

/**
 * Two independent loops whose activation paths resolve at different times:
 * `alpha` is reachable from the seed, `beta` only once `gate` completes. That
 * gap is what lets one scheduling pass carry an earlier loop's materialization
 * and a later loop's activation together, which is where slot arbitration has
 * to hold definition order.
 */
export function twoLoopDefinition(): ResolvedWorkflowSemanticDefinition {
  const authored = createWorkflowDefinition({
    executionContexts: [
      context("seed"),
      context("a_worker"),
      context("a_judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      context("gate"),
      context("b_worker"),
      context("b_judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
    ],
    tasks: [
      task("task-seed", "seed"),
      task("task-a-worker", "a_worker"),
      task("task-a-judge", "a_judge"),
      task("task-gate", "gate"),
      task("task-b-worker", "b_worker"),
      task("task-b-judge", "b_judge"),
    ],
    edges: [
      edge("seed__a_worker", "seed", "a_worker"),
      edge("a_worker__a_judge", "a_worker", "a_judge"),
      edge("seed__gate", "seed", "gate"),
      edge("gate__b_worker", "gate", "b_worker"),
      edge("b_worker__b_judge", "b_worker", "b_judge"),
    ],
    loopGroups: [
      {
        id: "alpha",
        bodyContextIds: ["a_worker", "a_judge"],
        entryContextId: "a_worker",
        exitContextId: "a_judge",
        until: UNTIL_PASS,
        maxPasses: 3,
      },
      {
        id: "beta",
        bodyContextIds: ["b_worker", "b_judge"],
        entryContextId: "b_worker",
        exitContextId: "b_judge",
        until: UNTIL_PASS,
        maxPasses: 3,
      },
    ],
  });
  return resolveTestDefinition(authored);
}

/**
 * Two independent SINGLE-CONTEXT loop bodies (entry === exit), so a test can
 * drive many passes cheaply. The execution-wide pass backstop is the only D4
 * budget that needs tens of passes to reach, and a two-context body would double
 * both the clone cost and the per-pass driving for no extra coverage.
 *
 * `alpha` is declared first, which is the arbitration order the ledger records
 * when both loops want a slot in the same scheduling pass.
 */
export function tightTwoLoopDefinition(
  maxPasses = 25,
): ResolvedWorkflowSemanticDefinition {
  const authored = createWorkflowDefinition({
    executionContexts: [
      context("seed"),
      context("a_step", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      context("b_step", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
    ],
    tasks: [
      task("task-seed", "seed"),
      task("task-a", "a_step"),
      task("task-b", "b_step"),
    ],
    edges: [
      edge("seed__a_step", "seed", "a_step"),
      edge("seed__b_step", "seed", "b_step"),
    ],
    loopGroups: [
      {
        id: "alpha",
        bodyContextIds: ["a_step"],
        entryContextId: "a_step",
        exitContextId: "a_step",
        until: UNTIL_PASS,
        maxPasses,
      },
      {
        id: "beta",
        bodyContextIds: ["b_step"],
        entryContextId: "b_step",
        exitContextId: "b_step",
        until: UNTIL_PASS,
        maxPasses,
      },
    ],
  });
  return resolveTestDefinition(authored);
}

export function executionFor(
  definition: ResolvedWorkflowSemanticDefinition,
): GraphWorkflowExecution {
  // Built through the production state builders, so the runtime maps satisfy
  // the same consistency invariant a launched execution does.
  return createWorkflowExecution({
    workingDefinition: definition,
    status: "running",
    contextStates: buildInitialContextStates(definition),
    taskStates: buildInitialTaskStates(definition),
  });
}

/**
 * How a completed context's landing intent should read.
 *
 * `landed` is the ordinary case — settlement is POST-LAND, so a test that only
 * wants a settled upstream asks for it. `pending` is the crash window decision
 * D8 exists for: the work completed, and the mutation that would have settled
 * its intent never ran.
 */
export interface CompleteContextLanding {
  mode?: GraphWorkflowLandingIntent["mode"];
  state?: GraphWorkflowLandingIntent["state"];
  laneId?: string | null;
  worktreePath?: string | null;
  baselineSha?: string | null;
  joinId?: string | null;
}

/**
 * Complete a context the way the engine does — status, and (when it declares an
 * output schema) the banked capture the settlement transaction evaluates. The
 * landing intent is settled `landed` by default because loop settlement is
 * POST-LAND.
 */
export function completeContext(
  execution: GraphWorkflowExecution,
  contextId: string,
  output?: Record<string, unknown>,
  landing: CompleteContextLanding = {},
): void {
  const state = execution.contextStates[contextId];
  if (!state) throw new Error(`no context state for "${contextId}"`);
  for (const task of execution.workingDefinition.tasks) {
    if (task.contextId !== contextId) continue;
    const taskState = execution.taskStates[task.id];
    if (taskState) taskState.status = "completed";
  }
  // Through the production transition owner, so a fixture can never fabricate a
  // status move the engine would refuse; a pending context is dispatched first,
  // exactly as the scheduler does.
  if (state.status === "pending") {
    transitionContextStatus(execution, contextId, "running", {
      reason: "test.dispatch",
    });
  }
  transitionContextStatus(execution, contextId, "completed", {
    reason: "test.complete",
  });
  state.completedTaskCount = state.totalTaskCount;
  const landingState = landing.state ?? "landed";
  if (landing.laneId !== undefined) state.laneId = landing.laneId;
  if (landing.joinId !== undefined) state.joinId = landing.joinId;
  state.landingIntent = {
    mode: landing.mode ?? "solo_commit",
    attempt: 1,
    token: `cc-landing:${execution.id}:${contextId}:1`,
    laneId: landing.laneId ?? null,
    worktreePath: landing.worktreePath ?? null,
    baselineSha: landing.baselineSha ?? null,
    headSha: null,
    joinId: landing.joinId ?? null,
    state: landingState,
    evidence: landingState === "landed" ? "commit" : null,
    recordedAt: NOW,
    settledAt: landingState === "landed" ? NOW : null,
  };
  if (output !== undefined) {
    execution.contextOutputs[contextId] = {
      value: output,
      iteration: (execution.contextOutputs[contextId]?.iteration ?? 0) + 1,
      capturedAt: NOW,
      parse: { source: "native" },
    };
  }
}

export interface RunPassOptions {
  now?: string;
  branchEvidence?: ReadonlyMap<string, LandingBranchEvidence>;
}

/**
 * One scheduling pass settles routes and loops to a fixpoint. Materializations
 * are staged outside the "lock" and installed before dependent routes settle.
 */
export function runPass(
  execution: GraphWorkflowExecution,
  options: RunPassOptions = {},
): {
  execution: GraphWorkflowExecution;
  materialized: LoopMaterializationRequest[];
  halt: ReturnType<typeof settleLoops>["halt"];
} {
  const now = options.now ?? NOW;
  settleRoutes(execution, { now, branchEvidence: options.branchEvidence });
  const outcome = settleLoops(execution, { now });
  const materialized: LoopMaterializationRequest[] = [];
  let current = execution;
  for (const request of outcome.materializations) {
    const prepared = prepareLoopPassMaterialization(
      current,
      request,
      makeLiveEditDeps(),
    );
    if (!prepared.ok) {
      throw new Error(
        `materialization refused: ${prepared.issues
          .map(
            (issue: { code: string; message: string }) =>
              `${issue.code}: ${issue.message}`,
          )
          .join(", ")}`,
      );
    }
    const installed = finalizeLoopPassMaterialization(
      current,
      prepared.prepared,
      request,
      { now },
    );
    if (!installed.ok) {
      throw new Error(`materialization did not install: ${installed.outcome}`);
    }
    // The repository re-parses whatever a reducer returns, which is what turns
    // the deeply frozen spliced install back into working state — and proves the
    // unrolled execution still satisfies its own schema.
    current = graphWorkflowExecutionSchema.parse(installed.execution);
    materialized.push(request);
  }
  if (outcome.halt)
    return { execution: current, materialized, halt: outcome.halt };
  if (
    outcome.activatedLoopGroupIds.length > 0 ||
    outcome.skippedLoopGroupIds.length > 0 ||
    outcome.concludedLoopGroupIds.length > 0 ||
    materialized.length > 0
  ) {
    const next = runPass(current, options);
    return { ...next, materialized: [...materialized, ...next.materialized] };
  }
  return { execution: current, materialized, halt: null };
}

export const P1_WORKER = loopInstanceId("refine", 1, "worker");
export const P1_JUDGE = loopInstanceId("refine", 1, "judge");
export const P2_WORKER = loopInstanceId("refine", 2, "worker");
export const P2_JUDGE = loopInstanceId("refine", 2, "judge");
export const P3_WORKER = loopInstanceId("refine", 3, "worker");
export const P3_JUDGE = loopInstanceId("refine", 3, "judge");
/** The pass-K instance of a `tightTwoLoopDefinition` body. */
export function tightInstanceId(
  loopGroupId: "alpha" | "beta",
  pass: number,
): string {
  return loopInstanceId(
    loopGroupId,
    pass,
    loopGroupId === "alpha" ? "a_step" : "b_step",
  );
}

export const ALPHA_P1_WORKER = loopInstanceId("alpha", 1, "a_worker");
export const ALPHA_P1_JUDGE = loopInstanceId("alpha", 1, "a_judge");
export const ALPHA_P2_WORKER = loopInstanceId("alpha", 2, "a_worker");
export const ALPHA_P2_JUDGE = loopInstanceId("alpha", 2, "a_judge");
export const BETA_P1_WORKER = loopInstanceId("beta", 1, "b_worker");
export const BETA_P1_JUDGE = loopInstanceId("beta", 1, "b_judge");
