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
import {
  approvalLedgerLines,
  gateLines,
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
  if (full) return { view: "full" as const, status };
  const reveal = invocation(specStatusCommand, {
    args: { slug: status.slug },
    flags: explicitScopeFlags(app),
    level: "full",
  });
  const pendingApprovals = boundSpecRows(status.pendingApprovals, reveal);
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
    disclosure: {
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
  return quoteLiteralText(
    [
      status.slug + "; phase: " + status.phase.primary,
      ...(status.currentRevision
        ? [
            "Authoring revision: " +
              status.currentRevision.number +
              " (" +
              status.currentRevision.state +
              ", " +
              status.currentRevision.authoringStage +
              ")",
          ]
        : ["Authoring revision: none"]),
      ...gateLines(status.gates),
      ...approvalLedgerLines(status.approvalLedger),
      ...(status.pendingBlock ? [status.pendingBlock.instruction] : []),
      ...signOffLines(status.revisionSignOff),
      ...(status.nextAction ? [status.nextAction.instruction] : []),
    ].join("\n") + "\n",
  );
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
