import { quoteLiteralText } from "../../framework/literal-text";
import { z } from "zod";
import { renderInvocation } from "cli-for-agents/runtime";
import {
  invocation,
  runner,
  type CommandSpec,
  type HandlerInput,
  type ReadHandler,
  type JsonValue,
  type Invocation,
} from "cli-for-agents";
import {
  deliveryPlanPreviewViewSchema,
  deliveryPlanViewSchema,
  type DeliveryPlanView,
} from "@/lib/specs/delivery-plan-views";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { buildOutlineData, parseOutlineRecord } from "../workflow-outline";
import {
  specPlanGetCommand,
  specPlanStatusCommand,
  type specPlanGetSpec,
  type specPlanStatusSpec,
  type specPlanPreviewSpec,
} from "./native-definitions";
import { explicitScopeFlags, type CcErrorCode } from "../../framework/context";
import { boundSpecRows } from "./native-disclosure";
import { deliveryPlanLedgerLines } from "../delivery-plan-ledger";
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

// The plan contains schema-validated opaque JSON extension fields. Anchor them
// as JSON at the transport boundary, retaining their complete serialized values.
function jsonProjection(value: unknown): JsonValue {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

function projectPlan(
  view: DeliveryPlanView,
  status: boolean,
  reveal: Invocation<"read">,
) {
  const claims = boundSpecRows(view.claims, reveal);
  const dispositions = boundSpecRows(
    view.document.binding.dispositions,
    reveal,
  );
  const findings = boundSpecRows(view.health.findings, reveal);
  const unresolved = boundSpecRows(view.unresolved, reveal);
  const snapshots = boundSpecRows(view.snapshots, reveal);
  return {
    plan: {
      attempt: view.attempt,
      approval: view.approval,
      prelaunch: view.prelaunch,
      reviewStatus: view.reviewStatus,
      workflowDefinition: view.workflowDefinition,
      ledger: view.ledger,
      nextAct: view.nextAct,
      dispositionCounts: view.dispositionCounts,
      health: { ...view.health, findings: findings.items },
      unresolved: unresolved.items,
      snapshots: snapshots.items,
      ...(status
        ? {}
        : {
            claims: claims.items,
            binding: { dispositions: dispositions.items },
          }),
    },
    disclosure: {
      findings: findings.omission,
      unresolved: unresolved.omission,
      snapshots: snapshots.omission,
      ...(status
        ? {}
        : { claims: claims.omission, dispositions: dispositions.omission }),
      document: reveal,
    },
  };
}

const planTextSchema = z.object({
  plan: deliveryPlanViewSchema
    .pick({
      attempt: true,
      approval: true,
      health: true,
      ledger: true,
      nextAct: true,
      unresolved: true,
      snapshots: true,
      reviewStatus: true,
      workflowDefinition: true,
    })
    .loose(),
  disclosure: z.record(z.string(), z.unknown()).optional(),
  commands: z.object({ full: z.string(), document: z.string() }),
});
function planText(data: JsonValue): string {
  const { plan, disclosure, commands } = planTextSchema.parse(data);
  const {
    attempt,
    approval,
    health,
    ledger,
    nextAct,
    unresolved,
    snapshots,
    reviewStatus,
    workflowDefinition,
    ...details
  } = plan;
  const omitted = Object.entries(disclosure ?? {}).flatMap(([name, value]) => {
    const parsed = z
      .object({
        truncated: z.literal(true),
        returned: z.number(),
        total: z.object({ kind: z.literal("known"), count: z.number() }),
      })
      .safeParse(value);
    return parsed.success
      ? [
          `${name}: ${parsed.data.total.count} total, ${parsed.data.returned} shown; remaining rows: ${commands.full}`,
        ]
      : [];
  });
  return (
    [
      `${attempt.specSlug}  plan attempt ${attempt.id}  status: ${attempt.status}`,
      `pinned revision: ${attempt.pinnedRevisionId}  draft revision: ${attempt.draftRevision}`,
      ...(attempt.status === "draft"
        ? [
            `Editable workflow: ${workflowDefinition.id}; --expected-revision ${workflowDefinition.revision}`,
          ]
        : ["Editable workflow: none; the candidate is frozen"]),
      `acts next: ${nextAct.actor} — ${nextAct.command}`,
      `Reason: ${nextAct.reason}`,
      `Review: ${workflowDefinition.builderHref}`,
      `delta basis: ${attempt.deltaBasisExecutionId ?? "none — nothing has delivered yet"}`,
      ...(attempt.candidateHash === null
        ? []
        : [
            `signed candidate: ${attempt.candidateId} at ${attempt.candidateHash}`,
          ]),
      ...(approval === null
        ? []
        : [
            `approved: snapshot ${approval.snapshotId}, candidate ${approval.candidateId} at ${approval.candidateHash}`,
          ]),
      `Structural validation: ${health.blocking === 0 ? "valid" : "blocked"}; ${health.total} findings, ${health.blocking} blocking`,
      `Semantic review: ${reviewStatus.state}${reviewStatus.state === "unreviewed" ? "" : `; conversation ${reviewStatus.reviewerConversationId} at ${reviewStatus.reviewedAt}`}`,
      ...(health.blocking === 0 ? ["propose: nothing refuses"] : []),
      ...deliveryPlanLedgerLines(ledger),
      ...health.findings.map(
        (finding) =>
          `${finding.elementHandle} [${finding.ruleId}]: ${finding.message}`,
      ),
      ...unresolved.map(
        (row) => `${row.handle} [${row.disposition}]: ${row.resolution}`,
      ),
      ...snapshots.map(
        (snapshot) =>
          `${snapshot.draftRevision}: ${snapshot.candidateId} at ${snapshot.candidateHash} (${snapshot.proposedAt})`,
      ),
      ...(Object.keys(details).length
        ? [`Plan details:\n${JSON.stringify(details, null, 2)}`]
        : []),
      ...omitted,
      `Complete plan: ${commands.document}`,
    ].join("\n") + "\n"
  );
}

const planRun = (status: boolean, full: boolean) =>
  runner<
    Input<typeof specPlanGetSpec> | Input<typeof specPlanStatusSpec>,
    JsonValue,
    CcErrorCode
  >({
    async run({
      app,
      ctx,
    }: Input<typeof specPlanGetSpec> | Input<typeof specPlanStatusSpec>) {
      const response = await readSpecJson(
        app,
        (context) => `${specPath(context.project, ctx.args.slug)}/plan`,
        deliveryPlanViewSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      const target = {
        args: { slug: response.data.attempt.specSlug },
        flags: explicitScopeFlags(app),
        level: "full" as const,
      };
      const document = invocation(specPlanGetCommand, target);
      const reveal = status
        ? invocation(specPlanStatusCommand, target)
        : document;
      return {
        ok: true,
        data: jsonProjection({
          ...(full
            ? { plan: response.data }
            : projectPlan(response.data, status, reveal)),
          commands: {
            full: renderInvocation(reveal, "cctl"),
            document: renderInvocation(document, "cctl"),
          },
        }),
      } as const;
    },
    text: (data) => quoteLiteralText(planText(data)),
  });
export const planGetHandler: Read<typeof specPlanGetSpec> = {
  run: planRun(false, false),
  levels: { full: planRun(false, true) },
};
export const planStatusHandler: Read<typeof specPlanStatusSpec> = {
  run: planRun(true, false),
  levels: { full: planRun(true, true) },
};

const previewRun = runner<
  Input<typeof specPlanPreviewSpec>,
  JsonValue,
  CcErrorCode
>({
  async run({ app, ctx }: Input<typeof specPlanPreviewSpec>) {
    const expected = ctx.flags["expected-draft-revision"];
    if (expected !== undefined && ctx.flags.stage !== "draft")
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message:
            "--expected-draft-revision applies only to --stage draft; approved previews read the signed candidate.",
        }),
      } as const;
    const query = new URLSearchParams({ stage: ctx.flags.stage });
    if (expected !== undefined)
      query.set("expectedDraftRevision", String(expected));
    const response = await readSpecJson(
      app,
      (context) =>
        `${specPath(context.project, ctx.args.slug)}/plan-preview?${query}`,
      deliveryPlanPreviewViewSchema,
      ctx.args.slug,
    );
    if (!response.ok) return response;
    if (ctx.flags.outline) {
      const preview = response.data;
      const outline = parseOutlineRecord({
        id: preview.launch.layout.workflowId,
        name: preview.launch.name,
        revision: preview.draftRevision,
        definition: preview.launch.definition,
      });
      if (!outline)
        return {
          ok: false,
          error: ccErrors.error("CC_INVALID_RESPONSE", {
            message:
              "The launch candidate cannot be projected as a graph outline.",
          }),
        } as const;
      return {
        ok: true,
        data: jsonProjection({ outline: buildOutlineData(outline) }),
      } as const;
    }
    return {
      ok: true,
      data: jsonProjection({ preview: response.data }),
    } as const;
  },
});
export const planPreviewHandler: Read<typeof specPlanPreviewSpec> = {
  run: previewRun,
  levels: { full: previewRun },
};
