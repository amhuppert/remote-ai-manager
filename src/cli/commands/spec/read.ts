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
import { specMeasuresReportSchema } from "@/lib/specs/measures";
import {
  canonicalSpecBundleSchema,
  integrityReportSchema,
  specDetailViewSchema,
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specProjectSearchViewSchema,
  specSearchViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
  type CanonicalSpecBundle,
  type RemainingAuthoringSequence,
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
import { gateLines, signOffLines } from "./projection-text";

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
    ...(executions.length === 0
      ? []
      : ["executions:", ...executions.map(executionLine)]),
    "gates:",
    ...gateLines(status.gates),
    // Subject approvals and the revision's own sign-off are separate answers:
    // a consulted human gate stays pending after its last subject approval, so
    // an empty subject list beside a pending gate would name no act at all.
    "pending subject approvals:",
    ...(status.pendingApprovals.length === 0
      ? ["  none"]
      : status.pendingApprovals.map(
          (approval) => `  ${approval.gate}: ${approval.subject}`,
        )),
    "revision sign-off:",
    ...signOffLines(status.revisionSignOff),
    "open questions:",
    ...(status.openQuestions.length === 0
      ? ["  none"]
      : status.openQuestions.map(
          (question) => `  ${question.handle}: ${question.text}`,
        )),
    "assumptions:",
    ...(status.assumptions.length === 0
      ? ["  none"]
      : status.assumptions.map(
          (assumption) =>
            `  ${assumption.handle} [${assumption.disposition}]: ${assumption.text}`,
        )),
    "plan tasks:",
    ...(status.taskPlan.length === 0
      ? ["  none"]
      : status.taskPlan.flatMap((task) => [
          `  ${task.handle}: ${task.title}`,
          `    dependencies: ${task.dependsOn.join(", ") || "none"}`,
          ...unresolvedDependencyLines(task.unresolvedDependsOnTaskElementIds),
          `    lane group: ${task.laneGroup ?? "one task per lane"}`,
          `    execution lane: ${task.executionLane ?? "single-member lane"}`,
          `    touched surfaces: ${task.touchedPaths.join(", ") || "not declared"}`,
          `    criterion coverage: ${task.criterionCoverage.join(", ") || "none"}`,
          ...unresolvedCoverageLines(task.unresolvedCriterionElementIds),
        ])),
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

function integrityFailure(
  message: string,
  instruction: string,
  details: Record<string, unknown>,
  issues: RequestIssue[],
  json: boolean,
): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message,
    code: "integrity_mismatch",
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
  const out = values["out"];
  if (out !== undefined) {
    if (host.writeTextFile === undefined) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "spec export: this CLI host cannot write --out files",
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
        message: `spec export: could not write ${JSON.stringify(out)}`,
        code: "write_failed",
        json,
      });
    }
  }
  logger.debug("cli.spec.read_complete", {
    command: "export",
    slug: slug.value,
    markdownFileCount: response.value.markdownFiles.length,
    wroteOutput: out !== undefined,
  });
  const human =
    out === undefined
      ? `${JSON.stringify(response.value, null, 2)}\n`
      : `exported ${slug.value} to ${out}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, {
      ok: true,
      bundle: response.value,
      ...(out === undefined ? {} : { out }),
    }),
    stderr: "",
  };
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
      mismatchIssues(report.value),
      json,
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
