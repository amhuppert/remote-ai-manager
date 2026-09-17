import { quoteLiteralText } from "../../framework/literal-text";
import { boundSpecRows } from "./native-disclosure";
import { renderInvocation } from "cli-for-agents/runtime";
import {
  binaryArtifact,
  invocation,
  runner,
  type CommandSpec,
  type HandlerInput,
  type ReadHandler,
  type JsonData,
} from "cli-for-agents";
import { renderRevisionMarkdown } from "@/lib/specs/export";
import {
  specDetailViewSchema,
  specShowOutlineViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
  type SpecStatusView,
} from "@/lib/specs/view-schemas";
import { explicitScopeFlags, type CcErrorCode } from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  specStatusCommand,
  specShowCommand,
  type specStatusSpec,
  type specShowSpec,
} from "./native-definitions";
import { describeExecution, isActiveExecution } from "./execution-progress";
import {
  approvalLedgerLines,
  gateLines,
  pendingBlockLines,
  signOffLines,
} from "./projection-text";
import { readSpecJson, specPath } from "./native-request";

type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;

function projectStatus(
  status: SpecStatusView,
  full: boolean,
  app: CcApplication,
) {
  const executions = status.executions
    .filter(isActiveExecution)
    .map((execution) => ({ ...execution, ...describeExecution(execution) }));
  if (full) return { view: "full" as const, status, executions };
  const reveal = invocation(specStatusCommand, {
    args: { slug: status.slug },
    flags: explicitScopeFlags(app),
    level: "full",
  });
  const boundedExecutions = boundSpecRows(executions, reveal);
  const pendingApprovals = boundSpecRows(status.pendingApprovals, reveal);
  const deliveryBlockers = boundSpecRows(
    status.deliveryReadiness?.blockers ?? [],
    reveal,
  );
  const importCarriedApprovals = boundSpecRows(
    status.importCarriedApprovals,
    reveal,
  );
  const approvalLedgerSubjects = boundSpecRows(
    status.approvalLedger.subjects,
    reveal,
  );
  const openQuestions = boundSpecRows(status.openQuestions, reveal);
  const assumptions = boundSpecRows(status.assumptions, reveal);
  const show = invocation(specShowCommand, {
    args: { slug: status.slug },
    flags: explicitScopeFlags(app),
  });
  const taskPlan = boundSpecRows(status.taskPlan, show);
  return {
    view: "bounded" as const,
    revealCommands: {
      status: renderInvocation(reveal, "cctl"),
      show: renderInvocation(show, "cctl"),
    },
    status: {
      ...status,
      ...(status.deliveryReadiness
        ? {
            deliveryReadiness: {
              ...status.deliveryReadiness,
              blockers: deliveryBlockers.items,
            },
          }
        : {}),
      executions: boundedExecutions.items,
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
      deliveryBlockers: deliveryBlockers.omission,
      pendingApprovals: pendingApprovals.omission,
      importCarriedApprovals: importCarriedApprovals.omission,
      approvalLedgerSubjects: approvalLedgerSubjects.omission,
      openQuestions: openQuestions.omission,
      assumptions: assumptions.omission,
      taskPlan: taskPlan.omission,
    },
  };
}

type StatusData = ReturnType<typeof projectStatus>;
function statusText(data: JsonData<StatusData>): string {
  const status = data.status;
  const lines = [
    `${status.slug}; phase: ${status.phase.primary}`,
    ...(status.phase.authoringStage
      ? [`Authoring stage: ${status.phase.authoringStage}`]
      : []),
    ...(status.authoringSequence
      ? [
          `Remaining authoring stages: ${status.authoringSequence.stages.map((stage) => `${stage.stage} (${stage.concludedBy}${stage.requiresHumanSignOff ? "; human sign-off" : ""})`).join(" → ")}`,
          `Next transition: ${status.authoringSequence.nextTransition.action}; consulted gates ${status.authoringSequence.nextTransition.consultedGates.map((gate) => `${gate.gate} (${gate.dial})`).join(", ") || "none"}`,
        ]
      : []),
    `Coverage: ${status.coverage.coveredCriteria}/${status.coverage.totalCriteria} current-revision criteria (${status.coverage.percentage}%)`,
    ...(status.draftHealth
      ? [
          `Lint findings: ${status.draftHealth.total} total, ${status.draftHealth.blocking} blocking`,
          ...status.draftHealth.top.map(
            (finding) => `  ${finding.elementHandle}: ${finding.message}`,
          ),
          `Complete lint: cctl spec lint ${status.slug}`,
        ]
      : []),
    ...data.executions.map(
      (execution) =>
        `Execution ${execution.id}: ${execution.laneState}; ${execution.detail}${execution.actsNext ? `; acts next: ${execution.actsNext}` : ""}`,
    ),
    ...(status.deliveryReadiness
      ? [
          `Delivery review: ${status.deliveryReadiness.settled}/${status.deliveryReadiness.totalInScope} criteria settled; ${status.deliveryReadiness.approvalGranted ? "approved" : "approval not recorded"}`,
          ...status.deliveryReadiness.blockers.map(
            (blocker) => `  ${blocker.kind}: ${blocker.reason}`,
          ),
        ]
      : []),
    "Gates:",
    ...gateLines(status.gates),
    ...approvalLedgerLines(status.approvalLedger),
    ...status.approvalLedger.subjects.map(
      (subject) =>
        `  ${subject.gate} ${subject.subject}: ${subject.classification}`,
    ),
    `Pending subject approvals: ${status.pendingApprovals.length}`,
    ...status.pendingApprovals.map(
      (approval) => `  ${approval.gate}: ${approval.subject}`,
    ),
    ...status.importCarriedApprovals.map(
      (approval) =>
        `Import-carried subject (no human approval): ${approval.gate} ${approval.subject}`,
    ),
    "revision sign-off:",
    ...signOffLines(status.revisionSignOff),
    ...(status.pendingBlock
      ? [
          `acts next: ${status.pendingBlock.actsNext} — ${status.pendingBlock.display}`,
          ...pendingBlockLines(status.pendingBlock),
        ]
      : []),
    ...(status.openComments
      ? [
          `Open review threads: ${status.openComments.openThreadCount} (${status.openComments.openBlockingThreadCount} blocking) on ${status.openComments.subjects.join(", ")}`,
          `Read comments: cctl spec comments ${status.slug} --open`,
        ]
      : []),
    ...status.openQuestions.map(
      (question) => `Question ${question.handle}: ${question.text}`,
    ),
    ...status.assumptions.map(
      (assumption) =>
        `Assumption ${assumption.handle} [${assumption.disposition}]: ${assumption.text}`,
    ),
    ...status.taskPlan.flatMap((task) => [
      `Task ${task.handle}: ${task.title}`,
      `  Dependencies: ${task.dependsOn.join(", ") || "none"}; unresolved ${task.unresolvedDependsOnTaskElementIds.join(", ") || "none"}`,
      `  Intended lane group: ${task.laneGroup ?? "not declared"}; execution lane: ${task.executionLane ?? "not declared"}`,
      `  Touched paths: ${task.touchedPaths.join(", ") || "not declared"}`,
      `  Criterion coverage: ${task.criterionCoverage.join(", ") || "none"}; unresolved ${task.unresolvedCriterionElementIds.join(", ") || "none"}`,
    ]),
  ];
  if (data.disclosure)
    for (const [name, omission] of Object.entries(data.disclosure)) {
      if (!omission.truncated) continue;
      const total =
        omission.total.kind === "known" ? omission.total.count : null;
      lines.push(
        `${name}: ${omission.returned} shown; ${total === null ? "more" : total - omission.returned} omitted. Read ${name === "taskPlan" ? data.revealCommands.show : data.revealCommands.status}.`,
      );
    }
  return `${lines.join("\n")}\n`;
}

const statusRun = (full: boolean) =>
  runner<Input<typeof specStatusSpec>, StatusData, CcErrorCode>({
    async run({ app, ctx }: Input<typeof specStatusSpec>) {
      const response = await readSpecJson(
        app,
        (context) => `${specPath(context.project, ctx.args.slug)}/status`,
        specStatusViewSchema,
        ctx.args.slug,
      );
      return response.ok
        ? ({ ok: true, data: projectStatus(response.data, full, app) } as const)
        : response;
    },
    text: (data) => quoteLiteralText(statusText(data)),
  });

export const statusHandler: Read<typeof specStatusSpec> = {
  run: statusRun(false),
  levels: { full: statusRun(true) },
};

const outline = runner({
  async run({ app, ctx }: Input<typeof specShowSpec>) {
    const response = await readSpecJson(
      app,
      (context) => `${specPath(context.project, ctx.args.slug)}/outline`,
      specShowOutlineViewSchema,
      ctx.args.slug,
    );
    return response.ok
      ? ({ ok: true, data: { view: "outline", ...response.data } } as const)
      : response;
  },
});
const summary = runner({
  async run({ app, ctx }: Input<typeof specShowSpec>) {
    const response = await readSpecJson(
      app,
      (context) => `${specPath(context.project, ctx.args.slug)}/summary`,
      specSummaryViewSchema,
      ctx.args.slug,
    );
    if (!response.ok) return response;
    const view = response.data;
    return {
      ok: true,
      data: {
        view: "summary",
        spec: { id: view.spec.id, slug: view.spec.slug, name: view.spec.name },
        revision: view.currentRevision,
        phase: view.phase,
        counts: view.counts,
        pendingApprovalCount: view.pendingApprovalCount,
        approvalState: view.approvalState,
        delivery: {
          allWaived: view.delivery.allWaived,
          deliveredCount: view.delivery.deliveredCount,
          provenCount: view.delivery.provenCount,
          totalInScope: view.delivery.totalInScope,
          deliveredExternallyCount:
            view.delivery.deliveredExternallyCriterionIds.length,
        },
        linkedWork: view.linkedWork,
        imported: view.imported,
        reveal: invocation(specShowCommand, {
          args: { slug: view.spec.slug },
          flags: explicitScopeFlags(app),
        }),
      },
    } as const;
  },
});

const content = (rendered: boolean) =>
  runner({
    async run({ app, ctx }: Input<typeof specShowSpec>) {
      const response = await readSpecJson(
        app,
        (context) => specPath(context.project, ctx.args.slug),
        specDetailViewSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      const detail = response.data;
      if (rendered && detail.currentRevision === null)
        return {
          ok: false,
          error: ccErrors.error("CC_OPERATION_FAILED", {
            message: "The spec has no current revision to render.",
          }),
        } as const;
      const markdown =
        rendered && detail.currentRevision
          ? renderRevisionMarkdown(detail.spec, detail.currentRevision)
          : null;
      return {
        ok: true,
        binary: binaryArtifact({
          bytes: new TextEncoder().encode(
            markdown ?? `${JSON.stringify(detail, null, 2)}\n`,
          ),
          mediaType: rendered ? "text/markdown" : "application/json",
          basename: `${detail.spec.slug}.${rendered ? "md" : "json"}`,
          summary: {
            view: rendered ? "rendered" : "full",
            spec: detail.spec.slug,
            revision: detail.currentRevision?.revision.number ?? null,
          },
        }),
      } as const;
    },
  });

export const showHandler: Read<typeof specShowSpec> = {
  run: outline,
  levels: { summary, rendered: content(true), full: content(false) },
};
