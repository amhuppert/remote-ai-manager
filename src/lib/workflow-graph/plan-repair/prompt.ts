/**
 * Prompt builder for the plan-repair agent (docs/design/cc-cli/08 §The repair
 * agent). Pure — evidence is embedded so the one-shot turn needs no discovery
 * pass, and the guardrails (diagnose-first, never weaken AC) travel with every
 * invocation.
 */

import { resolveLogicalAuthoredContextId } from "../charter/invariant-scope";
import { renderCharterPromptSection } from "../charter/render";
import { acceptanceCriteriaRecordListText } from "../criteria/criterion-records";
import type { GraphWorkflowValidationIssue } from "../definition-schemas";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  isLiveTaskLocked,
} from "../lifecycle-classifier";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowValidationAdvisory,
  PlanRepairRound,
} from "../schemas";
import type { PlanRepairLoopContext } from "./schemas";

/** Most recent validation verdicts rendered into the prompt. */
const VALIDATION_HISTORY_LIMIT = 5;

/** One advisory as the repair agent's evidence carries it, with its origin. */
interface PlanRepairAdvisoryEvidence {
  contextId: string;
  advisory: GraphWorkflowValidationAdvisory;
}

/**
 * The advisories this execution raised, as evidence for the repair agent (D10).
 *
 * Read off the retained round records rather than off the execution's advisory
 * index, because the index is a recognition projection — title and identity —
 * while this reader needs the observation itself and what the implementer
 * decided about it.
 *
 * The tripped context contributes everything it heard; every other context
 * contributes only what outlives its own round. An `implementation` advisory
 * raised elsewhere was addressed to the implementer who owned that work and
 * was answered there, so replaying it here would put work no one owes in front
 * of an agent looking for a planning defect — while a `plan` or `out_of_scope`
 * observation is exactly what that agent exists to weigh, wherever it was
 * raised (the same split the D9 index draws).
 */
function collectAdvisoryEvidence(
  execution: GraphWorkflowExecution,
  trippedContextId: string,
): PlanRepairAdvisoryEvidence[] {
  const contextIds = [
    trippedContextId,
    ...execution.workingDefinition.executionContexts
      .map((context) => context.id)
      .filter((id) => id !== trippedContextId),
  ];

  const evidence: PlanRepairAdvisoryEvidence[] = [];
  for (const contextId of contextIds) {
    const round = execution.contextStates[contextId]?.validationRound;
    if (!round) continue;
    for (const seat of round.roster) {
      const advisories = round.specialists[seat.assignmentId]?.advisories ?? [];
      for (const advisory of advisories) {
        if (
          contextId !== trippedContextId &&
          advisory.kind === "implementation"
        )
          continue;
        evidence.push({ contextId, advisory });
      }
    }
  }
  return evidence;
}

/**
 * What happened to one advisory after it was raised.
 *
 * Delivery is rendered alongside the disposition rather than separately: "no
 * disposition" means two different things — nobody has been asked yet, or
 * somebody was asked and the answer is not recorded — and only the first is
 * an ordinary state.
 */
function renderDisposition(advisory: GraphWorkflowValidationAdvisory): string {
  if (advisory.disposition !== null) {
    const { outcome, reason } = advisory.disposition;
    return `disposition: ${outcome}${reason === null ? "" : ` — ${reason}`}`;
  }
  return advisory.deliveredAt === null
    ? "disposition: none — not yet delivered to the implementer"
    : `disposition: none — delivered ${advisory.deliveredAt}`;
}

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

/**
 * One recorded issue as repair evidence, citing the criterion id when the
 * verdict carries one: the id is what lets the agent line a finding up
 * against the acceptance-criteria records its `update-context` may rewrite.
 */
function renderIssueEvidence(issue: GraphWorkflowValidationIssue): string {
  const location = issue.taskId ?? issue.path ?? "context";
  const criterion =
    issue.criterionId === undefined ? "" : ` (criterion ${issue.criterionId})`;
  return `${location}${criterion}: ${issue.title} — ${issue.description}`;
}

export interface PlanRepairPromptInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  haltReason: GraphWorkflowHaltReason;
  /** 1-based attempt number for this context. */
  attempt: number;
  validationHistory: PlanRepairValidationVerdict[];
  priorRounds?: PlanRepairRound[];
  /**
   * The halted loop, when this round repairs one (R12). Absent for a context
   * halt — and its absence is what keeps the loop ops out of the vocabulary,
   * mirroring the validator's fail-closed default.
   */
  loop?: PlanRepairLoopContext;
}

/**
 * The loop ops, rendered in the same EXACT-shape form as the plan ops: a shape
 * the agent cannot see is a capability it never uses.
 *
 * `raise-loop-max-passes` is withheld on a backstop halt, because there it is
 * not a remedy — the per-execution backstop is unraisable, and the validator
 * refuses the op anyway. Offering it would spend the round on a refusal.
 */
function loopOperationVocabulary(loop: PlanRepairLoopContext): string[] {
  return [
    "",
    `This halt is a loop budget exhaustion on loop group \`${loop.loopGroupId}\`. Three further operations are available, and they apply to that loop ONLY:`,
    "```jsonc",
    ...(loop.scope === "loop"
      ? [
          `{"type": "raise-loop-max-passes", "loopGroupId": "${loop.loopGroupId}", "maxPasses": 5, "rationale": "<optional>"}  // raising only; the cap may not exceed the execution's hard pass backstop`,
        ]
      : []),
    `{"type": "amend-loop-predicate", "loopGroupId": "${loop.loopGroupId}", "until": {"schema": {"type": "object", "properties": {}, "required": []}}, "rationale": "<REQUIRED: why the exit bar moves>"}`,
    `{"type": "edit-loop-template", "loopGroupId": "${loop.loopGroupId}", "operations": [{"type": "update-context", "contextId": "<TEMPLATE context id>", "title": "...", "description": "...", "acceptanceCriteria": [{"id": "<kebab-case>", "statement": "..."}]}, {"type": "add-task", "contextId": "<TEMPLATE context id>", "title": "...", "instructions": "..."}, {"type": "update-task", "taskId": "<TEMPLATE task id>", "instructions": "..."}, {"type": "remove-task", "taskId": "<TEMPLATE task id>"}, {"type": "reorder-tasks", "contextId": "<TEMPLATE context id>", "orderedTaskIds": ["..."]}]}`,
    "```",
    "",
    ...(loop.scope === "execution"
      ? [
          "The budget that refused is the per-execution pass **backstop**, not this loop's own cap. The backstop cannot be raised. Only a justified predicate amendment that lets an existing captured exit conclude can permit resume; otherwise decline repair and abandon the execution. A template edit requires another pass and cannot clear this halt.",
          "",
        ]
      : []),
    "Rules these operations answer to:",
    "- A predicate amendment REQUIRES a rationale and is **never retroactive** — completed passes keep the verdicts they ran under. Amend the predicate when the exit bar itself was wrong, not to wave through work that genuinely did not meet it.",
    "- Template edits address the BODY TEMPLATE's own context and task ids (the ids in the body template below), never a materialized pass instance like `<loop>__p2__<context>`. They reach the NEXT pass through the normal clone; passes that already ran are never edited.",
    "- The body template's MEMBERSHIP — which contexts form the body, which is the entry, which is the exit, and the edges between them — is frozen and has no operation. So is every structural change to the graph. Do not attempt one.",
    "- Raising the cap alone re-runs the same body against the same predicate. If the loop is not converging, say so and decline rather than buying more identical passes.",
    "- A template edit alone cannot clear an exhausted loop cap. Pair it with an affordable cap raise, or amend an incorrect predicate so the existing captured exit satisfies it. Resume refuses an unchanged loop-limit decision.",
  ];
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
    // The halted context's logical authored id: scoped sources bind authored
    // ids, so a halted loop instance renders under its template id.
    sections.push(
      renderCharterPromptSection(
        execution.charter,
        resolveLogicalAuthoredContextId({ execution, contextId }) ?? contextId,
      ),
    );
  }

  // The loop's own artifacts. Without them the agent is reading a halt about a
  // predicate it cannot see, on a body it cannot see — the two things every
  // available repair addresses.
  const loopGroup =
    input.loop === undefined
      ? undefined
      : execution.workingDefinition.loopGroups?.find(
          (group) => group.id === input.loop?.loopGroupId,
        );
  if (input.loop && loopGroup && "template" in loopGroup) {
    const passVerdicts = Object.entries(
      execution.loopStates[loopGroup.id]?.decisions ?? {},
    )
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(
        ([pass, decision]) =>
          `- pass ${pass}: ${decision.verdict} (${decision.outcome})`,
      );

    sections.push(
      [
        `## Halted loop: ${loopGroup.id}${loopGroup.title ? ` — ${loopGroup.title}` : ""}`,
        `Body entry \`${loopGroup.entryContextId}\`, exit \`${loopGroup.exitContextId}\`, cap ${loopGroup.maxPasses} pass(es), template version ${loopGroup.templateVersion}.`,
        "",
        "### Exit predicate",
        "The loop concludes when the exit context's captured output satisfies this predicate. It is evaluated by the engine, deterministically — no agent judges it:",
        "```json",
        JSON.stringify(loopGroup.until, null, 2),
        "```",
        ...(passVerdicts.length > 0
          ? ["", "### Recorded pass decisions", ...passVerdicts]
          : []),
        "",
        `### Body template (version ${loopGroup.templateVersion}) — the ids a template edit addresses`,
        ...loopGroup.template.contexts.map((entry) => {
          const templateTasks = loopGroup.template.tasks
            .filter((task) => task.contextId === entry.id)
            .sort((left, right) => left.order - right.order)
            .map((task) => `    - ${task.id}: ${task.title}`);
          return [
            `- \`${entry.id}\` — ${entry.title}`,
            `    AC: ${acceptanceCriteriaRecordListText(entry.acceptanceCriteria)}`,
            ...templateTasks,
          ].join("\n");
        }),
      ].join("\n"),
    );
  }

  if (context) {
    sections.push(
      [
        `## Tripped context: ${context.id} — ${context.title}`,
        ...(context.description ? ["", context.description] : []),
        "",
        "### Acceptance criteria",
        acceptanceCriteriaRecordListText(context.acceptanceCriteria),
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

  const editability = classifyExecutionEditability(execution);
  sections.push(
    [
      "## Live-edit targets",
      ...execution.workingDefinition.executionContexts.map((entry) => {
        const lifecycle = classifyContextLifecycle(execution, entry.id);
        const editable =
          editability.kind === "editable" &&
          lifecycle !== "frozen" &&
          (lifecycle === "unstarted" || editability.quiescent);
        return [
          `- ${entry.id}: ${editable ? "editable" : "frozen"} (${lifecycle})`,
          ...execution.workingDefinition.tasks
            .filter((task) => task.contextId === entry.id)
            .map(
              (task) =>
                `    - ${task.id}: ${!editable || isLiveTaskLocked(execution, task.id) ? "frozen" : "editable"}`,
            ),
        ].join("\n");
      }),
      "Completed and running tasks cannot be updated, removed, or reordered. Append a correction with add-task to an editable context, omitting order to preserve its completed prefix. A completed context cannot accept tasks. Ensure the context has remaining iteration budget; raise an exhausted context iterationPolicy.maxIterations only with a justified repair. If no admitted operation can make progress, decline repair.",
    ].join("\n"),
  );

  // Ahead of the round history on purpose: a plan-defect halt arrives already
  // classified — a blocking seat named the contract and said why no task can
  // answer it — and that reading is what this round acts on. The verdicts below
  // are the surroundings of the finding, not the finding.
  if (haltReason.type === "plan_defect") {
    sections.push(
      [
        "## Plan defect reported by a blocking reviewer",
        "",
        "The round concluded and a blocking seat refused the CONTRACT rather than the work: no task in the reviewed context can remedy what it found, so nothing was reopened and nothing was retried. Each finding names the contract it conflicts with and why the context cannot answer it locally.",
        "",
        ...haltReason.planDefects.map((defect) =>
          [
            `- [${defect.assignmentId}] ${defect.title}`,
            `    ${defect.description}`,
            `    not locally remediable: ${defect.whyNotLocallyRemediable}`,
            `    conflicting contract: ${defect.conflictingContract}`,
          ].join("\n"),
        ),
      ].join("\n"),
    );
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
                  (issue) => `      - ${renderIssueEvidence(issue)}`,
                ),
              ].join("\n"),
            )
          : verdict.issues.map(
              (issue) => `    - ${renderIssueEvidence(issue)}`,
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

  const advisories = collectAdvisoryEvidence(execution, contextId);
  if (advisories.length > 0) {
    sections.push(
      [
        "## Advisories raised in this execution",
        "",
        "Non-blocking observations from the validator cohort. None of them failed a context and the implementer was free to decline any of them, so read them as evidence about the plan rather than as work owed — a plan defect several reviewers noticed and nobody was obliged to fix is exactly what tends to survive into a halt.",
        "",
        ...advisories.map(({ contextId: origin, advisory }) =>
          [
            `- [${advisory.kind}] ${origin} · round ${advisory.identity.roundSeq} · ${advisory.identity.assignmentId}: ${advisory.title}`,
            `    ${advisory.description}`,
            `    ${renderDisposition(advisory)}`,
          ].join("\n"),
        ),
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
      ...(haltReason.type === "candidate_unstable"
        ? [
            "",
            `This halt is not a work failure at all: the context's validation rounds never reached a verdict, ${haltReason.consecutiveCount} in a row, because the engine could not certify what it was reviewing (${haltReason.driftedComponents === "" ? `nothing was observed to move — the last round concluded on ${haltReason.lastIncident}` : `last divergence at ${haltReason.stage}: ${haltReason.driftedComponents}`}). No reviewer rejected anything and no attempt was charged, so nothing in the tasks or the acceptance criteria explains it.`,
            "The two plan-shaped causes are both `placement`: the context shares a lane worktree with something that keeps writing to it (another member, or a dev server running in the lane), or its owned paths cover a surface a build regenerates. Moving the context to a lane of its own, or narrowing `placement.ownedPaths` off the churning surface, is the repair. Every other cause is outside the plan — a stale index, a tool writing into the worktree — and the honest answer for those is planningDefect: false with a diagnosis naming what you found.",
          ]
        : []),
      "",
      "## Allowed repair operations",
      "",
      "Choose live-edit operations from this vocabulary ONLY (plan artifacts, plus the one narrowing operation below; no structural graph changes, no gate or config controls). These are the logical operation shapes; the strict transport envelope is shown in the Output section:",
      "```jsonc",
      '{"type": "amend-charter", "rationale": "<required: why the charter changes>", "mission": "...", "conventions": ["..."], "nonGoals": ["..."], "vocabulary": ["..."], "testStrategy": "...", "knownAmbiguities": ["..."], "invariants": [{"id": "...", "statement": "...", "appliesTo": {"contextIds": ["..."]}}]}  // include only the charter fields you are changing',
      '{"type": "update-context", "contextId": "<id>", "title": "...", "description": "...", "acceptanceCriteria": [{"id": "<kebab-case>", "statement": "..."}], "outputSchema": {"type": "object", "properties": {}} /* or null to drop it */, "placement": {"lane": "<laneId>", "mode": "full" | "readOnly" | "owned", "ownedPaths": ["<repo-relative path>"] /* mode "owned" only */} /* replaces the placement wholesale */, "iterationPolicy": {"maxIterations": 10, "continuity": {"enabled": true}}, "circuitBreaker": {"consecutiveFailureThreshold": 3}}  // include only the fields you are changing',
      '{"type": "add-task", "contextId": "<id>", "title": "...", "instructions": "..."}',
      '{"type": "update-task", "taskId": "<id>", "title": "...", "instructions": "..."}  // include only the fields you are changing',
      '{"type": "remove-task", "taskId": "<id>"}',
      '{"type": "reorder-tasks", "contextId": "<id>", "orderedTaskIds": ["<taskId>", "..."]}',
      '{"type": "update-validator-assignment", "contextId": "<id>", "assignmentId": "<id>", "instructions": "...", "authority": "advisory"}  // include only the fields you are changing',
      "```",
      "",
      "`acceptanceCriteria` is an ordered list of `{id, statement}` records (kebab-case ids, unique within the context). `update-context` replaces the WHOLE value — per-criterion operations do not exist — so include every record the context should keep, verbatim, not just the ones you are changing: validator verdicts cite criterion ids, and a dropped or renamed id orphans the citations that name it.",
      ...(input.loop ? loopOperationVocabulary(input.loop) : []),
      "",
      'The last operation is the ONLY one that reaches a reviewer, and it narrows: it rewrites what one validator is told to judge, or takes its blocking authority away so its findings become non-blocking advisories. It cannot grant blocking authority (`"authority": "blocking"` is refused), add or remove a reviewer, or change which agent runs one. Use it when a blocking validator is holding the context against a standard the plan never meant it to enforce — not to silence a reviewer whose objection is correct.',
      "",
      "## Output",
      "",
      "Return the structured verdict: `planningDefect` (boolean), `diagnosis` (your root-cause analysis — it becomes the halt summary when you decline), and `operations` (empty when planningDefect is false).",
      "Each `operations` entry MUST use this transport envelope: `type` is the logical operation's type, and `payload` is a JSON-encoded object string containing every other field. Do not repeat `type` inside `payload`.",
      'Example: `{ "planningDefect": true, "diagnosis": "The criterion names a removed endpoint.", "operations": [{ "type": "update-context", "payload": "{\\"contextId\\":\\"context-implement\\",\\"acceptanceCriteria\\":[{\\"id\\":\\"ac-1\\",\\"statement\\":\\"Use the supported endpoint.\\"}]}" }] }`',
    ].join("\n"),
  );

  return sections.join("\n\n");
}
