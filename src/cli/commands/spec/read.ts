import { createHash } from "node:crypto";
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
import {
  compareCanonicalSpecBundles,
  decodeCanonicalSpecBundle,
  renderRevisionMarkdown,
} from "@/lib/specs/export";
import { specMeasuresReportSchema } from "@/lib/specs/measures";
import {
  canonicalSpecBundleSchema,
  integrityReportSchema,
  specCommentsViewSchema,
  specDetailViewSchema,
  specDiffViewSchema,
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specLintViewSchema,
  specProjectSearchViewSchema,
  specSearchViewSchema,
  specSectionViewSchema,
  specShowOutlineViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
  type CanonicalSpecBundle,
  type RemainingAuthoringSequence,
  type SpecCommentView,
  type SpecCommentsView,
  type SpecDiffView,
  type SpecElementGetResponse,
  type SpecProjectSearchView,
  type SpecSearchHit,
  type SpecShowOutlineView,
  type SpecStatusExecution,
  type SpecStatusView,
  type SpecSummaryView,
} from "@/lib/specs/view-schemas";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  invalidResponseFailure,
  render,
  resolveProjectContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type JsonEnvelope,
  type ProjectContext,
  type RequestIssue,
} from "../../shared";
import {
  boundedItems,
  emitLarge,
  omissionSummary,
  type ArtifactManifest,
  type Omission,
} from "../../disclosure";
import {
  buildOutlineData,
  parseOutlineRecord,
  renderOutline,
} from "../workflow-outline";
import { deliveryPlanLedgerLines } from "../delivery-plan-ledger";
import { deliveryPlanPreviewText } from "./plan-preview-text";
import {
  approvalLedgerLines,
  countOf,
  gateLines,
  signOffLines,
} from "./projection-text";
import {
  specGetEnvelopeSchema,
  specLintEnvelopeSchema,
  specSectionGetEnvelopeSchema,
  specShowArtifactEnvelopeSchema,
  specShowOutlineInlineEnvelopeSchema,
  specShowOutlineSpillEnvelopeSchema,
  specShowSummaryInlineEnvelopeSchema,
  specShowSummarySpillEnvelopeSchema,
  specStatusBoundedEnvelopeSchema,
  specStatusFullEnvelopeSchema,
  specStatusSpillEnvelopeSchema,
  type SpecStatusDisclosure,
  type SpecShowArtifact,
  type SpecShowArtifactRevision,
  type SpecShowOutlineInlineEnvelope,
  type SpecShowSummaryInlineEnvelope,
} from "./read-envelopes";

const logger = createLogger("cli.spec");
export const SPEC_SHOW_STDOUT_BUDGET_BYTES = 60 * 1024;
const SPEC_SHOW_OUT_PATH_BUDGET_BYTES = 4 * 1024;

/**
 * The execution states `projectSpecPhase` collapses into `phase: executing`.
 * Reporting them individually is what lets a reader tell a parked graph
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
      result: invalidResponseFailure({
        what: `spec ${command}`,
        issues: parsed.error.issues,
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
  | "awaiting_workflow_approval"
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
 * because linking is exactly what happens when its admitted one-off launch is
 * attached to the graph workflow run.
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
      detail:
        execution.workflowSeedSource === null
          ? "no immutable workflow source is recorded; this retired execution cannot be started"
          : "the admitted one-off launch is awaiting restart recovery before its workflow lane is attached",
    };
  }
  return {
    laneState: "awaiting_workflow_approval",
    actsNext: "human",
    detail: `parked awaiting human approval of workflow lane ${lane}; approve it from the workflow surface`,
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
    laneState: "awaiting_workflow_approval",
    clause: (count) =>
      `${count} execution${count === 1 ? "" : "s"} parked awaiting human approval of their workflow lane`,
  },
  {
    laneState: "not_launched",
    clause: (count) =>
      `${count} execution${count === 1 ? "" : "s"} parked with no workflow lane launched`,
  },
];

/**
 * `phase: executing` covers both a run parked at graph review and a live
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

/**
 * The row is addressed by the workflow execution id, the one execution id a
 * reader passes to any verb (design 3.5, D-B). A run with no lane yet has no
 * addressable id at all, so the row says that rather than offering the
 * internal row id every surface refuses.
 */
function executionLine(execution: ActiveExecution): string {
  const named = execution.workflowExecutionId ?? "(no workflow lane)";
  return `  ${named}: ${execution.state} — ${describeExecution(execution).detail}`;
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
 * Depended-on task ids the current revision does not carry. The legacy resolver can
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

/** The cap `--full` selects: no section drops a row. */
const EVERY_ROW = Number.MAX_SAFE_INTEGER;

/**
 * The status projection as one disclosure level: every enumerated section
 * carries the rows this level shows, and the account of what it left out. Text
 * and JSON both render from this value, so the cap is decided once and the two
 * serializations cannot report different rows or different counts.
 */
interface BoundedStatus {
  readonly status: SpecStatusView;
  readonly executions: readonly ActiveExecution[];
  readonly disclosure: SpecStatusDisclosure;
}

/**
 * Bound every enumerated section to `limit` rows. Items arrive in the order the
 * status projection assigned them, which is stable across reads, so the same
 * rows show every time.
 *
 * Tasks are outline rows, so the outline read is a narrower disclosure than
 * replaying the whole projection; every other section's rest lives in the
 * projection itself.
 */
function boundStatus(
  status: SpecStatusView,
  executions: readonly ActiveExecution[],
  limit: number,
): BoundedStatus {
  const whole = `cctl spec status ${status.slug} --full`;
  const bound = <T>(items: readonly T[], reveal: string) =>
    boundedItems(items, Math.max(limit, 1), reveal);
  const boundedExecutions = bound(executions, whole);
  const pendingApprovals = bound(status.pendingApprovals, whole);
  const importCarriedApprovals = bound(status.importCarriedApprovals, whole);
  // The ledger enumerates every consulted subject, so it is the section most
  // able to crowd out the rest. Only the enumeration is bounded: the counts
  // beside it are the account itself, and a truncated account would understate
  // what is settled — the exact misreading the ledger exists to prevent.
  const approvalLedgerSubjects = bound(status.approvalLedger.subjects, whole);
  const openQuestions = bound(status.openQuestions, whole);
  const assumptions = bound(status.assumptions, whole);
  const taskPlan = bound(status.taskPlan, `cctl spec show ${status.slug}`);
  return {
    status: {
      ...status,
      pendingApprovals: pendingApprovals.items,
      importCarriedApprovals: importCarriedApprovals.items,
      approvalLedger: {
        ...status.approvalLedger,
        subjects: approvalLedgerSubjects.items,
      },
      openQuestions: openQuestions.items,
      assumptions: assumptions.items,
      taskPlan: taskPlan.items,
    },
    executions: boundedExecutions.items,
    disclosure: {
      executions: boundedExecutions.omission,
      pendingApprovals: pendingApprovals.omission,
      importCarriedApprovals: importCarriedApprovals.omission,
      approvalLedgerSubjects: approvalLedgerSubjects.omission,
      openQuestions: openQuestions.omission,
      assumptions: assumptions.omission,
      taskPlan: taskPlan.omission,
    },
  };
}

/**
 * One enumerated section's lines. The counts are printed whether or not
 * anything was dropped, so the shape of a section never depends on how much it
 * happens to hold, and a section that dropped rows names the exact read that
 * returns them.
 */
function sectionLines<T>(
  label: string,
  items: readonly T[],
  omission: Omission,
  renderItem: (item: T) => string[],
): string[] {
  const header = `${label}: ${omissionSummary(omission)}`;
  if (items.length === 0) return [header, "  none"];
  // One item renders as one row even when it spans several lines: the cap
  // counts items, so a multi-line row never consumes another item's slot.
  return [header, ...items.map((item) => renderItem(item).join("\n"))];
}

/** A section bounded at read time, for the projections that carry no ladder. */
function boundedSection<T>(
  label: string,
  items: readonly T[],
  reveal: string,
  renderItem: (item: T) => string[],
): string[] {
  const bounded = boundedItems(items, STATUS_SECTION_LIMIT, reveal);
  return sectionLines(label, bounded.items, bounded.omission, renderItem);
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

function statusText(bounded: BoundedStatus): string {
  const status = bounded.status;
  const executions = bounded.executions;
  const disclosure = bounded.disclosure;
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
      : sectionLines(
          "executions",
          executions,
          disclosure.executions,
          (execution) => [executionLine(execution)],
        )),
    "gates:",
    ...gateLines(status.gates),
    // Read before the outstanding list, because the outstanding list read
    // alone is the misreading: seven pending subjects beside eight banked ones
    // is a position, and seven pending subjects alone is a loss.
    ...approvalLedgerLines(status.approvalLedger),
    // Subject approvals and the revision's own sign-off are separate answers:
    // a consulted human gate stays pending after its last subject approval, so
    // an empty subject list beside a pending gate would name no act at all.
    ...sectionLines(
      "pending subject approvals",
      status.pendingApprovals,
      disclosure.pendingApprovals,
      (approval) => [`  ${approval.gate}: ${approval.subject}`],
    ),
    // Only when the import settled something: a natively-authored spec has no
    // such subject, and a section printing `none` on every one of them would
    // teach a reader to skip the section that matters on the specs that do.
    ...(status.importCarriedApprovals.length === 0
      ? []
      : sectionLines(
          "import-carried subjects",
          status.importCarriedApprovals,
          disclosure.importCarriedApprovals,
          (approval) => [`  ${approval.gate}: ${approval.subject}`],
        )),
    "revision sign-off:",
    ...signOffLines(status.revisionSignOff),
    // The feedback half of the review loop: without this line, an agent
    // reading status waits on approvals a commenting reviewer is withholding.
    ...(status.openComments === null
      ? []
      : [
          `open review threads: ${status.openComments.openThreadCount}${status.openComments.openBlockingThreadCount > 0 ? ` (${status.openComments.openBlockingThreadCount} blocking)` : ""} on ${status.openComments.subjects.join(", ")}`,
          `  read: cctl spec comments ${status.slug} --open`,
        ]),
    ...sectionLines(
      "open questions",
      status.openQuestions,
      disclosure.openQuestions,
      (question) => [`  ${question.handle}: ${question.text}`],
    ),
    ...sectionLines(
      "assumptions",
      status.assumptions,
      disclosure.assumptions,
      (assumption) => [
        `  ${assumption.handle} [${assumption.disposition}]: ${assumption.text}`,
      ],
    ),
    ...sectionLines(
      "plan tasks",
      status.taskPlan,
      disclosure.taskPlan,
      (task) => [
        `  ${task.handle}: ${task.title}`,
        `    dependencies: ${task.dependsOn.join(", ") || "none"}`,
        ...unresolvedDependencyLines(task.unresolvedDependsOnTaskElementIds),
        // Authored intent the delivery-plan author reads while placing the
        // graph, so an absent value is "not declared" — no default is derived
        // from it any more.
        `    intended lane group: ${task.laneGroup ?? "not declared"}`,
        `    intended execution lane: ${task.executionLane ?? "not declared"}`,
        `    intended touched paths: ${task.touchedPaths.join(", ") || "not declared"}`,
        `    criterion coverage: ${task.criterionCoverage.join(", ") || "none"}`,
        ...unresolvedCoverageLines(task.unresolvedCriterionElementIds),
      ],
    ),
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
  const parsed = decodeCanonicalSpecBundle(decoded);
  if (!parsed.ok) {
    logger.debug("cli.spec.integrity_mismatch", {
      against: filePath,
      mismatchKind: parsed.code,
      issuePath: parsed.issue.path,
    });
    return {
      ok: false,
      result: integrityFailure(
        parsed.message,
        parsed.instruction,
        {
          against: filePath,
          ...(parsed.code === "bundle_format_mismatch"
            ? {
                currentFormatVersion: parsed.currentFormatVersion,
                againstFormatVersion: parsed.againstFormatVersion,
              }
            : {}),
        },
        [parsed.issue],
        json,
        parsed.code,
      ),
    };
  }
  return { ok: true, value: parsed.value };
}

export async function runSpecList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "spec list", json);
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
  const denied = checkFlags(values, "spec measures", json);
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

type SpecShowView = "summary" | "outline" | "rendered" | "full";

function showRevisionRef(
  revision:
    | SpecShowOutlineView["revision"]
    | SpecSummaryView["currentRevision"],
) {
  if (revision === null) return null;
  return {
    role: "current" as const,
    id: revision.id,
    number: revision.number,
    state: revision.state,
    authoringStage: revision.authoringStage,
    basedOnRevisionId: revision.basedOnRevisionId,
  };
}

function showArtifactRevisionRef(
  revision:
    | SpecShowOutlineView["revision"]
    | SpecSummaryView["currentRevision"],
): SpecShowArtifactRevision {
  if (revision === null) return null;
  return {
    role: "current",
    number: revision.number,
    state: revision.state,
    authoringStage: revision.authoringStage,
  };
}

function showOutlineText(outline: SpecShowOutlineView): string {
  const revision = outline.revision;
  const header =
    revision === null
      ? `${outline.spec.slug}\tno revision\t${outline.phase.primary}`
      : `${outline.spec.slug}\trevision ${revision.number}\t${revision.state}\t${revision.authoringStage}`;
  const requirements = outline.requirements.flatMap((requirement) => [
    `${requirement.handle}\t${requirement.priority}\t${requirement.risk}\tapproval=${requirement.status.approval} coverage=${requirement.status.coverage} proof=${requirement.status.proof}\t${requirement.summary}`,
    ...requirement.criteria.map(
      (criterion) =>
        `  ${criterion.handle}\tcoverage=${criterion.status.coverage} proof=${criterion.status.proof}\t${criterion.summary}`,
    ),
  ]);
  const decisions = outline.decisions.map(
    (decision) =>
      `${decision.handle}\tdecision\tapproval=${decision.status.approval}\t${decision.summary}`,
  );
  const tasks = outline.tasks.map(
    (task) =>
      `${task.handle}\ttask\tstatus=${task.status.status}\t${task.summary}`,
  );
  // Sections are addressed by element id, so the id is the row's first field:
  // it is the argument `spec section get` takes, and the collection's own next
  // line names that verb rather than the outline-wide rendered artifact.
  const sections = outline.sections.map(
    (section) =>
      `${section.elementId}\tsection\t${section.role}\t${section.title}`,
  );
  const disclosure = Object.entries(outline.disclosure).flatMap(
    ([collection, value]) =>
      collection === "next" || typeof value === "string"
        ? []
        : [
            `${collection}: ${value.total} total, ${value.returned} returned, truncated=${value.truncated ? "yes" : "no"}${"next" in value ? `, next: ${value.next}` : ""}`,
          ],
  );
  return `${[
    header,
    `counts: ${outline.counts.requirements} requirements, ${outline.counts.criteria} criteria, ${outline.counts.decisions} decisions, ${outline.counts.tasks} tasks, ${outline.counts.sections} sections`,
    "requirements:",
    ...(requirements.length === 0 ? ["  none"] : requirements),
    "decisions:",
    ...(decisions.length === 0 ? ["  none"] : decisions),
    "tasks:",
    ...(tasks.length === 0 ? ["  none"] : tasks),
    "sections:",
    ...(sections.length === 0 ? ["  none"] : sections),
    "disclosure:",
    ...disclosure.map((line) => `  ${line}`),
    `next: ${outline.disclosure.next}`,
  ].join("\n")}\n`;
}

function showSummaryDisclosure(
  summary: SpecSummaryView,
): SpecShowSummaryInlineEnvelope["disclosure"] {
  const entry = (total: number) => ({
    total,
    returned: 0 as const,
    truncated: total > 0,
  });
  return {
    requirements: entry(summary.counts.requirements),
    criteria: entry(summary.counts.criteria),
    decisions: entry(summary.counts.decisions),
    tasks: entry(summary.counts.tasks),
    next: `cctl spec show ${summary.spec.slug}`,
  };
}

function showSummaryText(
  summary: SpecSummaryView,
  disclosure: SpecShowSummaryInlineEnvelope["disclosure"],
): string {
  const revision = summary.currentRevision;
  const disclosureLines = Object.entries(disclosure).flatMap(
    ([collection, value]) =>
      collection === "next" || typeof value === "string"
        ? []
        : [
            `${collection}: ${value.total} total, ${value.returned} returned, truncated=${value.truncated ? "yes" : "no"}`,
          ],
  );
  return `${[
    `${summary.spec.slug}\t${summary.phase.primary}\t${summary.spec.name}`,
    revision === null
      ? "revision: none"
      : `revision: ${revision.number} (${revision.state}, ${revision.authoringStage})`,
    `elements: ${summary.counts.requirements} requirements, ${summary.counts.criteria} criteria, ${summary.counts.decisions} decisions, ${summary.counts.tasks} tasks`,
    `approvals: ${summary.approvalState} (${summary.pendingApprovalCount} pending)`,
    `delivery: ${summary.delivery.deliveredCount}/${summary.delivery.totalInScope} delivered`,
    "disclosure:",
    ...disclosureLines.map((line) => `  ${line}`),
    `next: ${disclosure.next}`,
  ].join("\n")}\n`;
}

function showArtifactText(
  view: Extract<SpecShowView, "rendered" | "full">,
  revision: SpecShowArtifactRevision,
  artifact: SpecShowArtifact,
): string {
  return `${[
    `spec show\t${view}\t${revision === null ? "no revision" : `revision ${revision.number}`}`,
    `artifact: ${artifact.path}`,
    `format: ${artifact.format}`,
    `bytes: ${artifact.bytes}`,
    `sha256: ${artifact.sha256}`,
  ].join("\n")}\n`;
}

function showSpillText(
  view: Extract<SpecShowView, "summary" | "outline">,
  artifact: SpecShowArtifact,
): string {
  return `${[
    `spec show\t${view}\tstdout budget exceeded`,
    `artifact: ${artifact.path}`,
    `format: ${artifact.format}`,
    `bytes: ${artifact.bytes}`,
    `sha256: ${artifact.sha256}`,
  ].join("\n")}\n`;
}

function defaultShowArtifactStem(slug: string): string {
  return Buffer.byteLength(slug, "utf8") <= 120
    ? slug
    : `spec-${createHash("sha256").update(slug, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * The four-level ladder always writes when it reaches an artifact level, so
 * the destination is either the caller's `--out`/derived path or a digest-named
 * spill file; the shared primitive owns the write, the byte count, and the
 * content digest the receipt publishes.
 */
async function writeSpecArtifact(
  host: CliHost,
  content: string,
  destination: {
    /** The verb the refusal names, so the caller knows which read failed. */
    readonly command: string;
    readonly format: SpecShowArtifact["format"];
    readonly reason: ArtifactManifest["reason"];
    readonly path?: string;
    readonly namePrefix?: string;
    /** The act that recovers a failed write, where the verb has one. */
    readonly writeFailedInstruction?: string;
  },
  json: boolean,
): Promise<ReadResult<SpecShowArtifact>> {
  const outcome = await emitLarge(host, content, {
    format: destination.format,
    force: destination.reason,
    ...(destination.path === undefined ? {} : { path: destination.path }),
    ...(destination.namePrefix === undefined
      ? {}
      : { namePrefix: destination.namePrefix }),
  });
  if (outcome.kind === "unwritable") {
    return {
      ok: false,
      result:
        outcome.reason === "host_cannot_write"
          ? failure({
              exitCode: EXIT_OPERATION_FAILED,
              message: `${destination.command}: this CLI host cannot write artifact files`,
              code: "write_unavailable",
              json,
            })
          : failure({
              exitCode: EXIT_OPERATION_FAILED,
              message: `${destination.command}: could not write ${JSON.stringify(outcome.path)}`,
              code: "write_failed",
              ...(destination.writeFailedInstruction === undefined
                ? {}
                : { instruction: destination.writeFailedInstruction }),
              json,
            }),
    };
  }
  return {
    ok: true,
    value: {
      path: outcome.manifest.path,
      format: destination.format,
      bytes: outcome.manifest.bytes,
      sha256: outcome.manifest.sha256,
    },
  };
}

type InlineShowEnvelope =
  | SpecShowOutlineInlineEnvelope
  | SpecShowSummaryInlineEnvelope;

async function boundedInlineShowResult(input: {
  readonly host: CliHost;
  readonly json: boolean;
  readonly view: Extract<SpecShowView, "summary" | "outline">;
  readonly text: string;
  readonly envelope: InlineShowEnvelope;
}): Promise<{ result: CliResult; spilled: boolean }> {
  const structured = `${JSON.stringify(input.envelope)}\n`;
  const selected = render(input.json, input.text, input.envelope);
  const largestInlineBytes = Math.max(
    Buffer.byteLength(structured, "utf8"),
    Buffer.byteLength(input.text, "utf8"),
  );
  if (largestInlineBytes < SPEC_SHOW_STDOUT_BUDGET_BYTES) {
    return {
      result: { exitCode: EXIT_OK, stdout: selected, stderr: "" },
      spilled: false,
    };
  }

  const content = `${JSON.stringify(input.envelope, null, 2)}\n`;
  const written = await writeSpecArtifact(
    input.host,
    content,
    {
      command: "spec show",
      format: "json",
      // The budget was measured against the selected serialization, which this
      // pretty-printed spill is not identical to, so the reason is stated here
      // rather than re-derived from the artifact's own size.
      reason: "stdout_budget_exceeded",
      namePrefix: `spec-${input.view}`,
      writeFailedInstruction: "Name a writable file with --out and retry.",
    },
    input.json,
  );
  if (!written.ok) return { result: written.result, spilled: false };
  const receipt =
    input.view === "outline"
      ? specShowOutlineSpillEnvelopeSchema.parse({
          ok: true,
          command: "spec show",
          view: input.view,
          storage: "artifact",
          reason: "stdout_budget_exceeded",
          artifact: written.value,
        })
      : specShowSummarySpillEnvelopeSchema.parse({
          ok: true,
          command: "spec show",
          view: input.view,
          storage: "artifact",
          reason: "stdout_budget_exceeded",
          artifact: written.value,
        });
  const stdout = render(
    input.json,
    showSpillText(input.view, written.value),
    receipt,
  );
  if (Buffer.byteLength(stdout, "utf8") >= SPEC_SHOW_STDOUT_BUDGET_BYTES) {
    return {
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "spec show: bounded artifact receipt exceeded its invariant",
        code: "receipt_budget_exceeded",
        json: input.json,
      }),
      spilled: false,
    };
  }
  return {
    result: { exitCode: EXIT_OK, stdout, stderr: "" },
    spilled: true,
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
  const denied = checkFlags(values, "spec show", json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "show", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "show", json);
  if (!slug.ok) return slug.result;
  const selectedLevels = ["summary", "rendered", "full"].filter(
    (name) => values[name] === "true",
  );
  if (selectedLevels.length > 1) {
    return usageFailure(
      "spec show: pass at most one of --summary, --rendered, or --full",
      json,
    );
  }
  const rendered = values["rendered"] === "true";
  const full = values["full"] === "true";
  const out = values["out"];
  if (out !== undefined && !rendered && !full) {
    return usageFailure("spec show: --out requires --rendered or --full", json);
  }
  if (
    out !== undefined &&
    Buffer.byteLength(out, "utf8") > SPEC_SHOW_OUT_PATH_BUDGET_BYTES
  ) {
    return usageFailure(
      `spec show: --out path exceeds ${SPEC_SHOW_OUT_PATH_BUDGET_BYTES} bytes`,
      json,
    );
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const summary = values["summary"] === "true";
  if (summary) {
    const response = await requestTyped(
      host,
      resolved.context,
      `${specBasePath(resolved.context, slug.value)}/summary`,
      specSummaryViewSchema,
      "show",
      json,
    );
    if (!response.ok) return response.result;
    const disclosure = showSummaryDisclosure(response.value);
    const envelope = specShowSummaryInlineEnvelopeSchema.parse({
      ok: true,
      command: "spec show",
      view: "summary" as const,
      storage: "inline",
      spec: {
        id: response.value.spec.id,
        slug: response.value.spec.slug,
        name: response.value.spec.name,
      },
      revision: showRevisionRef(response.value.currentRevision),
      phase: response.value.phase,
      counts: response.value.counts,
      pendingApprovalCount: response.value.pendingApprovalCount,
      approvalState: response.value.approvalState,
      delivery: {
        allWaived: response.value.delivery.allWaived,
        deliveredCount: response.value.delivery.deliveredCount,
        provenCount: response.value.delivery.provenCount,
        totalInScope: response.value.delivery.totalInScope,
        deliveredExternallyCount:
          response.value.delivery.deliveredExternallyCriterionIds.length,
      },
      linkedWork: response.value.linkedWork,
      imported: response.value.imported,
      disclosure,
    });
    const output = await boundedInlineShowResult({
      host,
      json,
      view: "summary",
      text: showSummaryText(response.value, disclosure),
      envelope,
    });
    logger.debug("cli.spec.read_complete", {
      command: "show",
      slug: slug.value,
      view: "summary",
      wroteOutput: output.spilled,
    });
    return output.result;
  }

  if (!rendered && !full) {
    const response = await requestTyped(
      host,
      resolved.context,
      `${specBasePath(resolved.context, slug.value)}/outline`,
      specShowOutlineViewSchema,
      "show",
      json,
    );
    if (!response.ok) return response.result;
    const envelope = specShowOutlineInlineEnvelopeSchema.parse({
      ok: true,
      command: "spec show",
      view: "outline",
      storage: "inline",
      ...response.value,
    });
    const output = await boundedInlineShowResult({
      host,
      json,
      view: "outline",
      text: showOutlineText(response.value),
      envelope,
    });
    logger.debug("cli.spec.read_complete", {
      command: "show",
      slug: slug.value,
      view: "outline",
      wroteOutput: output.spilled,
      returnedRequirementCount: response.value.requirements.length,
      returnedCriterionCount: response.value.disclosure.criteria.returned,
    });
    return output.result;
  }

  const response = await requestTyped(
    host,
    resolved.context,
    specBasePath(resolved.context, slug.value),
    specDetailViewSchema,
    "show",
    json,
  );
  if (!response.ok) return response.result;
  const current = response.value.currentRevision;
  const view = rendered ? "rendered" : "full";
  let content: string;
  let path: string;
  if (rendered) {
    if (current === null) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message:
          "spec show: the requested spec has no current revision to render",
        code: "no_current_revision",
        json,
      });
    }
    content = renderRevisionMarkdown(response.value.spec, current);
    path =
      out ??
      `.cc/temp/${defaultShowArtifactStem(response.value.spec.slug)}-revision-${current.revision.number}.md`;
  } else {
    content = `${JSON.stringify(response.value, null, 2)}\n`;
    path =
      out ??
      `.cc/temp/${defaultShowArtifactStem(response.value.spec.slug)}-spec-detail.json`;
  }
  const written = await writeSpecArtifact(
    host,
    content,
    {
      command: "spec show",
      format: rendered ? "markdown" : "json",
      reason: "requested",
      path,
      writeFailedInstruction: "Name a writable file with --out and retry.",
    },
    json,
  );
  if (!written.ok) return written.result;
  const revision = showArtifactRevisionRef(current?.revision ?? null);
  logger.debug("cli.spec.read_complete", {
    command: "show",
    slug: slug.value,
    view,
    wroteOutput: true,
    artifactBytes: written.value.bytes,
  });
  const envelope = specShowArtifactEnvelopeSchema.parse({
    ok: true,
    command: "spec show",
    view,
    storage: "artifact",
    revision,
    artifact: written.value,
  });
  const stdout = render(
    json,
    showArtifactText(view, revision, written.value),
    envelope,
  );
  if (Buffer.byteLength(stdout, "utf8") >= SPEC_SHOW_STDOUT_BUDGET_BYTES) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "spec show: bounded artifact receipt exceeded its invariant",
      code: "receipt_budget_exceeded",
      json,
    });
  }
  return {
    exitCode: EXIT_OK,
    stdout,
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
  const denied = checkFlags(values, "spec status", json);
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

  // --full is the one level that carries every row; the default reports the
  // rows its own text sections print and accounts for the rest.
  const full = values["full"] !== undefined;
  const bounded = boundStatus(
    response.value,
    executions,
    full ? EVERY_ROW : STATUS_SECTION_LIMIT,
  );
  const projection = {
    ok: true,
    command: "spec status",
    view: full ? "full" : "bounded",
    storage: "inline",
    status: bounded.status,
    executions: bounded.executions.map((execution) => {
      const progress = describeExecution(execution);
      return {
        id: execution.id,
        state: execution.state,
        workflowSeedSource: execution.workflowSeedSource,
        workflowExecutionId: execution.workflowExecutionId,
        workflowStatus: execution.workflowStatus,
        laneState: progress.laneState,
        actsNext: progress.actsNext,
      };
    }),
    ...(full ? {} : { disclosure: bounded.disclosure }),
  };
  const envelope = full
    ? specStatusFullEnvelopeSchema.parse(projection)
    : specStatusBoundedEnvelopeSchema.parse(projection);
  return await statusResult({
    host,
    json,
    view: full ? "full" : "bounded",
    text: statusText(bounded),
    envelope,
  });
}

/**
 * Emit a status projection against the shared stdout budget. Either level can
 * outgrow a pipe — a spec with a hundred plan tasks does at the bounded level
 * too — so both spill to the artifact the receipt names rather than truncating
 * an envelope mid-stream.
 */
async function statusResult(input: {
  readonly host: CliHost;
  readonly json: boolean;
  readonly view: "bounded" | "full";
  readonly text: string;
  readonly envelope: JsonEnvelope;
}): Promise<CliResult> {
  const structured = `${JSON.stringify(input.envelope)}\n`;
  const largestInlineBytes = Math.max(
    Buffer.byteLength(structured, "utf8"),
    Buffer.byteLength(input.text, "utf8"),
  );
  if (largestInlineBytes < SPEC_SHOW_STDOUT_BUDGET_BYTES) {
    return {
      exitCode: EXIT_OK,
      stdout: render(input.json, input.text, input.envelope),
      stderr: "",
    };
  }
  const written = await writeSpecArtifact(
    input.host,
    `${JSON.stringify(input.envelope, null, 2)}\n`,
    {
      command: "spec status",
      format: "json",
      // The budget was measured against the selected serialization, which this
      // pretty-printed spill is not identical to.
      reason: "stdout_budget_exceeded",
      namePrefix: `spec-status-${input.view}`,
    },
    input.json,
  );
  if (!written.ok) return written.result;
  const receipt = specStatusSpillEnvelopeSchema.parse({
    ok: true,
    command: "spec status",
    view: input.view,
    storage: "artifact",
    reason: "stdout_budget_exceeded",
    artifact: written.value,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(
      input.json,
      `${[
        `spec status\t${input.view}\tstdout budget exceeded`,
        `artifact: ${written.value.path}`,
        `format: ${written.value.format}`,
        `bytes: ${written.value.bytes}`,
        `sha256: ${written.value.sha256}`,
      ].join("\n")}\n`,
      receipt,
    ),
    stderr: "",
  };
}

function commentAuthorLabel(comment: SpecCommentView): string {
  if (comment.author === null) return "unattributed";
  return comment.author.kind === "human"
    ? "human"
    : `agent ${comment.author.conversationId}`;
}

function commentLines(comment: SpecCommentView): string[] {
  const marker = comment.blocking ? " [blocking]" : "";
  const revision =
    comment.revisionNumber === null ? "" : ` rev ${comment.revisionNumber}`;
  const lines = [
    `${comment.handle ?? comment.elementId}  ${comment.resolution}${marker}  by ${commentAuthorLabel(comment)}${revision}  thread ${comment.threadId}`,
  ];
  if (comment.quote !== null) {
    lines.push(`  > ${comment.quote}`);
  }
  lines.push(
    ...comment.body.split("\n").map((bodyLine) => `  ${bodyLine}`),
    "",
  );
  return lines;
}

function commentsText(slug: string, view: SpecCommentsView): string {
  const header = `${slug}  comments: ${countOf(view.comments.length, "message row")} shown, ${countOf(view.openThreadCount, "open thread")} (${countOf(view.openCount, "open message row")}${view.openBlockingCount > 0 ? `, ${countOf(view.openBlockingCount, "blocking message row")}` : ""})`;
  if (view.comments.length === 0) {
    return `${header}\n`;
  }
  return [header, "", ...view.comments.flatMap(commentLines)].join("\n");
}

export async function runSpecComments(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "spec comments", json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "comments", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "comments", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const query = new URLSearchParams();
  const element = values["element"];
  if (element !== undefined) query.set("element", element);
  if (values["open"] === "true") query.set("open", "true");
  const queryString = query.size === 0 ? "" : `?${query.toString()}`;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/comments${queryString}`,
    specCommentsViewSchema,
    "comments",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "comments",
    slug: slug.value,
    returnedCount: response.value.comments.length,
    openCount: response.value.openCount,
    openBlockingCount: response.value.openBlockingCount,
    openThreadCount: response.value.openThreadCount,
    openBlockingThreadCount: response.value.openBlockingThreadCount,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, commentsText(slug.value, response.value), {
      ok: true,
      specId: response.value.specId,
      slug: response.value.slug,
      comments: response.value.comments,
      openCount: response.value.openCount,
      openBlockingCount: response.value.openBlockingCount,
      openThreadCount: response.value.openThreadCount,
      openBlockingThreadCount: response.value.openBlockingThreadCount,
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
  const denied = checkFlags(values, "spec lint", json);
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
  // Lint panel read — grouping and what counts as blocking are decided once.
  const health = draftHealth(response.value.findings);
  logger.debug("cli.spec.read_complete", {
    command: "lint",
    slug: slug.value,
    findingCount: health.total,
    blockingCount: health.blocking,
  });
  const envelope = specLintEnvelopeSchema.parse({
    ok: true,
    lint: {
      revisionId: response.value.revisionId,
      total: health.total,
      blocking: health.blocking,
      counts: health.counts,
      groups: health.groups,
    },
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, lintText(slug.value, health), envelope),
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

function specGetTextValue(value: string | number | boolean | null): string {
  if (value === null) return "none";
  return String(value).replace(/\n/gu, "\n  ");
}

/**
 * A complete line-oriented representation of one typed response. `spec get`
 * is already the narrowest read in the disclosure ladder, so text mode keeps
 * every field and row that JSON carries; it changes representation, not depth.
 */
function specGetFieldLines(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}: none`];
    return value.flatMap((item, index) =>
      specGetFieldLines(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${path}: none`];
    return entries.flatMap(([field, item]) =>
      specGetFieldLines(item, path.length === 0 ? field : `${path}.${field}`),
    );
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return [`${path}: ${specGetTextValue(value)}`];
  }
  return [`${path}: unavailable`];
}

function specGetText(response: SpecElementGetResponse): string {
  let header: string;
  if ("question" in response) {
    header = `${response.slug}/${response.handle}\tquestion\t${response.question.status}`;
  } else if ("assumption" in response) {
    header = `${response.slug}/${response.handle}\tassumption\t${response.assumption.disposition}`;
  } else {
    const payload = response.element.version.payload;
    header = `${response.slug}/${response.handle}\t${payload.kind}\trevision ${response.revision.number} (${response.revision.state}, ${response.revision.authoringStage})`;
  }
  return `${[header, ...specGetFieldLines(response, "")].join("\n")}\n`;
}

/**
 * One `--revision` flag carries both selectors an agent can hold: the number
 * every receipt and refusal names, and the opaque id a Studio link carries. A
 * revision number is always a positive integer with no leading zero, and no
 * revision id takes that shape, so the value's own digits decide which query
 * the route is asked — the caller never has to say which kind it holds.
 */
function revisionQuery(revision: string | undefined): string {
  if (revision === undefined) return "";
  const key = /^[1-9][0-9]*$/u.test(revision) ? "revisionNumber" : "revisionId";
  return `?${new URLSearchParams({ [key]: revision }).toString()}`;
}

export async function runSpecGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "spec get", json);
  if (denied) return denied;
  const target = parseGetTarget(rest, json);
  if (!target.ok) return target.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, target.value.slug)}/elements/${encodePathSegment(target.value.handle)}${revisionQuery(values["revision"])}`,
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
  // The content-element view nests the durable snapshot row, so the id sits
  // three `element` levels deep (envelope.element.element.element.id). The
  // identity every script wants is hoisted beside the view rather than
  // reshaping the row the snapshot surfaces share (#60).
  const identity =
    "element" in response.value && "version" in response.value.element
      ? {
          elementId: response.value.element.element.id,
          kind: response.value.element.element.kind,
          elementVersion: response.value.element.version.elementVersion,
        }
      : {};
  const envelope = specGetEnvelopeSchema.parse({
    ok: true,
    element: response.value,
    ...identity,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, specGetText(response.value), envelope),
    stderr: "",
  };
}

const SECTION_GET_SHAPE = "cctl spec section get <slug> --id <element-id>";

/**
 * Sections are the one element kind with no handle, so this read takes the
 * stable element id `spec show` publishes. Text is depth-complete for the same
 * reason `spec get` is: it is already the narrowest read, so representation
 * changes and depth does not.
 */
export async function runSpecSectionGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "spec section get", json);
  if (denied) return denied;
  if (rest.length !== 1) {
    return usageFailure(
      `spec section get takes one <slug> — ${SECTION_GET_SHAPE}`,
      json,
    );
  }
  const slug = validateSlug(rest[0], "section get", json);
  if (!slug.ok) return slug.result;
  const elementId = values["id"];
  if (elementId === undefined) {
    return usageFailure(
      `spec section get requires --id; sections have no handle, so their element id is the address — ${SECTION_GET_SHAPE}. Read the ids with \`cctl spec show ${slug.value}\`.`,
      json,
    );
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/sections/${encodePathSegment(elementId)}${revisionQuery(values["revision"])}`,
    specSectionViewSchema,
    "section get",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "section get",
    slug: slug.value,
    elementId,
    revisionNumber: response.value.revision.number,
  });
  const envelope = specSectionGetEnvelopeSchema.parse({
    ok: true,
    section: response.value,
  });
  const view = response.value;
  const header = `${view.elementId}\tsection\t${view.role}\trevision ${view.revision.number} (${view.revision.state}, ${view.revision.authoringStage})`;
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${[header, ...specGetFieldLines(view, "")].join("\n")}\n`,
      envelope,
    ),
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
  const denied = checkFlags(values, "spec search", json);
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
  const denied = checkFlags(values, "spec diff", json);
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
      result: invalidResponseFailure({
        what: "spec export's manifest",
        issues: parsed.error.issues,
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
  const denied = checkFlags(values, "spec export", json);
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
 * The delivery-plan attempt has two stages with distinct promises: `draft`
 * reads what is editable right now (never approvable), while `proposed` reads
 * the frozen candidate byte for byte — its
 * `candidateHash` is what an approval binds to and what a launch verifies.
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
      `spec plan preview --stage takes draft or proposed, not ${JSON.stringify(stage)} — \`draft\` reads the editable document, \`proposed\` reads the frozen candidate`,
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
    hasLaunch: preview.launch !== null,
    approvable: preview.approvable,
  });
  // --outline: the launch envelope read through the graph's own outline
  // renderer instead of whole (#80 I-18) — a real delivery plan's envelope runs
  // to tens of kilobytes, and the outline is the same navigation map
  // `cctl workflow get` prints for the definition this launch becomes. The
  // attempt's draft revision stands in for the definition revision the launch
  // does not have yet.
  const outlineRecord =
    values["outline"] === undefined
      ? null
      : parseOutlineRecord({
          id: preview.launch.layout.workflowId,
          name: preview.launch.name,
          revision: preview.draftRevision,
          definition: preview.launch.definition,
        });
  if (outlineRecord) {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, renderOutline(outlineRecord), {
        ok: true,
        outline: buildOutlineData(outlineRecord),
      }),
      stderr: "",
    };
  }
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
  const denied = checkFlags(values, "spec plan preview", json);
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
      `spec plan preview: ${retiredDetail}. Read authored content with \`cctl spec plan preview ${slug.value} --stage draft\`, or read the finalized candidate with \`cctl spec plan preview ${slug.value} --stage proposed\`.`,
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
  const denied = checkFlags(values, "spec verify", json);
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
      "Inspect the reported revision mismatch and resolve it in the authoritative spec store, then export a fresh bundle and verify again.",
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
    const comparison = compareCanonicalSpecBundles(
      current.value,
      against.value,
    );
    if (!comparison.ok) {
      logger.debug("cli.spec.integrity_mismatch", {
        slug: slug.value,
        against: againstPath ?? null,
        mismatchKind: comparison.code,
      });
      return integrityFailure(
        comparison.code === "bundle_format_mismatch"
          ? comparison.message
          : `spec ${slug.value} differs from ${againstPath}`,
        comparison.instruction,
        {
          against: againstPath,
          ...(comparison.code === "bundle_format_mismatch"
            ? {
                currentFormatVersion: comparison.currentFormatVersion,
                againstFormatVersion: comparison.againstFormatVersion,
              }
            : {}),
        },
        [comparison.issue],
        json,
        comparison.code,
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
      : `${projection.specSlug}: revision ${projection.current.revisionNumber} vs ${compared.workflowExecutionId === null ? "an execution with no workflow lane" : `execution ${compared.workflowExecutionId}`} (pinned revision ${projection.base?.revisionNumber ?? "unknown"}, ${compared.state}${
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
  const denied = checkFlags(values, "spec delta", json);
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
  const denied = checkFlags(values, `spec ${command}`, json);
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
  const lines =
    view.health.total === 0
      ? ["plan findings: 0 total, 0 blocking"]
      : [
          `plan findings: ${view.health.total} total, ${view.health.blocking} blocking`,
          ...view.health.counts.map(
            (entry) => `  ${entry.severity}: ${entry.count}`,
          ),
        ];
  return view.health.blocking === 0
    ? [...lines, "propose: nothing refuses"]
    : lines;
}

function planStatusText(view: DeliveryPlanView): string {
  const attempt = view.attempt;
  const wholeStatus = `cctl spec plan status ${attempt.specSlug} --json`;
  const lines = [
    `${attempt.specSlug}  plan attempt ${attempt.id}  status: ${attempt.status}`,
    `pinned revision: ${attempt.pinnedRevisionId}  draft revision: ${attempt.draftRevision}`,
    `delta basis: ${attempt.deltaBasisExecutionId ?? "none — nothing has delivered yet"}`,
    ...(attempt.candidateHash === null
      ? []
      : [`live proposal: ${attempt.candidateId} at ${attempt.candidateHash}`]),
    ...(view.approval === null
      ? []
      : [
          `approved: snapshot ${view.approval.snapshotId}, candidate ${view.approval.candidateId} at ${view.approval.candidateHash}`,
        ]),
    ...planHealthLines(view),
    ...deliveryPlanLedgerLines(view.ledger),
    ...boundedSection(
      "blocking findings",
      view.health.findings.filter(
        (finding) => finding.severity === "blocks_propose",
      ),
      `cctl spec lint ${attempt.specSlug}`,
      (finding) => [
        `  ${finding.elementHandle} [${finding.ruleId}]: ${finding.message}`,
      ],
    ),
    // The ledger already reports every disposition by kind, so the section that
    // repeated the same counts is gone; what it could not carry is the act each
    // criterion still owes, which is what these rows are.
    ...boundedSection(
      "unresolved criteria",
      view.unresolved,
      wholeStatus,
      (row) => [`  ${row.handle} [${row.disposition}]: ${row.resolution}`],
    ),
    ...boundedSection(
      "proposal snapshots",
      view.snapshots,
      wholeStatus,
      (snapshot) => [
        `  ${snapshot.draftRevision}: ${snapshot.candidateId} at ${snapshot.candidateHash} (${snapshot.proposedAt})`,
      ],
    ),
    ...planNextActLines(view),
  ];
  return `${lines.join("\n")}\n`;
}

function planGetText(view: DeliveryPlanView): string {
  const { document } = view;
  const wholeDocument = `cctl spec plan get ${view.attempt.specSlug} --json`;
  const lines = [
    `${view.attempt.specSlug}  plan attempt ${view.attempt.id} (${view.attempt.status}, draft revision ${view.attempt.draftRevision})`,
    `workflow definition: ${view.attempt.workflowDefinitionId}`,
    ...boundedSection(
      "binding dispositions",
      document.binding.dispositions,
      wholeDocument,
      (entry) => [
        `  ${entry.criterionElementId}: ${entry.disposition}${
          entry.deliveredByExecutionId === null
            ? ""
            : ` (by ${entry.deliveredByExecutionId})`
        }`,
      ],
    ),
    ...boundedSection(
      "binding claims",
      document.binding.claims,
      wholeDocument,
      (claim) => [
        `  ${claim.contextId}: ${claim.criterionElementIds.join(", ") || "no criterion"}`,
      ],
    ),
    // The rendering is bounded by design; the whole document is one --json read
    // away, and saying so is what keeps a truncated section from reading as the
    // whole plan.
    `full document: ${wholeDocument}`,
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
    workflowDefinitionId: view.attempt.workflowDefinitionId,
    bindingClaimCount: view.document.binding.claims.length,
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
