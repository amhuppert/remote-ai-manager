import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  explainInvalidElementHandle,
  formatElementHandle,
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
} from "@/lib/specs/handles";
import {
  deliveryDeltaProjectionSchema,
  type DeliveryDeltaProjection,
} from "@/lib/specs/delivery-delta";
import {
  deliveryPlanPreviewViewSchema,
  deliveryPlanViewSchema,
  type DeliveryPlanView,
} from "@/lib/specs/delivery-plan-views";
import {
  LINT_SEVERITY_LABEL,
  draftHealth,
  type DraftHealth,
} from "@/lib/specs/draft-health";
import { specMeasuresReportSchema } from "@/lib/specs/measures";
import {
  canonicalSpecBundleSchema,
  integrityReportSchema,
  specDetailViewSchema,
  specDiffViewSchema,
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specLintViewSchema,
  specProjectSearchViewSchema,
  specSearchViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
  type CanonicalSpecBundle,
  type RemainingAuthoringSequence,
  type SpecDiffView,
  type SpecProjectSearchView,
  type SpecSearchHit,
  type SpecStatusExecution,
  type SpecStatusView,
} from "@/lib/specs/view-schemas";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveProjectContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type ProjectContext,
  type RequestIssue,
} from "../../shared";
import { deliveryPlanPreviewText } from "./plan-preview-text";
import { countOf, gateLines, signOffLines } from "./projection-text";

const logger = createLogger("cli.spec");
const specShowResponseSchema = z.union([
  specDetailViewSchema,
  specSummaryViewSchema,
]);

/**
 * The execution states `projectSpecPhase` collapses into `phase: executing`.
 * Reporting them individually is what lets a reader tell a parked definition
 * review from a running lane.
 */
type ActiveExecution = SpecStatusExecution & {
  state: "definition_review" | "running";
};

function isActiveExecution(
  execution: SpecStatusExecution,
): execution is ActiveExecution {
  return (
    execution.state === "definition_review" || execution.state === "running"
  );
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; result: CliResult };

function specBasePath(context: ProjectContext, slug: string): string {
  return `/api/specs/${encodePathSegment(context.project)}/${encodePathSegment(slug)}`;
}

function validateSlug(
  input: string | undefined,
  command: string,
  json: boolean,
): ReadResult<string> {
  if (input === undefined) {
    return {
      ok: false,
      result: usageFailure(`spec ${command} requires <slug>`, json),
    };
  }
  const parsed = specSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: invalid spec slug ${JSON.stringify(input)}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function noExtraPositionals(
  rest: string[],
  expected: number,
  command: string,
  json: boolean,
): CliResult | null {
  if (rest.length === expected) return null;
  return usageFailure(`spec ${command} received unexpected arguments`, json);
}

async function requestTyped<T>(
  host: CliHost,
  context: ProjectContext,
  path: string,
  schema: z.ZodType<T>,
  command: string,
  json: boolean,
): Promise<ReadResult<T>> {
  const response = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path,
  });
  if (response.kind !== "ok") {
    return { ok: false, result: failureFromRequest(response, json) };
  }
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    logger.debug("cli.spec.invalid_response", {
      command,
      issueCount: parsed.error.issues.length,
    });
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec ${command} returned an unexpected response — is the CC server the same build as this CLI?`,
        code: "invalid_response",
        json,
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

type ExecutionLaneState =
  | "running"
  | "merge_pending"
  | "halted"
  | "awaiting_definition_approval"
  | "not_launched";

interface ExecutionProgress {
  readonly laneState: ExecutionLaneState;
  readonly actsNext: "human" | "agent" | null;
  readonly detail: string;
}

/**
 * The one owner of what a run's position means, so the text and `--json`
 * renderings cannot disagree. The spec-execution state decides: a run in
 * `definition_review` is parked whether or not a workflow execution is linked,
 * because linking is exactly what happens when the compiled definition parks
 * awaiting a human under a Gate execution_start dial.
 */
function describeExecution(execution: ActiveExecution): ExecutionProgress {
  const lane = execution.workflowExecutionId;
  if (execution.state === "running") {
    // The spec execution stays `running` until the session's delivering
    // merge, so the lane's own status is what separates "lanes are working"
    // from "everything finished; only the merge remains" and "halted".
    if (lane !== null && execution.workflowStatus === "completed") {
      return {
        laneState: "merge_pending",
        actsNext: null,
        detail: `workflow lane ${lane} completed; delivery lands when the session's delivering merge publishes`,
      };
    }
    if (lane !== null && execution.workflowStatus === "halted") {
      return {
        laneState: "halted",
        actsNext: null,
        detail: `workflow lane ${lane} halted; resolve the halt from the workflow surface, then resume it`,
      };
    }
    return {
      laneState: "running",
      actsNext: null,
      detail:
        lane === null ? "no workflow lane recorded" : `workflow lane ${lane}`,
    };
  }
  if (lane === null) {
    return {
      laneState: "not_launched",
      actsNext: "agent",
      detail: `no workflow lane launched (definition ${execution.workflowDefinitionId}); next: cctl workflow start ${execution.workflowDefinitionId}`,
    };
  }
  return {
    laneState: "awaiting_definition_approval",
    actsNext: "human",
    detail: `parked awaiting human approval of the compiled definition (workflow lane ${lane} is not running); next: a human approves it in Spec Studio`,
  };
}

const LANE_STATE_CLAUSES: ReadonlyArray<{
  laneState: ExecutionLaneState;
  clause: (count: number) => string;
}> = [
  {
    laneState: "running",
    clause: (count) =>
      `${count} workflow lane${count === 1 ? "" : "s"} running`,
  },
  {
    laneState: "merge_pending",
    clause: (count) =>
      `${count} workflow lane${count === 1 ? "" : "s"} completed awaiting the delivering merge`,
  },
  {
    laneState: "halted",
    clause: (count) =>
      `${count} workflow lane${count === 1 ? "" : "s"} halted awaiting attention`,
  },
  {
    laneState: "awaiting_definition_approval",
    clause: (count) =>
      `${count} execution${count === 1 ? "" : "s"} parked awaiting human approval of the compiled definition`,
  },
  {
    laneState: "not_launched",
    clause: (count) =>
      `${count} execution${count === 1 ? "" : "s"} parked with no workflow lane launched`,
  },
];

/**
 * `phase: executing` covers both a run parked at definition review and a live
 * lane. Unqualified it reads as "work is running", which is the wrong
 * conclusion for every parked execution.
 */
function phaseQualifier(executions: readonly ActiveExecution[]): string {
  const laneStates = executions.map(
    (execution) => describeExecution(execution).laneState,
  );
  const clauses = LANE_STATE_CLAUSES.flatMap(({ laneState, clause }) => {
    const count = laneStates.filter(
      (candidate) => candidate === laneState,
    ).length;
    return count === 0 ? [] : [clause(count)];
  });
  return clauses.length === 0 ? "" : ` (${clauses.join(", ")})`;
}

function executionLine(execution: ActiveExecution): string {
  return `  ${execution.id}: ${execution.state} — ${describeExecution(execution).detail}`;
}

/**
 * The exact command that concludes a stage. `advance` records the policy
 * admission and moves this draft on; `propose` ends the draft at that stage,
 * and the stage after it is authored in the draft an amendment opens.
 */
function concludingCommand(
  slug: string,
  transition: RemainingAuthoringSequence["nextTransition"],
): string {
  return transition.action === "advance"
    ? `cctl spec advance ${slug} --from ${transition.stage}`
    : `cctl spec propose ${slug}`;
}

/**
 * How many stages the open draft's spec still walks, and what concludes each
 * (R25.5). Without it a draft pinned by a policy change reads as if the new
 * preset's shorter sequence applied to it, which is the defect this answers.
 */
function authoringSequenceLines(
  slug: string,
  sequence: RemainingAuthoringSequence | null,
): string[] {
  if (sequence === null) {
    return [
      "remaining authoring stages: none — the current revision is not an open draft",
    ];
  }
  const [current, following] = sequence.stages;
  const transition = sequence.nextTransition;
  return [
    `remaining authoring stages (draft revision ${sequence.revisionNumber} pinned at ${sequence.pinnedStage}):`,
    ...sequence.stages.map(
      (stage) =>
        `  ${stage.stage}: dial ${stage.dial} — concluded by ${stage.concludedBy}${
          stage.requiresHumanSignOff ? ", human sign-off required" : ""
        }`,
    ),
    `  next: ${concludingCommand(slug, transition)}${
      transition.requiresHumanSignOff ? " — human sign-off required" : ""
    }; gates consulted: ${transition.consultedGates
      .map((consulted) => `${consulted.gate} (${consulted.dial})`)
      .join(", ")}`,
    ...(current?.concludedBy === "propose" && following !== undefined
      ? [
          `  this draft ends at ${current.stage}; once its gate is approved, cctl spec amend ${slug} opens the draft for ${following.stage}`,
        ]
      : []),
  ];
}

/**
 * Covered criterion ids the current revision does not carry. They are counted
 * by neither side of the coverage ratio, so each one is named with the reason
 * it is missing from it — a plan claiming content the revision lost is the
 * readable signature of an amendment that forked past that content.
 */
function unresolvedCoverageLines(elementIds: readonly string[]): string[] {
  if (elementIds.length === 0) return [];
  return [
    "    unresolved criterion ids:",
    ...elementIds.map(
      (elementId) =>
        `      ${elementId} (not in the current revision; excluded from coverage)`,
    ),
  ];
}

/**
 * Depended-on task ids the current revision does not carry. The compiler can
 * order nothing against them, so they are named apart from the dependencies
 * that resolve rather than printed as if they were handles.
 */
function unresolvedDependencyLines(elementIds: readonly string[]): string[] {
  if (elementIds.length === 0) return [];
  return [
    "    unresolved dependency ids:",
    ...elementIds.map(
      (elementId) =>
        `      ${elementId} (not in the current revision; excluded from ordering)`,
    ),
  ];
}

/**
 * How many items an enumerated status section prints before it says how many
 * it left out. Status is read to decide the next act; a spec with a long tail
 * of questions or tasks would otherwise push the gates, the sign-off, and the
 * findings tier out of the reader's window.
 */
const STATUS_SECTION_LIMIT = 10;

/**
 * One enumerated section, bounded and accounted for. The counts are printed
 * whether or not anything was dropped, so the shape of a section never depends
 * on how much it happens to hold — and an omission is never silent.
 *
 * Items arrive in the order the status projection assigned them, which is
 * stable across reads, so the same ten show every time.
 */
function boundedSection<T>(
  label: string,
  items: readonly T[],
  renderItem: (item: T) => string[],
): string[] {
  const shown = items.slice(0, STATUS_SECTION_LIMIT);
  const omitted = items.length - shown.length;
  const header = `${label}: ${items.length} total, ${shown.length} shown, ${omitted} omitted`;
  if (items.length === 0) return [header, "  none"];
  return [header, ...shown.flatMap(renderItem)];
}

/**
 * The status-sized reading of the draft's lint. It names the counts and the
 * first few findings, then points at the verb that prints the rest: status is
 * a decision surface, and a full panel here would crowd out the decision.
 */
function draftHealthLines(
  slug: string,
  health: SpecStatusView["draftHealth"],
): string[] {
  if (health === null) return [];
  if (health.total === 0) {
    return [
      "lint findings: 0 total, 0 blocking",
      `  full panel: cctl spec lint ${slug}`,
    ];
  }
  return [
    `lint findings: ${health.total} total, ${health.blocking} blocking`,
    ...health.counts.map((entry) => `  ${entry.severity}: ${entry.count}`),
    ...health.top.map(
      (finding) => `  ${finding.elementHandle}: ${finding.message}`,
    ),
    // Named whether or not the tier truncated: the verb is how an author reads
    // the findings grouped and in full, and status is where they learn it exists.
    `  full panel: cctl spec lint ${slug}`,
  ];
}

function statusText(
  status: SpecStatusView,
  executions: readonly ActiveExecution[],
): string {
  const lines = [
    `${status.slug}  phase: ${status.phase.primary}${phaseQualifier(executions)}`,
    ...(status.phase.authoringStage === undefined
      ? []
      : [
          `authoring stage: ${status.phase.authoringStage} (concluding gate: ${status.phase.authoringStage})`,
        ]),
    ...authoringSequenceLines(status.slug, status.authoringSequence),
    // The ratio counts only the criteria this revision carries, so it says so:
    // a plan covering ids the revision lost would otherwise read as complete.
    `coverage: ${status.coverage.coveredCriteria}/${status.coverage.totalCriteria} current-revision criteria (${status.coverage.percentage}%)`,
    ...draftHealthLines(status.slug, status.draftHealth),
    // A spec with no run says so by omitting the section entirely; only a run
    // that exists is worth accounting for.
    ...(executions.length === 0
      ? []
      : boundedSection("executions", executions, (execution) => [
          executionLine(execution),
        ])),
    "gates:",
    ...gateLines(status.gates),
    // Subject approvals and the revision's own sign-off are separate answers:
    // a consulted human gate stays pending after its last subject approval, so
    // an empty subject list beside a pending gate would name no act at all.
    ...boundedSection(
      "pending subject approvals",
      status.pendingApprovals,
      (approval) => [`  ${approval.gate}: ${approval.subject}`],
    ),
    "revision sign-off:",
    ...signOffLines(status.revisionSignOff),
    ...boundedSection("open questions", status.openQuestions, (question) => [
      `  ${question.handle}: ${question.text}`,
    ]),
    ...boundedSection("assumptions", status.assumptions, (assumption) => [
      `  ${assumption.handle} [${assumption.disposition}]: ${assumption.text}`,
    ]),
    ...boundedSection("plan tasks", status.taskPlan, (task) => [
      `  ${task.handle}: ${task.title}`,
      `    dependencies: ${task.dependsOn.join(", ") || "none"}`,
      ...unresolvedDependencyLines(task.unresolvedDependsOnTaskElementIds),
      `    lane group: ${task.laneGroup ?? "one task per lane"}`,
      `    execution lane: ${task.executionLane ?? "single-member lane"}`,
      `    touched surfaces: ${task.touchedPaths.join(", ") || "not declared"}`,
      `    criterion coverage: ${task.criterionCoverage.join(", ") || "none"}`,
      ...unresolvedCoverageLines(task.unresolvedCriterionElementIds),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

function mismatchIssues(
  report: z.infer<typeof integrityReportSchema>,
): RequestIssue[] {
  return report.mismatches.map((mismatch) => ({
    path: `revisions.${mismatch.revisionId}`,
    message:
      mismatch.mismatchedElementIds.length === 0
        ? "revision content hash does not match"
        : `payload hash mismatch for ${mismatch.mismatchedElementIds.join(", ")}`,
  }));
}

/**
 * The one renderer for the consistency families (design §9). Both families
 * carry the same `detail` + `remedy` pair, so the report never has to grow a
 * per-family section: a reader sees what is wrong and the exact act that ends
 * it, on one line, whichever family produced it.
 */
function consistencyIssues(
  report: z.infer<typeof integrityReportSchema>,
): RequestIssue[] {
  return report.consistencyFindings.map((finding) => ({
    path:
      finding.family === "execution-lifecycle"
        ? `${finding.family}.${finding.specExecutionId}`
        : `${finding.family}.${finding.revisionId}`,
    message: `${finding.detail}. Remedy: ${finding.remedy}`,
  }));
}

function integrityFailure(
  message: string,
  instruction: string,
  details: Record<string, unknown>,
  issues: RequestIssue[],
  json: boolean,
  code = "integrity_mismatch",
): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message,
    code,
    instruction,
    details,
    ...(issues.length > 0
      ? {
          issues,
          detail: issues
            .map((issue) => `  ${issue.path}: ${issue.message}`)
            .join("\n"),
        }
      : {}),
    json,
  });
}

async function readBundleFile(
  host: CliHost,
  filePath: string,
  json: boolean,
): Promise<ReadResult<CanonicalSpecBundle>> {
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: cannot read --against file ${JSON.stringify(filePath)}`,
        json,
      ),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: --against file ${JSON.stringify(filePath)} is not valid JSON`,
        json,
      ),
    };
  }
  const parsed = canonicalSpecBundleSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: --against file ${JSON.stringify(filePath)} is not a canonical spec bundle`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

export async function runSpecList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec list"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "list", json);
  if (extra) return extra;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `/api/specs/${encodePathSegment(resolved.context.project)}`,
    specInventoryViewSchema,
    "list",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "list",
    specCount: response.value.specs.length,
  });
  const human =
    response.value.specs.length === 0
      ? "no specs\n"
      : `${response.value.specs
          .map(
            (item) =>
              `${item.spec.slug}\t${item.phase.primary}\t${item.spec.name}`,
          )
          .join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, { ok: true, specs: response.value.specs }),
    stderr: "",
  };
}

export async function runSpecMeasures(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec measures"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "measures", json);
  if (extra) return extra;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `/api/projects/${encodePathSegment(resolved.context.project)}/spec-measures`,
    specMeasuresReportSchema,
    "measures",
    json,
  );
  if (!response.ok) return response.result;
  const report = response.value;
  logger.info("cli.spec.measures_complete", {
    definitionsVersion: report.definitionsVersion,
    deliveredCriterionCount:
      report.traceabilityCompleteness.deliveredInScopeCriterionCount,
    completeChainCount: report.traceabilityCompleteness.completeChainCount,
    navigationChainCount: report.navigationChains.length,
  });
  const traceabilityShare = report.traceabilityCompleteness.share;
  const evidenceShare = report.automaticEvidenceCapture.share;
  const human = [
    `definitions: ${report.definitionsVersion}`,
    `requirement-caused rework: ${report.requirementCausedRework.totalReworkEventCount}`,
    `approval friction: ${report.approvalFriction.activeReviewTimeMs}ms active, ${report.approvalFriction.interventionCount} interventions, ${report.approvalFriction.reapprovalLoopCount} re-approval loops`,
    `traceability completeness: ${traceabilityShare === null ? "n/a" : `${(traceabilityShare * 100).toFixed(1)}%`} (${report.traceabilityCompleteness.completeChainCount}/${report.traceabilityCompleteness.deliveredInScopeCriterionCount})`,
    `automatic evidence capture: ${evidenceShare === null ? "n/a" : `${(evidenceShare * 100).toFixed(1)}%`} (${report.automaticEvidenceCapture.automaticallyIngestedCount}/${report.automaticEvidenceCapture.totalEvidenceCount})`,
    `reviewer navigation chains: ${report.navigationChains.length}`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, { ok: true, ...report }),
    stderr: "",
  };
}

export async function runSpecShow(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec show"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "show", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "show", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const summary = values["summary"] === "true";
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}${summary ? "/summary" : ""}`,
    specShowResponseSchema,
    "show",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "show",
    slug: slug.value,
    summary,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${JSON.stringify(response.value, null, 2)}\n`, {
      ok: true,
      spec: response.value,
    }),
    stderr: "",
  };
}

export async function runSpecStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec status"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "status", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "status", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/status`,
    specStatusViewSchema,
    "status",
    json,
  );
  if (!response.ok) return response.result;
  const executions = response.value.executions.filter(isActiveExecution);
  logger.debug("cli.spec.read_complete", {
    command: "status",
    slug: slug.value,
    pendingApprovalCount: response.value.pendingApprovals.length,
    openQuestionCount: response.value.openQuestions.length,
    activeExecutionCount: executions.length,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, statusText(response.value, executions), {
      ok: true,
      status: response.value,
      executions: executions.map((execution) => {
        const progress = describeExecution(execution);
        return {
          id: execution.id,
          state: execution.state,
          workflowDefinitionId: execution.workflowDefinitionId,
          workflowExecutionId: execution.workflowExecutionId,
          workflowStatus: execution.workflowStatus,
          laneState: progress.laneState,
          actsNext: progress.actsNext,
        };
      }),
    }),
    stderr: "",
  };
}

/**
 * The full panel, severity by severity. The blocking group carries what it
 * blocks in words: an author reading `blocks_propose` has to know the enum to
 * read the consequence, and the point of the verb is to make the consequence
 * legible before propose refuses.
 */
function lintText(slug: string, health: DraftHealth): string {
  const summary = `${slug}  lint: ${countOf(health.total, "finding")}, ${health.blocking} blocking`;
  if (health.total === 0) {
    return `${summary}\nnothing to fix — this draft has no lint findings\n`;
  }
  const lines = [
    summary,
    ...health.groups.flatMap((group) => [
      `${LINT_SEVERITY_LABEL[group.severity]} (${group.findings.length})${
        group.severity === "blocks_propose" ? " — would block propose" : ""
      }:`,
      ...group.findings.map(
        (finding) =>
          `  ${finding.elementHandle} [${finding.ruleId}]: ${finding.message}`,
      ),
    ]),
    ...(health.blocking === 0
      ? [`next: cctl spec propose ${slug} — nothing here refuses it`]
      : [
          `next: fix the ${countOf(health.blocking, "blocking finding")} above, then cctl spec propose ${slug}`,
        ]),
  ];
  return `${lines.join("\n")}\n`;
}

export async function runSpecLint(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec lint"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "lint", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "lint", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/lint`,
    specLintViewSchema,
    "lint",
    json,
  );
  if (!response.ok) return response.result;
  // The same projection the propose refusal, the status tier, and Studio's
  // lint tab read — grouping and what counts as blocking are decided once.
  const health = draftHealth(response.value.findings);
  logger.debug("cli.spec.read_complete", {
    command: "lint",
    slug: slug.value,
    findingCount: health.total,
    blockingCount: health.blocking,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, lintText(slug.value, health), {
      ok: true,
      lint: {
        revisionId: response.value.revisionId,
        total: health.total,
        blocking: health.blocking,
        counts: health.counts,
        groups: health.groups,
      },
    }),
    stderr: "",
  };
}

/**
 * Stand-in slug used only to test handle grammar, never to resolve: it lets an
 * ungrammatical address be told apart from one that is merely unqualified.
 */
const GRAMMAR_PROBE_SLUG = "spec";

function parseGetTarget(
  rest: string[],
  json: boolean,
): ReadResult<{ slug: string; handle: string }> {
  if (rest.length !== 1 && rest.length !== 2) {
    return {
      ok: false,
      result: usageFailure(
        "spec get requires <slug>/<handle> or <slug> <handle>",
        json,
      ),
    };
  }
  const raw = (rest.length === 1 ? rest[0] : rest[1]) ?? "";
  const contextSlug = rest.length === 1 ? undefined : rest[0];
  // The grammar probe below deliberately ignores this slug, so it would other-
  // wise reach parseElementHandle unchecked and throw instead of refusing.
  if (contextSlug !== undefined) {
    const slug = validateSlug(contextSlug, "get", json);
    if (!slug.ok) return slug;
  }
  // Probe the grammar against a stand-in slug so an ungrammatical address is
  // refused on its own terms; a bare handle is grammatical and only missing
  // the slug this command resolves through, which the next branch names.
  if (!isWellFormedElementHandle(raw, GRAMMAR_PROBE_SLUG)) {
    return {
      ok: false,
      result: usageFailure(
        `spec get: ${explainInvalidElementHandle(raw)}`,
        json,
      ),
    };
  }
  if (contextSlug === undefined && !raw.includes("/")) {
    return {
      ok: false,
      result: usageFailure(
        `spec get: ${JSON.stringify(raw)} is missing its spec slug; this command takes <slug>/${raw} or <slug> ${raw}`,
        json,
      ),
    };
  }
  const parsed = parseElementHandle(raw, contextSlug);
  return {
    ok: true,
    value: {
      slug: parsed.slug,
      handle: formatElementHandle(parsed, "bare"),
    },
  };
}

export async function runSpecGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec get"), json);
  if (denied) return denied;
  const target = parseGetTarget(rest, json);
  if (!target.ok) return target.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, target.value.slug)}/elements/${encodePathSegment(target.value.handle)}`,
    specElementGetResponseSchema,
    "get",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "get",
    slug: target.value.slug,
    handle: target.value.handle,
    evidenceStateCount:
      "evidenceState" in response.value
        ? response.value.evidenceState.length
        : 0,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${JSON.stringify(response.value, null, 2)}\n`, {
      ok: true,
      element: response.value,
    }),
    stderr: "",
  };
}

const SEARCH_SHAPES =
  "cctl spec search <slug> <query> searches one spec; cctl spec search --all <query> searches every spec in the project";

/**
 * A project-wide hit is worth reporting on its slug or name alone, so the
 * summary distinguishes "this spec is named like your query" from "this spec
 * says it" rather than collapsing both into a count.
 */
function projectHitSummary(hit: SpecSearchHit): string {
  const elements = `${hit.matchCount} element match${hit.matchCount === 1 ? "" : "es"}`;
  return hit.matchedName ? `name or slug match, ${elements}` : elements;
}

function projectSearchText(view: SpecProjectSearchView): string {
  if (view.results.length === 0) return "no matches\n";
  const lines = view.results.flatMap((hit) => [
    `${hit.slug}\t${hit.phase.primary}\t${hit.preset}\t${projectHitSummary(hit)}\t${hit.name}`,
    ...hit.matches.map(
      (match) => `  ${match.handle}\t${match.kind}\t${match.text}`,
    ),
  ]);
  return `${lines.join("\n")}\n`;
}

async function runSpecProjectSearch(
  rest: string[],
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  if (rest.length !== 1) {
    return usageFailure(
      `spec search --all takes only <query> — ${SEARCH_SHAPES}`,
      json,
    );
  }
  const query = rest[0]?.trim() ?? "";
  if (query.length === 0) {
    return usageFailure("spec search requires a non-empty <query>", json);
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const params = new URLSearchParams({ q: query });
  const response = await requestTyped(
    host,
    resolved.context,
    // Project-scoped reads sit under `-` rather than beside [slug]: a static
    // sibling wins over the dynamic segment, so a bare /search would make a
    // spec slugged "search" unreachable. `-` is not a legal slug.
    `/api/specs/${encodePathSegment(resolved.context.project)}/-/search?${params.toString()}`,
    specProjectSearchViewSchema,
    "search",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "search",
    scope: "project",
    queryLength: query.length,
    resultCount: response.value.results.length,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, projectSearchText(response.value), {
      ok: true,
      scope: "project",
      search: response.value,
    }),
    stderr: "",
  };
}

export async function runSpecSearch(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec search"), json);
  if (denied) return denied;
  if (values["all"] === "true") {
    return runSpecProjectSearch(rest, flags, env, host);
  }
  if (rest.length !== 2) {
    return usageFailure(
      `spec search takes <slug> <query> — ${SEARCH_SHAPES}`,
      json,
    );
  }
  const slug = validateSlug(rest[0], "search", json);
  if (!slug.ok) return slug.result;
  const query = rest[1]?.trim() ?? "";
  if (query.length === 0) {
    return usageFailure("spec search requires a non-empty <query>", json);
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const params = new URLSearchParams({ q: query });
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/search?${params.toString()}`,
    specSearchViewSchema,
    "search",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "search",
    slug: slug.value,
    queryLength: query.length,
    resultCount: response.value.results.length,
  });
  const human =
    response.value.results.length === 0
      ? "no matches\n"
      : `${response.value.results
          .map((match) => `${match.handle}\t${match.kind}\t${match.text}`)
          .join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, {
      ok: true,
      scope: "spec",
      search: response.value,
    }),
    stderr: "",
  };
}

const DIFF_BASELINE_LABELS: Record<SpecDiffView["baseline"], string> = {
  review: "immediate review base",
  governance: "governance base (nearest approved ancestor)",
  explicit: "explicitly named base",
};

function diffRevisionLabel(ref: SpecDiffView["from"]): string {
  return ref === null
    ? "no base revision"
    : `revision ${ref.number} (${ref.state})`;
}

function diffText(view: SpecDiffView): string {
  const lines = [
    `${view.slug}  ${diffRevisionLabel(view.to)} vs ${diffRevisionLabel(view.from)} — ${DIFF_BASELINE_LABELS[view.baseline]}`,
    ...(view.elements.length === 0
      ? ["no elements"]
      : view.elements.map((element) =>
          [
            element.classification,
            element.handle ?? element.elementId,
            // An unchanged element has no change to summarize, so its kind is
            // what a reader needs to place it among the ones that did change.
            element.summary ?? element.kind,
          ].join("\t"),
        )),
    `plan stale: ${view.planStale ? "yes" : "no"}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runSpecDiff(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec diff"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "diff", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "diff", json);
  if (!slug.ok) return slug.result;
  const baseline = values["baseline"];
  if (baseline !== undefined && baseline !== "governance") {
    return usageFailure(
      `spec diff: --baseline takes only "governance"; omit it to compare against the immediate review base`,
      json,
    );
  }
  // Both flags name a base, so honouring one would silently discard the other.
  if (baseline !== undefined && values["from"] !== undefined) {
    return usageFailure(
      "spec diff: --from and --baseline governance name different bases; pass --from alone to compare against the revision you name, or --baseline governance alone to compare against the nearest approved ancestor",
      json,
    );
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const params = new URLSearchParams();
  for (const [name, value] of [
    ["from", values["from"]],
    ["to", values["to"]],
    ["baseline", baseline],
  ] as const) {
    if (value !== undefined) params.set(name, value);
  }
  const query = params.toString();
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/diff${query === "" ? "" : `?${query}`}`,
    specDiffViewSchema,
    "diff",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "diff",
    slug: slug.value,
    baseline: response.value.baseline,
    changedElementCount: response.value.elements.filter(
      (element) => element.classification !== "unchanged",
    ).length,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, diffText(response.value), {
      ok: true,
      diff: response.value,
    }),
    stderr: "",
  };
}

/**
 * Where an unflagged export lands. `.cc/` is git-ignored, so the default never
 * dirties the worktree it is run from; `--out` is how a caller asks for a
 * durable location.
 */
function derivedExportPath(slug: string): string {
  return `.cc/temp/${slug}-spec-bundle.json`;
}

/** The manifest fields the export summary tallies; the rest passes through. */
const exportManifestShapeSchema = z
  .object({
    revisions: z.array(z.object({ elements: z.array(z.unknown()) }).loose()),
  })
  .loose();

interface ExportSummary {
  readonly revisionCount: number;
  readonly elementCount: number;
  readonly contentHash: string;
}

/**
 * What a reader checks a written bundle by. The counts come from the bundle's
 * own manifest rather than from a second traversal of the spec, and the hash
 * covers the exact bytes written — so the summary describes the artifact on
 * disk, not a re-derivation of it. A manifest this build cannot read is
 * reported as build drift instead of being tallied as empty.
 */
function exportSummary(
  bundle: CanonicalSpecBundle,
  serialized: string,
  json: boolean,
): ReadResult<ExportSummary> {
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(bundle.manifest);
  } catch {
    decoded = null;
  }
  const parsed = exportManifestShapeSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message:
          "spec export returned a manifest this CLI cannot summarize — is the CC server the same build as this CLI?",
        code: "invalid_response",
        json,
      }),
    };
  }
  return {
    ok: true,
    value: {
      revisionCount: parsed.data.revisions.length,
      elementCount: parsed.data.revisions.reduce(
        (total, revision) => total + revision.elements.length,
        0,
      ),
      contentHash: `sha256:${createHash("sha256").update(serialized, "utf-8").digest("hex")}`,
    },
  };
}

export async function runSpecExport(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec export"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "export", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "export", json);
  if (!slug.ok) return slug.result;
  const out = values["out"];
  const inlineToStdout = values["stdout"] === "true";
  if (inlineToStdout && out !== undefined) {
    return usageFailure(
      "spec export: --stdout and --out name different destinations; pass one of them",
      json,
    );
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/export`,
    canonicalSpecBundleSchema,
    "export",
    json,
  );
  if (!response.ok) return response.result;
  const serialized = `${JSON.stringify(response.value, null, 2)}\n`;
  const summarized = exportSummary(response.value, serialized, json);
  if (!summarized.ok) return summarized.result;
  const summary = summarized.value;
  if (inlineToStdout) {
    logger.debug("cli.spec.read_complete", {
      command: "export",
      slug: slug.value,
      markdownFileCount: response.value.markdownFiles.length,
      wroteOutput: false,
    });
    return {
      exitCode: EXIT_OK,
      stdout: render(json, serialized, {
        ok: true,
        bundle: response.value,
        ...summary,
      }),
      stderr: "",
    };
  }

  const path = out ?? derivedExportPath(slug.value);
  if (host.writeTextFile === undefined) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "spec export: this CLI host cannot write bundle files",
      code: "write_unavailable",
      instruction: "Re-run with --stdout to read the bundle instead.",
      json,
    });
  }
  try {
    await host.writeTextFile(path, serialized);
  } catch {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `spec export: could not write ${JSON.stringify(path)}`,
      code: "write_failed",
      instruction:
        "Name a writable file with --out, or re-run with --stdout to read the bundle instead.",
      json,
    });
  }
  logger.debug("cli.spec.read_complete", {
    command: "export",
    slug: slug.value,
    markdownFileCount: response.value.markdownFiles.length,
    wroteOutput: true,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      [
        `revisions: ${summary.revisionCount}`,
        `elements: ${summary.elementCount}`,
        `content hash: ${summary.contentHash}`,
        `written: ${path}`,
        "",
      ].join("\n"),
      { ok: true, path, ...summary },
    ),
    stderr: "",
  };
}

/**
 * The delivery-plan attempt's compiled shape. Two stages, two different
 * promises: `draft` compiles what is editable right now (never approvable),
 * `proposed` reads the frozen candidate byte for byte — its
 * `compiledDefinitionHash` is what an approval binds to and what a launch runs.
 */
async function runDeliveryPlanPreview(
  slug: string,
  stage: string,
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  if (stage !== "draft" && stage !== "proposed") {
    return usageFailure(
      `spec plan preview --stage takes draft or proposed, not ${JSON.stringify(stage)} — \`draft\` compiles the editable document, \`proposed\` reads the frozen candidate`,
      json,
    );
  }
  const rawExpected = values["expected-draft-revision"];
  if (rawExpected !== undefined && stage !== "draft") {
    return usageFailure(
      "spec plan preview --expected-draft-revision applies only to --stage draft; a proposed preview reads a frozen row that no edit can move",
      json,
    );
  }
  const expected =
    rawExpected === undefined ? undefined : Number.parseInt(rawExpected, 10);
  if (expected !== undefined && !Number.isInteger(expected)) {
    return usageFailure(
      `spec plan preview --expected-draft-revision takes the integer draft revision you read, not ${JSON.stringify(rawExpected)}`,
      json,
    );
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const query = new URLSearchParams({ stage });
  if (expected !== undefined) {
    query.set("expectedDraftRevision", String(expected));
  }
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug)}/plan-preview?${query.toString()}`,
    deliveryPlanPreviewViewSchema,
    "plan preview",
    json,
  );
  if (!response.ok) return response.result;
  const preview = response.value;
  logger.debug("cli.spec.read_complete", {
    command: "plan preview",
    slug,
    stage: preview.stage,
    contextCount: preview.definition.executionContexts.length,
    approvable: preview.approvable,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, deliveryPlanPreviewText(preview), {
      ok: true,
      preview,
    }),
    stderr: "",
  };
}

export async function runSpecPlanPreview(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan preview"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan preview", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan preview", json);
  if (!slug.ok) return slug.result;
  const stage = values["stage"];
  const retiredFlags = ["scope", "context", "revision"].filter(
    (name) => values[name] !== undefined,
  );
  if (stage === undefined || retiredFlags.length > 0) {
    const retiredDetail =
      retiredFlags.length === 0
        ? "--stage draft or --stage proposed is required"
        : `${retiredFlags.map((name) => `--${name}`).join(", ")} ${
            retiredFlags.length === 1 ? "is" : "are"
          } retired`;
    return usageFailure(
      `spec plan preview: ${retiredDetail}; evergreen Plan compiler inference is no longer an active preview path. Seed legacy content with \`cctl spec plan open ${slug.value} --seed-from last\`, then inspect the delivery-plan attempt with \`cctl spec plan preview ${slug.value} --stage draft\`.`,
      json,
    );
  }
  return runDeliveryPlanPreview(slug.value, stage, flags, values, env, host);
}

export async function runSpecVerify(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec verify"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "verify", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "verify", json);
  if (!slug.ok) return slug.result;
  const againstPath = values["against"];
  const against =
    againstPath === undefined
      ? undefined
      : await readBundleFile(host, againstPath, json);
  if (against !== undefined && !against.ok) return against.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const report = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/verify`,
    integrityReportSchema,
    "verify",
    json,
  );
  if (!report.ok) return report.result;
  if (!report.value.ok) {
    logger.debug("cli.spec.integrity_mismatch", {
      slug: slug.value,
      mismatchCount: report.value.mismatches.length,
    });
    return integrityFailure(
      `spec ${slug.value} failed integrity verification`,
      "Restore the approved revision content from a trusted export before continuing.",
      { report: report.value },
      [...mismatchIssues(report.value), ...consistencyIssues(report.value)],
      json,
    );
  }

  // Reported until disposed of: an unfinished cleanup and a stranded proposal
  // are states nothing clears on its own, so a silent exit 0 would be the same
  // dead end one layer up. Each issue carries the act that ends it.
  if (report.value.consistencyFindings.length > 0) {
    logger.debug("cli.spec.consistency_findings", {
      slug: slug.value,
      findingCount: report.value.consistencyFindings.length,
    });
    return integrityFailure(
      `spec ${slug.value} has ${report.value.consistencyFindings.length} unresolved consistency finding(s)`,
      "Run the remedy named on each finding, then verify again.",
      { report: report.value },
      consistencyIssues(report.value),
      json,
      "spec_inconsistent",
    );
  }

  if (against !== undefined && against.ok) {
    const current = await requestTyped(
      host,
      resolved.context,
      `${specBasePath(resolved.context, slug.value)}/export`,
      canonicalSpecBundleSchema,
      "verify",
      json,
    );
    if (!current.ok) return current.result;
    if (!isDeepStrictEqual(current.value, against.value)) {
      logger.debug("cli.spec.integrity_mismatch", {
        slug: slug.value,
        against: againstPath ?? null,
        mismatchKind: "export",
      });
      return integrityFailure(
        `spec ${slug.value} differs from ${againstPath}`,
        "Review the live spec or export a fresh canonical bundle before continuing.",
        { against: againstPath },
        [{ path: "bundle", message: "current canonical export differs" }],
        json,
      );
    }
  }

  logger.debug("cli.spec.read_complete", {
    command: "verify",
    slug: slug.value,
    checkedRevisionCount: report.value.checkedRevisionIds.length,
    comparedExport: againstPath !== undefined,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `verified ${slug.value}\n`, {
      ok: true,
      report: report.value,
      ...(againstPath === undefined ? {} : { against: againstPath }),
    }),
    stderr: "",
  };
}

/** Per-class listings are bounded so a large delta stays readable. */
const DELTA_CLASS_ROW_CAP = 30;

/**
 * One bounded per-class block: the counts are always the true totals, so a
 * capped listing can never be misread as the whole set, and `--out` is named
 * as the path to the rest.
 */
function deltaClassLines<T>(
  label: string,
  rows: readonly T[],
  render: (row: T) => string,
): string[] {
  if (rows.length === 0) return [`  ${label}: 0`];
  const shown = rows.slice(0, DELTA_CLASS_ROW_CAP);
  const omitted = rows.length - shown.length;
  return [
    `  ${label}: ${rows.length} total, ${shown.length} shown, ${omitted} omitted`,
    ...shown.map((row) => `    ${render(row)}`),
  ];
}

function shortHash(hash: string | null): string {
  return hash === null ? "—" : hash.slice(0, 12);
}

function deltaHumanText(projection: DeliveryDeltaProjection): string {
  const compared = projection.comparedExecution;
  const header =
    compared === null
      ? `${projection.specSlug}: revision ${projection.current.revisionNumber} has no delivered execution to compare against — every element is new work.`
      : `${projection.specSlug}: revision ${projection.current.revisionNumber} vs execution ${compared.executionId} (pinned revision ${projection.base?.revisionNumber ?? "unknown"}, ${compared.state}${
          compared.deliveredAt === null ? "" : ` ${compared.deliveredAt}`
        })`;

  const elementsByClass = (
    ["added", "amended", "removed", "unchanged"] as const
  ).flatMap((elementClass) =>
    deltaClassLines(
      elementClass,
      projection.elements.filter((row) => row.class === elementClass),
      (row) =>
        `${row.handle} (${row.kind}) ${shortHash(row.baseHash)} → ${shortHash(row.currentHash)}`,
    ),
  );

  const criteriaByClass = (
    [
      "hard_stale",
      "soft_stale",
      "never_delivered",
      "deferred",
      "waived",
      "delivered_and_fresh",
    ] as const
  ).flatMap((criterionClass) =>
    deltaClassLines(
      criterionClass,
      projection.criteria.filter((row) => row.class === criterionClass),
      (row) => {
        const because = (row.freshness?.basis ?? [])
          .map((entry) => `${entry.handle}:${entry.reason}`)
          .join(", ");
        return `${row.handle}${
          row.priorDisposition === null ? "" : ` [was ${row.priorDisposition}]`
        }${because === "" ? "" : ` — ${because}`}`;
      },
    ),
  );

  return [
    header,
    "elements:",
    ...elementsByClass,
    "criteria:",
    ...criteriaByClass,
    ...deltaClassLines(
      "advisories",
      projection.advisories,
      (row) => `${row.handle} ${row.code}: ${row.message}`,
    ),
  ].join("\n");
}

export async function runSpecDelta(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec delta"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "delta", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "delta", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const since = values["since"];
  const query =
    since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/delta${query}`,
    deliveryDeltaProjectionSchema,
    "delta",
    json,
  );
  if (!response.ok) return response.result;

  const out = values["out"];
  if (out !== undefined) {
    if (host.writeTextFile === undefined) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "spec delta: this CLI host cannot write --out files",
        code: "write_unavailable",
        json,
      });
    }
    try {
      await host.writeTextFile(
        out,
        `${JSON.stringify(response.value, null, 2)}\n`,
      );
    } catch {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec delta: could not write ${JSON.stringify(out)}`,
        code: "write_failed",
        json,
      });
    }
  }

  logger.debug("cli.spec.read_complete", {
    command: "delta",
    slug: slug.value,
    comparedExecutionId: response.value.comparedExecution?.executionId,
    criterionCount: response.value.criteria.length,
    advisoryCount: response.value.advisories.length,
    wroteOutput: out !== undefined,
  });
  const human = [
    deltaHumanText(response.value),
    out === undefined
      ? "complete projection: re-run with --out <file> to write the full JSON"
      : `complete projection written to ${out}`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, {
      ok: true,
      delta: response.value,
      ...(out === undefined ? {} : { out }),
    }),
    stderr: "",
  };
}

/**
 * The delivery-plan attempt read, shared by `spec plan get` and `spec plan
 * status`. Both verbs read the same projection the propose gate enforces and
 * an edit receipt reported (`single-lint-projection`) — `get` renders the plan
 * the author wrote, `status` renders what it owes.
 */
async function readPlanView(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
  command: "plan get" | "plan status",
): Promise<ReadResult<{ view: DeliveryPlanView; slug: string }>> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor(`spec ${command}`), json);
  if (denied) return { ok: false, result: denied };
  const extra = noExtraPositionals(rest, 1, command, json);
  if (extra) return { ok: false, result: extra };
  const slug = validateSlug(rest[0], command, json);
  if (!slug.ok) return slug;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return { ok: false, result: resolved.result };
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/plan`,
    deliveryPlanViewSchema,
    command,
    json,
  );
  if (!response.ok) return response;
  return { ok: true, value: { view: response.value, slug: slug.value } };
}

/** `acts next: agent — cctl spec plan propose <slug>` plus the reason. */
function planNextActLines(view: DeliveryPlanView): string[] {
  return [
    `acts next: ${view.nextAct.actor} — ${view.nextAct.command}`,
    `  why: ${view.nextAct.reason}`,
  ];
}

function planHealthLines(view: DeliveryPlanView): string[] {
  if (view.health.total === 0) return ["plan findings: 0 total, 0 blocking"];
  return [
    `plan findings: ${view.health.total} total, ${view.health.blocking} blocking`,
    ...view.health.counts.map((entry) => `  ${entry.severity}: ${entry.count}`),
  ];
}

function planStatusText(view: DeliveryPlanView): string {
  const attempt = view.attempt;
  const lines = [
    `${attempt.specSlug}  plan attempt ${attempt.id}  status: ${attempt.status}`,
    `pinned revision: ${attempt.pinnedRevisionId}  draft revision: ${attempt.draftRevision}`,
    `delta basis: ${attempt.deltaBasisExecutionId ?? "none — nothing has delivered yet"}`,
    ...(attempt.planHash === null
      ? []
      : [`live proposal: ${attempt.planHash}`]),
    ...(view.approval === null
      ? []
      : [
          `approved: snapshot ${view.approval.snapshotId} at ${view.approval.planHash}`,
        ]),
    ...planHealthLines(view),
    ...boundedSection(
      "blocking findings",
      view.health.findings.filter(
        (finding) => finding.severity === "blocks_propose",
      ),
      (finding) => [
        `  ${finding.elementHandle} [${finding.ruleId}]: ${finding.message}`,
      ],
    ),
    ...boundedSection("dispositions", view.dispositionCounts, (entry) => [
      `  ${entry.disposition}: ${entry.count}`,
    ]),
    ...boundedSection("unresolved dispositions", view.unresolved, (row) => [
      `  ${row.handle} [${row.disposition}]: ${row.resolution}`,
    ]),
    ...boundedSection("proposal snapshots", view.snapshots, (snapshot) => [
      `  ${snapshot.draftRevision}: ${snapshot.planHash} at ${snapshot.proposedAt}`,
    ]),
    ...planNextActLines(view),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The wiring a context owns, under the same cap its parent section obeys. A
 * bounded outer section whose rows are each unbounded is not bounded: one
 * context owning hundreds of capabilities would flood the whole read.
 */
function nestedWiringLines(entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, STATUS_SECTION_LIMIT);
  const omitted = entries.length - shown.length;
  return [
    `    wiring: ${entries.length} total, ${shown.length} shown, ${omitted} omitted`,
    ...shown.map((entry) => `      ${entry}`),
  ];
}

function planGetText(view: DeliveryPlanView): string {
  const { document } = view;
  const wiringByContext = new Map(
    view.wiringByContext.map((entry) => [entry.contextId, entry.entries]),
  );
  const lines = [
    `${view.attempt.specSlug}  plan attempt ${view.attempt.id} (${view.attempt.status}, draft revision ${view.attempt.draftRevision})`,
    ...boundedSection("dispositions", document.dispositions, (entry) => [
      `  ${entry.criterionElementId}: ${entry.disposition}${
        entry.deliveredByExecutionId === null
          ? ""
          : ` (by ${entry.deliveredByExecutionId})`
      }`,
    ]),
    ...boundedSection("contexts", document.contexts, (context) => [
      `  ${context.contextId} [${context.contextType}]: ${context.title}`,
      `    owns: ${context.criterionElementIds.join(", ") || "no criterion"}`,
      `    contract: ${context.acceptanceContract.length} line(s)`,
      ...nestedWiringLines(wiringByContext.get(context.contextId) ?? []),
    ]),
    ...boundedSection("tasks", document.tasks, (task) => [
      `  [${task.order}] ${task.taskId} in ${task.contextId}: ${task.title}`,
    ]),
    ...boundedSection("edges", document.edges, (edge) => [
      `  ${edge.edgeId}: ${edge.fromContextId} -> ${edge.toContextId}`,
    ]),
    ...boundedSection("wiring", document.wiring, (entry) => [
      `  ${entry.capabilityId}: owned by ${entry.owner.contextId} (${entry.owner.kind})`,
    ]),
    // The rendering is bounded by design; the whole document is one --json read
    // away, and saying so is what keeps a truncated section from reading as the
    // whole plan.
    `full document: cctl spec plan get ${view.attempt.specSlug} --json`,
    ...planNextActLines(view),
  ];
  return `${lines.join("\n")}\n`;
}

export async function runSpecPlanGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const read = await readPlanView(rest, flags, values, env, host, "plan get");
  if (!read.ok) return read.result;
  const { view } = read.value;
  logger.debug("cli.spec.read_complete", {
    command: "plan get",
    slug: read.value.slug,
    attemptId: view.attempt.id,
    contextCount: view.document.contexts.length,
    taskCount: view.document.tasks.length,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, planGetText(view), { ok: true, plan: view }),
    stderr: "",
  };
}

export async function runSpecPlanStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const read = await readPlanView(
    rest,
    flags,
    values,
    env,
    host,
    "plan status",
  );
  if (!read.ok) return read.result;
  const { view } = read.value;
  logger.debug("cli.spec.read_complete", {
    command: "plan status",
    slug: read.value.slug,
    attemptId: view.attempt.id,
    status: view.attempt.status,
    blockingCount: view.health.blocking,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, planStatusText(view), { ok: true, plan: view }),
    stderr: "",
  };
}
