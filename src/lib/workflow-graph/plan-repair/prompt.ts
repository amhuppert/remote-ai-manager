/**
 * Prompt builder for the plan-repair agent (docs/design/cc-cli/08 §The repair
 * agent). Pure — evidence is embedded so the one-shot turn needs no discovery
 * pass, and the guardrails (diagnose-first, never weaken AC) travel with every
 * invocation.
 */

import { renderCharterPromptSection } from "../charter/render";
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
  issues: { taskId: string; title: string; description: string }[];
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
      const issueLines = verdict.issues.map(
        (issue) =>
          `    - ${issue.taskId}: ${issue.title} — ${issue.description}`,
      );
      return [
        `${index + 1}. [${verdict.pass ? "pass" : "fail"}] ${verdict.summary}`,
        ...issueLines,
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
      "",
      "## Allowed repair operations",
      "",
      "Emit live-edit operations from this vocabulary ONLY (plan artifacts; no structural graph changes, no validator/gate/config controls). Every entry in `operations` MUST be a JSON object with a `type` field, using EXACTLY these shapes:",
      "```jsonc",
      '{"type": "amend-charter", "rationale": "<required: why the charter changes>", "mission": "...", "conventions": ["..."], "nonGoals": ["..."], "vocabulary": ["..."], "testStrategy": "...", "knownAmbiguities": ["..."], "invariants": [{"id": "...", "statement": "..."}]}  // include only the charter fields you are changing',
      '{"type": "update-context", "contextId": "<id>", "title": "...", "description": "...", "acceptanceCriteria": "...", "iterationPolicy": {"maxIterations": 10, "continuity": {"enabled": true}}, "circuitBreaker": {"consecutiveFailureThreshold": 3}}  // include only the fields you are changing',
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
