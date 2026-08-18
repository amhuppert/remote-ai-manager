import type {
  GraphWorkflowContextSkipReason,
  GraphWorkflowExecution,
  GraphWorkflowLoopState,
} from "@/lib/workflow-graph/schemas";
import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import type {
  ResolvedRouteEdge,
  RouteEdgeResolution,
} from "@/lib/workflow-graph/route-projection";
import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import {
  resolveLoopPassMembership,
  type LoopPassMembership,
} from "@/lib/workflow-graph/loop-ledger";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowCommandSelector,
  GraphWorkflowLaneMergeValidationConfig,
  SeededAgentAssignment,
  SeededValidatorCohort,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowResolvedContext,
  GraphWorkflowStatus,
  GraphWorkflowTaskStatus,
} from "@/lib/workflow-graph/definition-schemas";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  type ContextLifecycle,
  type ExecutionEditability,
} from "./lifecycle-classifier";
import type { CharterAmendment } from "@/lib/workflows/charter-schemas";
import type { AgentCallStructuredOutputParse } from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  getContextOutput,
  summarizeOutputSchemaShape,
  type GraphWorkflowOutputSchemaShape,
} from "./context-outputs";
import { computeCharterHash, renderCharterMarkdown } from "./charter/render";

/**
 * The server-side live-outline projection (doc 06, "Read API — live outline").
 * Deliberately server-side (D10): editability is derived from the SAME lifecycle
 * classifier the edit guard uses, so the CLI, the UI, and the guard cannot drift.
 * The projection folds `workingDefinition` (resolved config) + `contextStates` /
 * `taskStates` + the classifier verdicts into a compact JSON the CLI renders as
 * text. Prose is SIZED, never inlined, in the default outline; the section
 * selectors (`context` / `task` / `config` / `full`) return the full prose the
 * caller asked for — the same token discipline as doc 05.
 *
 * Pure and table-testable: no I/O, no state-store access.
 */

/** The three editability tiers a context row can carry (doc 06 outline column). */
export type LiveOutlineEditability = "frozen" | "editable" | "pause-to-edit";

export interface LiveOutlineHeader {
  executionId: string;
  liveRevision: number;
  status: GraphWorkflowStatus;
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  /**
   * Whether the execution accepts live edits at all. A terminal/non-resumable
   * execution surfaces its read-only-ness HERE (doc 06: "not-editable … shown in
   * the header line instead"), so the per-context `editability` tier stays one of
   * the three lifecycle-derived values and the header is the authoritative gate.
   */
  editable: boolean;
  notEditableReason?: Extract<
    ExecutionEditability,
    { kind: "not-editable" }
  >["reason"];
  /** Accepted live charter amendments so far (doc 07); 0 for pre-field rows. */
  charterAmendmentCount: number;
  /** Plan-repair rounds run so far (docs/design/cc-cli/08); 0 for pre-D1 rows. */
  planRepairRoundCount: number;
}

export interface LiveOutlineAgentSummary {
  backend: GraphWorkflowAgentConfig["backend"];
  model: string;
  reasoningEffort: string;
}

/**
 * The provenance of a SEEDED assignment: which profile revision execution start
 * resolved, and the hash of the instruction block the lane actually replays.
 *
 * These two fields are what separates a live execution's staffing from a saved
 * definition's. A saved document names a reference the library still owns and
 * can still change; a running execution replays bytes nothing can reach. The
 * instruction text behind the hash is deliberately absent — an outline is a
 * navigation surface, and the hash is the whole point of provenance here.
 */
export interface LiveOutlineAssignmentProvenance {
  /** The assignment's stable use-site id, unique within its cohort. */
  assignmentId: string;
  /** The library profile, in the compact `tier:id` spelling. */
  profile: string;
  /** The use-site steer narrowing the profile, when one was authored. */
  focus: string | null;
  /** The profile revision resolved at execution start. */
  revision: number;
  /** Hash of the rendered instruction block the lane replays verbatim. */
  resolvedInstructionHash: string;
}

export type LiveOutlineImplementerSummary = LiveOutlineAgentSummary &
  LiveOutlineAssignmentProvenance;

export interface LiveOutlineValidatorSummary extends LiveOutlineAssignmentProvenance {
  strategy: ValidatorAssignment["strategy"];
  backend: GraphWorkflowAgentConfig["backend"];
  model: string;
  reasoningEffort: string;
}

export interface LiveOutlineCollaborationSummary {
  secondAgent: LiveOutlineAgentSummary;
  negotiationRounds: number;
  autonomousResolutionThreshold: string;
}

export interface LiveOutlineScriptValidatorSummary {
  commands: string[];
}

/** The concrete per-role command selections from the seed-time snapshot. */
export interface LiveOutlineAgentValidationSummary {
  implementer: GraphWorkflowCommandSelector;
  contextValidator: GraphWorkflowCommandSelector;
}

export interface LiveOutlineContextConfig {
  contextId: string;
  implementer: LiveOutlineImplementerSummary;
  /**
   * False when the cohort is switched off. Dormancy is a property of the
   * COHORT, not of an assignment — every assignment below is dormant when this
   * is false, and none of them is dispatched.
   */
  validatorCohortEnabled: boolean;
  /**
   * Every seeded assignment, dormant ones included. A disabled cohort retains
   * its assignments and start snapshotted them, so this is what the execution
   * actually holds — omitting them would make re-enabling one a blind edit.
   */
  validators: LiveOutlineValidatorSummary[];
  scriptValidator: LiveOutlineScriptValidatorSummary;
  humanApprovalGate: boolean;
  askUserQuestions: boolean;
  /** `null` when no resolved collaboration snapshot exists (legacy executions). */
  collaboration: LiveOutlineCollaborationSummary | null;
  /** `null` when no selector snapshot exists (pre-snapshot executions). */
  agentValidation: LiveOutlineAgentValidationSummary | null;
}

/**
 * A context's FULL resolved config — the concrete runtime values a `live edit`
 * addresses (doc 06: selector responses return full config, not the compact
 * outline summary). Every block is the exact resolved shape from
 * `workingDefinition`, so the inspector/agent can inspect and edit concrete
 * values (implementer, validator, script/approval/questions gates, iteration
 * policy, circuit breaker, mutability, collaboration). Kept in lockstep with
 * `graphWorkflowResolvedContextSchema` via `Pick` so a new resolved-config field
 * surfaces here without drift.
 */
export type LiveOutlineResolvedConfig = Pick<
  GraphWorkflowResolvedContext,
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "iterationPolicy"
  | "circuitBreaker"
  | "mutability"
  | "planRepair"
  | "agentValidation"
  // Context identity rather than a cascade result, but it belongs to the same
  // read-back: an agent about to edit a context needs its declared output
  // contract, and the edit tiers address it here. Optional — absent on contexts
  // that declare none.
  | "outputSchema"
> & {
  contextId: string;
  /** `null` when no resolved collaboration snapshot exists (legacy executions). */
  collaboration: ResolvedCollaborationConfig | null;
};

/**
 * The SHAPE of a declared `outputSchema`, never its body (R7.2). The outline
 * sizes prose rather than inlining it, and a declaration is prose: the row says
 * a contract exists and how wide it is, and `--config <ctx>` returns the
 * document itself.
 */
export type LiveOutlineOutputSchemaSummary = GraphWorkflowOutputSchemaShape;

/**
 * One edge as the route projection resolved it (D4 R13.2).
 *
 * `source` is the AUTHORED (logical) source — the topology an operator reads —
 * and `effectiveSource` is the instance whose landed work actually satisfies
 * the edge (decision D1). They differ exactly when a concluded loop's external
 * edge resolves onto its concluding pass's exit instance, which is how the
 * outline renders a logical exit with its effective instance as provenance.
 * `null` while the edge is unresolved.
 */
export interface LiveOutlineRoute {
  id: string;
  source: string;
  effectiveSource: string | null;
  target: string;
  guard: ResolvedRouteEdge["guard"];
  resolution: RouteEdgeResolution["kind"];
}

/** One declared loop's activation, pass counter and budget (R13.2). */
export interface LiveOutlineLoop {
  loopGroupId: string;
  activation: GraphWorkflowLoopState["activation"];
  passCount: number;
  maxPasses: number;
  loopControlRevision: number;
  /** The AUTHORED exit whose external edges the loop holds. */
  logicalExitContextId: string;
  /** The concluding pass's exit instance; null until the loop concludes. */
  concludingExitContextId: string | null;
}

/** The expansion audit ledgers, flattened for the CLI (R8/R13.2). */
export interface LiveOutlineExpansions {
  accepted: Array<{
    requestId: string;
    invokerContextId: string;
    rationale: string;
    addedContextIds: string[];
    addedTaskIds: string[];
    rejoinContextIds: string[];
    payloadHash: string;
    acceptedAt: string;
  }>;
  refusals: Array<{
    requestId: string;
    invokerContextId: string;
    refusalCode: string;
    refusedAt: string;
  }>;
}

export interface LiveOutlineContext {
  id: string;
  title: string;
  status: GraphWorkflowContextStatus;
  editability: LiveOutlineEditability;
  /** Upstream context ids (edges whose target is this context), in edge order. */
  deps: string[];
  completedTaskCount: number;
  totalTaskCount: number;
  iterationCount: number;
  maxIterations: number;
  /** `null` when the context declares no output contract (free-form). */
  outputSchema: LiveOutlineOutputSchemaSummary | null;
  /**
   * The recorded route verdicts of a `skipped` context (D4 R4); `null` on every
   * other status. The COMPLETE verdict set, exactly as persisted — a skip an
   * operator cannot reconstruct is not an auditable decision.
   */
  skip: GraphWorkflowContextSkipReason | null;
  /** Loop pass membership; `null` for a context outside every loop body. */
  loop: LoopPassMembership | null;
  /** The expansion that created this context; `null` when the planner did. */
  provenance: { requestId: string; invokerContextId: string } | null;
}

/**
 * One context's output contract and what it has produced (R7.2 CLI read path).
 *
 * `capture` mirrors the states {@link getContextOutput} can report for a
 * context that participates at all; contexts it reports `none` for never appear
 * here, so "absent" unambiguously means "declares nothing and banked nothing".
 * `skipped` is listed rather than dropped — its declared contract is still part
 * of the graph an operator is reading — but never as `pending`, because a
 * not-taken branch owes nothing (D4 R4).
 */
export interface LiveOutlineContextOutput {
  contextId: string;
  title: string;
  status: GraphWorkflowContextStatus;
  /** `null` when a live edit cleared the declaration after a capture. */
  schema: LiveOutlineOutputSchemaSummary | null;
  capture:
    | {
        kind: "captured";
        value: Record<string, unknown>;
        capturedAt: string;
        iteration: number;
        parse: AgentCallStructuredOutputParse;
      }
    | { kind: "pending" }
    | { kind: "skipped" };
}

export interface LiveOutlineTask {
  contextId: string;
  order: number;
  id: string;
  status: GraphWorkflowTaskStatus;
  title: string;
  instructionChars: number;
}

export interface LiveOutlineTaskFull {
  contextId: string;
  order: number;
  id: string;
  status: GraphWorkflowTaskStatus;
  title: string;
  instructions: string;
  metadata?: Record<string, string>;
}

export interface LiveOutlineContextSection {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string;
  status: GraphWorkflowContextStatus;
  editability: LiveOutlineEditability;
  deps: string[];
  completedTaskCount: number;
  totalTaskCount: number;
  iterationCount: number;
  maxIterations: number;
  config: LiveOutlineResolvedConfig;
  tasks: LiveOutlineTaskFull[];
}

export interface LiveOutline {
  header: LiveOutlineHeader;
  contexts: LiveOutlineContext[];
  tasks: LiveOutlineTask[];
  config: LiveOutlineContextConfig[];
  /**
   * The workflow-scope lane-merge validation selection, straight from the
   * seed-time `workingDefinition` snapshot (workflow tier only — the gate
   * guards the shared fan-in target, so no per-context copy exists). `null`
   * for executions seeded before the snapshot existed.
   */
  laneMergeValidation: GraphWorkflowLaneMergeValidationConfig | null;
  /**
   * Every edge with its guard and resolved verdict (R13.2). Always present and
   * always complete: guard-free routes report `guard: "none"`, so a reader
   * never has to infer "unguarded" from an absent row. The CLI text view
   * renders the block only when there is something conditional to say, which is
   * what keeps a pre-D4 outline's rendering unchanged.
   */
  routes: LiveOutlineRoute[];
  /** Declared loops with their activation, pass counter and budget; `[]` if none. */
  loops: LiveOutlineLoop[];
  /** The expansion audit ledgers; both empty for an execution that never expanded. */
  expansions: LiveOutlineExpansions;
}

export type LiveOutlineSelector =
  | { kind: "outline" }
  | { kind: "full" }
  | { kind: "context"; contextId: string }
  | { kind: "task"; taskId: string }
  | { kind: "config"; contextId: string }
  | { kind: "charter" }
  | { kind: "outputs" };

/**
 * The charter selector's payload (doc 07): the full rendered document (content +
 * amendment log — the same markdown the worktree charter.md carries) plus the
 * structured amendment entries and the current content hash.
 */
export interface LiveOutlineCharter {
  markdown: string;
  amendments: CharterAmendment[];
  charterHash: string;
}

export type LiveOutlineResult =
  | { ok: true; section: "outline"; outline: LiveOutline }
  | {
      ok: true;
      section: "full";
      header: LiveOutlineHeader;
      contexts: LiveOutlineContextSection[];
    }
  | { ok: true; section: "context"; context: LiveOutlineContextSection }
  | { ok: true; section: "task"; task: LiveOutlineTaskFull }
  | { ok: true; section: "config"; config: LiveOutlineResolvedConfig }
  | { ok: true; section: "charter"; charter: LiveOutlineCharter }
  | { ok: true; section: "outputs"; outputs: LiveOutlineContextOutput[] }
  | { ok: false; error: string };

function buildHeader(execution: GraphWorkflowExecution): LiveOutlineHeader {
  const editability = classifyExecutionEditability(execution);
  const editable = editability.kind === "editable";
  return {
    executionId: execution.id,
    liveRevision: execution.liveRevision,
    status: execution.status,
    seedDefinitionId: execution.seedDefinitionId,
    seedDefinitionRevision: execution.seedDefinitionRevision,
    editable,
    ...(editable ? {} : { notEditableReason: editability.reason }),
    charterAmendmentCount: execution.charterAmendments.length,
    planRepairRoundCount: execution.planRepairRounds.length,
  };
}

/**
 * Resolve the classifier's lifecycle verdict into a display tier against the
 * execution-level editability (doc 06 outline column):
 *   - `frozen` lifecycle → `frozen`
 *   - `unstarted` lifecycle → `editable`
 *   - `started` lifecycle → `editable` when the execution is quiescent (paused or
 *     resumably-halted), otherwise `pause-to-edit`.
 * A not-editable execution is surfaced via the header's `editable:false`; a
 * `started` row on such an execution reads `pause-to-edit` (it would need a pause
 * the terminal execution can't grant), with the header as the authoritative gate.
 */
function resolveEditability(
  lifecycle: ContextLifecycle,
  execution: ExecutionEditability,
): LiveOutlineEditability {
  if (lifecycle === "frozen") return "frozen";
  if (lifecycle === "unstarted") return "editable";
  if (execution.kind === "editable" && execution.quiescent) return "editable";
  return "pause-to-edit";
}

function depsFor(
  execution: GraphWorkflowExecution,
  contextId: string,
): string[] {
  return execution.workingDefinition.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => edge.sourceContextId);
}

function summarizeAgent(
  agent: GraphWorkflowAgentConfig,
): LiveOutlineAgentSummary {
  return {
    backend: agent.backend,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
  };
}

/**
 * The seeded provenance of one assignment.
 *
 * Every field comes from the SNAPSHOT, including the profile identity — after
 * start the reference and the snapshot can disagree only if something bypassed
 * seeding, and in that case the reference is the wrong answer. The snapshot is
 * the side that ran.
 */
function summarizeProvenance(
  assignment: SeededAgentAssignment,
): LiveOutlineAssignmentProvenance {
  const snapshot = assignment.profileSnapshot;
  return {
    assignmentId: assignment.id,
    profile: formatAgentProfileRef({ tier: snapshot.tier, id: snapshot.id }),
    focus: assignment.focus ?? null,
    revision: snapshot.revision,
    resolvedInstructionHash: snapshot.resolvedInstructionHash,
  };
}

// One entry per seeded assignment, whether or not the cohort is enabled: the
// cohort's own switch says which of them run, and a display surface reports the
// whole configured set rather than silently hiding the dormant half.
function summarizeValidators(
  cohort: SeededValidatorCohort,
): LiveOutlineValidatorSummary[] {
  return cohort.assignments.map((assignment) => ({
    ...summarizeProvenance(assignment),
    strategy: assignment.strategy,
    backend: assignment.agent.backend,
    model: assignment.agent.model,
    reasoningEffort: assignment.agent.reasoningEffort,
  }));
}

function summarizeCollaboration(
  collaboration: ResolvedCollaborationConfig | undefined,
): LiveOutlineCollaborationSummary | null {
  if (!collaboration?.enabled.value) return null;
  return {
    secondAgent: summarizeAgent(collaboration.secondAgent.value),
    negotiationRounds: collaboration.negotiationRounds.value,
    autonomousResolutionThreshold:
      collaboration.autonomousResolutionThreshold.value,
  };
}

function summarizeConfig(
  context: GraphWorkflowResolvedContext,
): LiveOutlineContextConfig {
  return {
    contextId: context.id,
    implementer: {
      ...summarizeAgent(context.implementer.agent),
      ...summarizeProvenance(context.implementer),
    },
    validatorCohortEnabled: context.contextValidator.enabled,
    validators: summarizeValidators(context.contextValidator),
    scriptValidator: {
      commands: context.scriptValidator.commands,
    },
    humanApprovalGate: context.humanApprovalGate.enabled,
    askUserQuestions: context.askUserQuestions.enabled,
    collaboration: summarizeCollaboration(context.collaboration),
    agentValidation: context.agentValidation
      ? {
          implementer: context.agentValidation.implementer.value,
          contextValidator: context.agentValidation.contextValidator.value,
        }
      : null,
  };
}

/**
 * A context's FULL resolved config — the concrete config blocks straight from
 * `workingDefinition` (doc 06: selector responses return full config). Unlike
 * {@link summarizeConfig} (the compact one-line outline summary), this is what
 * an agent/inspector reads before a targeted `live edit`.
 */
function resolveFullConfig(
  context: GraphWorkflowResolvedContext,
): LiveOutlineResolvedConfig {
  return {
    contextId: context.id,
    implementer: context.implementer,
    contextValidator: context.contextValidator,
    scriptValidator: context.scriptValidator,
    humanApprovalGate: context.humanApprovalGate,
    askUserQuestions: context.askUserQuestions,
    iterationPolicy: context.iterationPolicy,
    circuitBreaker: context.circuitBreaker,
    mutability: context.mutability,
    planRepair: context.planRepair,
    // Spread conditionally so "declares none" reads as an absent key rather
    // than an explicit `undefined` in the JSON the CLI/inspector reads back.
    ...(context.outputSchema !== undefined
      ? { outputSchema: context.outputSchema }
      : {}),
    ...(context.agentValidation !== undefined
      ? { agentValidation: context.agentValidation }
      : {}),
    collaboration: context.collaboration ?? null,
  };
}

/** The outline-tier shape of a declared contract (never the declaration). */
function summarizeOutputSchema(
  outputSchema: Record<string, unknown> | undefined,
): LiveOutlineOutputSchemaSummary | null {
  return outputSchema === undefined
    ? null
    : summarizeOutputSchemaShape(outputSchema);
}

function contextRow(
  execution: GraphWorkflowExecution,
  context: GraphWorkflowResolvedContext,
  executionEditability: ExecutionEditability,
): LiveOutlineContext {
  const state = execution.contextStates[context.id];
  const lifecycle = classifyContextLifecycle(execution, context.id);
  const provenance = resolveExpansionProvenance(
    execution.expansionReceipts,
    context.id,
  );
  return {
    id: context.id,
    title: context.title,
    status: state?.status ?? "pending",
    editability: resolveEditability(lifecycle, executionEditability),
    deps: depsFor(execution, context.id),
    completedTaskCount: state?.completedTaskCount ?? 0,
    totalTaskCount: state?.totalTaskCount ?? 0,
    iterationCount: state?.iterationCount ?? 0,
    maxIterations: context.iterationPolicy.maxIterations,
    outputSchema: summarizeOutputSchema(context.outputSchema),
    skip: state?.status === "skipped" ? (state.skipReason ?? null) : null,
    loop: resolveLoopPassMembership({
      contextId: context.id,
      loopGroups: execution.workingDefinition.loopGroups ?? [],
      loopStates: execution.loopStates,
    }),
    provenance:
      provenance?.nodeKind === "context"
        ? {
            requestId: provenance.receipt.requestId,
            invokerContextId: provenance.receipt.invokerContextId,
          }
        : null,
  };
}

/**
 * Every edge with the projection's verdict on it (R13.2). Read through
 * `projectExecutionRoutes` rather than re-evaluated here: guard semantics live
 * in `route-projection.ts` and nowhere else, so the CLI reports exactly what
 * the scheduler decided.
 */
function routeRows(execution: GraphWorkflowExecution): LiveOutlineRoute[] {
  const projection = projectExecutionRoutes(execution);
  return projection.edges.map((edge) => ({
    id: edge.edgeId,
    source: edge.logicalSourceId,
    effectiveSource: edge.effectiveSourceId,
    target: edge.targetContextId,
    guard: edge.guard,
    resolution: edge.resolution.kind,
  }));
}

/** Declared loops with their runtime ledger state; `[]` when none are declared. */
function loopRows(execution: GraphWorkflowExecution): LiveOutlineLoop[] {
  const loopGroups = execution.workingDefinition.loopGroups ?? [];
  return loopGroups.map((group) => {
    const state = execution.loopStates[group.id];
    return {
      loopGroupId: group.id,
      activation: state?.activation ?? "unstarted",
      passCount: state?.passCount ?? 0,
      maxPasses: group.maxPasses,
      loopControlRevision: state?.loopControlRevision ?? 0,
      logicalExitContextId: group.exitContextId,
      concludingExitContextId: state?.concludingExitContextId ?? null,
    };
  });
}

function expansionRows(
  execution: GraphWorkflowExecution,
): LiveOutlineExpansions {
  return {
    accepted: execution.expansionReceipts.accepted.map((receipt) => ({
      requestId: receipt.requestId,
      invokerContextId: receipt.invokerContextId,
      rationale: receipt.rationale,
      addedContextIds: [...receipt.addedContextIds],
      addedTaskIds: [...receipt.addedTaskIds],
      rejoinContextIds: [...receipt.rejoinContextIds],
      payloadHash: receipt.payloadHash,
      acceptedAt: receipt.acceptedAt,
    })),
    refusals: execution.expansionReceipts.refusals.map((receipt) => ({
      requestId: receipt.requestId,
      invokerContextId: receipt.invokerContextId,
      refusalCode: receipt.refusalCode,
      refusedAt: receipt.refusedAt,
    })),
  };
}

/**
 * Every context that owes or has banked a structured output, in graph order.
 * Membership and capture state come from {@link getContextOutput} rather than a
 * second reading of `contextOutputs`, so the CLI read and the engine agree on
 * what "an output exists" means.
 */
function contextOutputRows(
  execution: GraphWorkflowExecution,
): LiveOutlineContextOutput[] {
  const rows: LiveOutlineContextOutput[] = [];
  for (const context of execution.workingDefinition.executionContexts) {
    const lookup = getContextOutput(execution, context.id);
    if (lookup.kind === "none") continue;
    // A skipped context answers `skipped` before it can answer `none`, so the
    // free-form ones are filtered on the declaration instead: they have no
    // contract to report here either way.
    if (lookup.kind === "skipped" && context.outputSchema === undefined) {
      continue;
    }
    // `orphaned` — banked, then its declaration cleared — still lists here with
    // a null `schema`: this is the operator's read path for what a context
    // produced, and losing the payload because the contract was edited away
    // would leave nowhere to read it. The display surfaces treat it differently
    // (R7.6/R7.7 scope themselves to a declared contract).
    const banked = lookup.kind === "captured" || lookup.kind === "orphaned";
    rows.push({
      contextId: context.id,
      title: context.title,
      status: execution.contextStates[context.id]?.status ?? "pending",
      schema: summarizeOutputSchema(context.outputSchema),
      capture: banked
        ? {
            kind: "captured",
            value: lookup.output.value,
            capturedAt: lookup.output.capturedAt,
            iteration: lookup.output.iteration,
            parse: lookup.output.parse,
          }
        : lookup.kind === "skipped"
          ? { kind: "skipped" }
          : { kind: "pending" },
    });
  }
  return rows;
}

/** Tasks in (context definition order, then task order) — a stable render order. */
function orderedTasks(execution: GraphWorkflowExecution) {
  const contextOrder = new Map<string, number>();
  execution.workingDefinition.executionContexts.forEach((context, index) => {
    contextOrder.set(context.id, index);
  });
  return [...execution.workingDefinition.tasks].sort((a, b) => {
    const byContext =
      (contextOrder.get(a.contextId) ?? Number.MAX_SAFE_INTEGER) -
      (contextOrder.get(b.contextId) ?? Number.MAX_SAFE_INTEGER);
    return byContext !== 0 ? byContext : a.order - b.order;
  });
}

function taskStatus(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphWorkflowTaskStatus {
  return execution.taskStates[taskId]?.status ?? "pending";
}

function sizedTaskRow(
  execution: GraphWorkflowExecution,
  task: GraphWorkflowExecution["workingDefinition"]["tasks"][number],
): LiveOutlineTask {
  return {
    contextId: task.contextId,
    order: task.order,
    id: task.id,
    status: taskStatus(execution, task.id),
    title: task.title,
    instructionChars: task.instructions.length,
  };
}

function fullTaskRow(
  execution: GraphWorkflowExecution,
  task: GraphWorkflowExecution["workingDefinition"]["tasks"][number],
): LiveOutlineTaskFull {
  return {
    contextId: task.contextId,
    order: task.order,
    id: task.id,
    status: taskStatus(execution, task.id),
    title: task.title,
    instructions: task.instructions,
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

function contextSection(
  execution: GraphWorkflowExecution,
  context: GraphWorkflowResolvedContext,
  executionEditability: ExecutionEditability,
): LiveOutlineContextSection {
  const row = contextRow(execution, context, executionEditability);
  const tasks = orderedTasks(execution)
    .filter((task) => task.contextId === context.id)
    .map((task) => fullTaskRow(execution, task));
  return {
    id: context.id,
    title: context.title,
    description: context.description ?? null,
    // Rendered text, not the raw union: the outline is a CLI-facing contract
    // whose consumers parse this field as a plain string.
    acceptanceCriteria: acceptanceCriteriaText(context.acceptanceCriteria),
    status: row.status,
    editability: row.editability,
    deps: row.deps,
    completedTaskCount: row.completedTaskCount,
    totalTaskCount: row.totalTaskCount,
    iterationCount: row.iterationCount,
    maxIterations: row.maxIterations,
    config: resolveFullConfig(context),
    tasks,
  };
}

export function projectLiveOutline(
  execution: GraphWorkflowExecution,
  selector: LiveOutlineSelector,
): LiveOutlineResult {
  const header = buildHeader(execution);
  const executionEditability = classifyExecutionEditability(execution);
  const contexts = execution.workingDefinition.executionContexts;

  if (selector.kind === "context") {
    const context = contexts.find((c) => c.id === selector.contextId);
    if (!context) {
      return { ok: false, error: `unknown context "${selector.contextId}"` };
    }
    return {
      ok: true,
      section: "context",
      context: contextSection(execution, context, executionEditability),
    };
  }

  if (selector.kind === "task") {
    const task = execution.workingDefinition.tasks.find(
      (t) => t.id === selector.taskId,
    );
    if (!task) {
      return { ok: false, error: `unknown task "${selector.taskId}"` };
    }
    return { ok: true, section: "task", task: fullTaskRow(execution, task) };
  }

  if (selector.kind === "config") {
    const context = contexts.find((c) => c.id === selector.contextId);
    if (!context) {
      return { ok: false, error: `unknown context "${selector.contextId}"` };
    }
    return { ok: true, section: "config", config: resolveFullConfig(context) };
  }

  if (selector.kind === "charter") {
    return {
      ok: true,
      section: "charter",
      charter: {
        markdown: renderCharterMarkdown(
          execution.charter,
          execution.charterAmendments,
        ),
        amendments: execution.charterAmendments,
        charterHash: computeCharterHash(execution.charter),
      },
    };
  }

  if (selector.kind === "outputs") {
    return {
      ok: true,
      section: "outputs",
      outputs: contextOutputRows(execution),
    };
  }

  if (selector.kind === "full") {
    return {
      ok: true,
      section: "full",
      header,
      contexts: contexts.map((context) =>
        contextSection(execution, context, executionEditability),
      ),
    };
  }

  return {
    ok: true,
    section: "outline",
    outline: {
      header,
      contexts: contexts.map((context) =>
        contextRow(execution, context, executionEditability),
      ),
      tasks: orderedTasks(execution).map((task) =>
        sizedTaskRow(execution, task),
      ),
      config: contexts.map((context) => summarizeConfig(context)),
      laneMergeValidation:
        execution.workingDefinition.laneMergeValidation ?? null,
      routes: routeRows(execution),
      loops: loopRows(execution),
      expansions: expansionRows(execution),
    },
  };
}
