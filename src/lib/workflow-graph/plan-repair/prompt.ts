/**
 * Prompt builder for the plan-repair agent (docs/design/cc-cli/08 §The repair
 * agent). Pure — evidence is embedded so the one-shot turn needs no discovery
 * pass, and the guardrails (diagnose-first, never weaken AC) travel with every
 * invocation.
 */

import { renderCharterPromptSection } from "../charter/render";
import type { GraphWorkflowValidationIssue } from "../definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  PlanRepairRound,
} from "../schemas";

/** Most recent validation verdicts rendered into the prompt. */
const VALIDATION_HISTORY_LIMIT = 5;

export interface PlanRepairValidationVerdict {
  pass: boolean;
  summary: string;
  /** Recorded issues, which may be located by task OR by instance path — an
   *  `output_schema` rejection (D2) is one of the impossible-contract failures
   *  this agent exists to repair, and it carries no task. */
  issues: readonly GraphWorkflowValidationIssue[];
  /**
   * Each cohort member's own verdict, when several reviewed the round.
   *
   * A flat list of findings from a three-validator round reads as one reviewer
   * repeating itself, which is exactly the wrong diagnosis: "three specialists
   * with different lenses each found one thing" and "one specialist found three
   * things" call for different repairs. Absent for a single-reviewer round,
   * where the flat list already says everything.
   */
  specialists?: readonly PlanRepairSpecialistVerdict[];
}

/** One cohort member's verdict, with the profile identity that produced it. */
export interface PlanRepairSpecialistVerdict {
  assignmentId: string;
  profile: { tier: string; id: string; revision: number };
  pass: boolean;
  summary: string;
  issues: readonly GraphWorkflowValidationIssue[];
}

/**
 * The validation history as the repair agent needs it, read off the aggregate
 * events the log already carries. Lives here rather than at the composition
 * site so the prompt's evidence contract has one owner.
 */
export function toPlanRepairValidationVerdict(event: {
  pass: boolean;
  summary: string;
  issues: readonly GraphWorkflowValidationIssue[];
  specialists?: readonly {
    assignmentId: string;
    profile: { tier: string; id: string; revision: number };
    pass: boolean;
    summary: string;
    issues: readonly GraphWorkflowValidationIssue[];
  }[];
}): PlanRepairValidationVerdict {
  return {
    pass: event.pass,
    summary: event.summary,
    issues: event.issues,
    ...(event.specialists && event.specialists.length > 0
      ? {
          specialists: event.specialists.map((specialist) => ({
            assignmentId: specialist.assignmentId,
            profile: specialist.profile,
            pass: specialist.pass,
            summary: specialist.summary,
            issues: specialist.issues,
          })),
        }
      : {}),
  };
}

export interface PlanRepairPromptInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  haltReason: GraphWorkflowHaltReason;
  /** 1-based attempt number for this context. */
  attempt: number;
  validationHistory: PlanRepairValidationVerdict[];
  priorRounds?: PlanRepairRound[];
}

export function buildPlanRepairPrompt(input: PlanRepairPromptInput): string {
  const { execution, contextId, haltReason, attempt } = input;
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  const contextState = execution.contextStates[contextId];
  const tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === contextId,
  );

  const sections: string[] = [];

  sections.push(
    [
      "# Plan repair review",
      "",
      `You are the plan-repair reviewer for a halted graph workflow execution (repair attempt ${attempt} for this context).`,
      "You act like a senior engineering lead reviewing a stalled workstream: diagnose the root cause first, and change the plan only when the plan itself is wrong.",
      "The execution is quiescent; you may read the repository to test whether the acceptance criteria are even satisfiable.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Halt",
      "```json",
      JSON.stringify(haltReason, null, 2),
      "```",
      ...(contextState
        ? [
            `Context progress: ${contextState.completedTaskCount}/${contextState.totalTaskCount} tasks, iteration ${contextState.iterationCount}/${context?.iterationPolicy.maxIterations ?? "?"}, consecutive validation failures ${contextState.consecutiveFailureCount}/${context?.circuitBreaker.consecutiveFailureThreshold ?? "?"}.`,
          ]
        : []),
    ].join("\n"),
  );

  if (execution.charter) {
    sections.push(
      renderCharterPromptSection(
        execution.charter,
        [],
        execution.charterAmendments,
      ),
    );
  }

  if (context) {
    sections.push(
      [
        `## Tripped context: ${context.id} — ${context.title}`,
        ...(context.description ? ["", context.description] : []),
        "",
        "### Acceptance criteria",
        context.acceptanceCriteria,
        // Without the declared contract in view, an `output_schema_validation`
        // trip reads as a work failure and the agent repairs the wrong thing.
        ...(context.outputSchema
          ? [
              "",
              "### Declared output schema",
              "The context must end by emitting one payload matching this JSON Schema exactly:",
              "```json",
              JSON.stringify(context.outputSchema, null, 2),
              "```",
            ]
          : []),
      ].join("\n"),
    );
  }

  if (tasks.length > 0) {
    const taskLines = tasks.map((task) => {
      const state = execution.taskStates[task.id];
      const failureLines =
        state && state.failureHistory.length > 0
          ? state.failureHistory
              .map((entry) => `    - failure: ${entry.message}`)
              .join("\n")
          : null;
      return [
        `- [${state?.status ?? "unknown"}] ${task.id}: ${task.title}`,
        ...(failureLines ? [failureLines] : []),
      ].join("\n");
    });
    sections.push(["## Tasks in the tripped context", ...taskLines].join("\n"));
  }

  const history = input.validationHistory.slice(-VALIDATION_HISTORY_LIMIT);
  if (history.length > 0) {
    const rendered = history.map((verdict, index) => {
      const specialists = verdict.specialists ?? [];
      // Grouped by assignment when a cohort reviewed the round: WHICH reviewer
      // raised WHAT is the difference between "one approach is failing" and
      // "several lenses each found something", and only the second is likely a
      // planning defect (R14).
      const body =
        specialists.length > 0
          ? specialists.map((specialist) =>
              [
                `  - ${specialist.assignmentId} (${specialist.profile.tier}/${specialist.profile.id} rev ${specialist.profile.revision}) [${specialist.pass ? "pass" : "fail"}]: ${specialist.summary}`,
                ...specialist.issues.map(
                  (issue) =>
                    `      - ${issue.taskId ?? issue.path ?? "context"}: ${issue.title} — ${issue.description}`,
                ),
              ].join("\n"),
            )
          : verdict.issues.map(
              (issue) =>
                `    - ${issue.taskId ?? issue.path ?? "context"}: ${issue.title} — ${issue.description}`,
            );
      return [
        `${index + 1}. [${verdict.pass ? "pass" : "fail"}] ${verdict.summary}`,
        ...body,
      ].join("\n");
    });
    sections.push(
      [
        `## Validation history (most recent ${history.length})`,
        ...rendered,
      ].join("\n"),
    );
  }

  const priorRounds = input.priorRounds ?? [];
  if (priorRounds.length > 0) {
    sections.push(
      [
        "## Prior plan-repair rounds on this execution",
        ...priorRounds.map(
          (round) =>
            `- round ${round.seq} (${round.contextId}, ${round.haltType}): outcome ${round.outcome ?? "unsettled"}, planningDefect ${String(round.planningDefect)}, ${round.operationCount} op(s)${round.diagnosis ? ` — ${round.diagnosis}` : ""}`,
        ),
        "",
        "Do not repeat a repair that already failed to unblock the context.",
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Your decision",
      "",
      "Classify the root cause:",
      "- **Planning defect** — an impossible, contradictory, or ambiguous acceptance criterion; a false assumption in the charter; a missing or mis-scoped task; or an honest budget shortfall for legitimately larger work.",
      "- **Not a planning defect** — a failing implementation approach, flaky infrastructure, or work that simply has not succeeded yet.",
      "",
      "Do not weaken acceptance criteria merely to make failures pass. A repair must preserve the workflow's intent — prefer clarifying ambiguity, correcting factual errors, or splitting an impossible criterion into achievable ones with rationale. When uncertain, return planningDefect: false.",
      ...(haltReason.type === "max_iterations"
        ? [
            "",
            "This halt is retry exhaustion by iteration budget: resuming does NOT reset the iteration count, so a repair that neither raises iterationPolicy.maxIterations nor shrinks the remaining work will re-halt immediately and burn a repair attempt.",
          ]
        : []),
      ...(haltReason.type === "circuit_breaker" &&
      haltReason.condition === "output_schema_validation"
        ? [
            "",
            "This halt is an output-contract failure, not a work failure: the context finished its tasks and passed validation, then could not emit a payload matching its declared `outputSchema`. Read the refused payloads in the validation history above — when the schema demands something the context's work cannot know, correct it with `outputSchema` (or `null` to return the context to free-form output). Leave the tasks alone unless the schema is right and the work genuinely missed it.",
          ]
        : []),
      "",
      "## Allowed repair operations",
      "",
      "Emit live-edit operations from this vocabulary ONLY (plan artifacts; no structural graph changes, no validator/gate/config controls). Every entry in `operations` MUST be a JSON object with a `type` field, using EXACTLY these shapes:",
      "```jsonc",
      '{"type": "amend-charter", "rationale": "<required: why the charter changes>", "mission": "...", "conventions": ["..."], "nonGoals": ["..."], "vocabulary": ["..."], "testStrategy": "...", "knownAmbiguities": ["..."], "invariants": [{"id": "...", "statement": "..."}]}  // include only the charter fields you are changing',
      '{"type": "update-context", "contextId": "<id>", "title": "...", "description": "...", "acceptanceCriteria": "...", "outputSchema": {"type": "object", "properties": {}} /* or null to drop it */, "iterationPolicy": {"maxIterations": 10, "continuity": {"enabled": true}}, "circuitBreaker": {"consecutiveFailureThreshold": 3}}  // include only the fields you are changing',
      '{"type": "add-task", "contextId": "<id>", "title": "...", "instructions": "..."}',
      '{"type": "update-task", "taskId": "<id>", "title": "...", "instructions": "..."}  // include only the fields you are changing',
      '{"type": "remove-task", "taskId": "<id>"}',
      '{"type": "reorder-tasks", "contextId": "<id>", "orderedTaskIds": ["<taskId>", "..."]}',
      "```",
      "",
      "## Output",
      "",
      "Return the structured verdict: `planningDefect` (boolean), `diagnosis` (your root-cause analysis — it becomes the halt summary when you decline), and `operations` (empty when planningDefect is false).",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
