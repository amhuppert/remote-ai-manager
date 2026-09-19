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

import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";

import { resolveExpansionProvenance } from "@/lib/workflow-graph/expansion-receipts";
import { resolveLoopPassMembership } from "@/lib/workflow-graph/loop-ledger";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentConfig,
  SeededAgentAssignment,
  SeededValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskStatus,
} from "@/lib/workflow-graph/definition-schemas";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  type ContextLifecycle,
  type ExecutionEditability,
} from "./lifecycle-classifier";

import {
  getContextOutput,
  summarizeOutputSchemaShape,
} from "./context-outputs";
import { computeCharterHash, renderCharterMarkdown } from "./charter/render";

import type {
  LiveOutlineEditability,
  LiveOutlineHeader,
  LiveOutlineAgentSummary,
  LiveOutlineAssignmentProvenance,
  LiveOutlineValidatorSummary,
  LiveOutlineCollaborationSummary,
  LiveOutlineContextConfig,
  LiveOutlineResolvedConfig,
  LiveOutlineOutputSchemaSummary,
  LiveOutlineRoute,
  LiveOutlineLoop,
  LiveOutlineExpansions,
  LiveOutlineContext,
  LiveOutlineContextOutput,
  LiveOutlineTask,
  LiveOutlineTaskFull,
  LiveOutlineContextSection,
  LiveOutlineSelector,
  LiveOutlineResult,
} from "./live-outline-schemas";

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
    openPlanRepairRound: openPlanRepairRound(execution),
  };
}

function openPlanRepairRound(
  execution: GraphWorkflowExecution,
): LiveOutlineHeader["openPlanRepairRound"] {
  // Appended before the agent's turn and settled after it, so an unsettled
  // round IS the turn. The log is append-only; the latest one wins.
  const open = execution.planRepairRounds.findLast(
    (round) => round.settledAt === null,
  );
  return open === undefined
    ? null
    : {
        seq: open.seq,
        contextId: open.contextId,
        startedAt: open.startedAt,
        conversationId: open.conversationId,
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
    modelSelection: {
      modelId: agent.modelSelection.modelId,
      parameters: { ...agent.modelSelection.parameters },
    },
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
    backend: assignment.agent.backend,
    modelSelection: {
      modelId: assignment.agent.modelSelection.modelId,
      parameters: { ...assignment.agent.modelSelection.parameters },
    },
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
    : { ...summarizeOutputSchemaShape(outputSchema) };
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
  const membership = resolveLoopPassMembership({
    contextId: context.id,
    loopGroups: execution.workingDefinition.loopGroups ?? [],
    loopStates: execution.loopStates,
  });
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
    loop: membership === null ? null : { ...membership },
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
