import {
  mutation,
  recoveryFacts,
  writeRunner,
  type CommitReport,
  type JsonValue,
  type MutationHandler,
} from "cli-for-agents";
import { z } from "zod";
import { postLaunchPathActs } from "@/lib/specs/delivery-plan";
import {
  deliveryPlanMutationViewSchema,
  deliveryPlanPreviewViewSchema,
  specStartExecutionReceiptSchema,
} from "@/lib/specs/delivery-plan-views";
import { taskElementPayloadSchema } from "@/lib/specs/schemas";
import { specSlugSchema } from "@/lib/specs/handles";
import {
  resolveCcConversation,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import type { ConversationContext } from "../../transport";
import type * as S from "./native-write-definitions";
import {
  actionPath,
  humanInstruction,
  invalidResponse,
  postValue,
  readEditContext,
  readValue,
  refused,
  resolveWrite,
  scalar,
  specPath,
  specRecovery,
  statusHint,
  usage,
} from "./native-write-support";

const jsonSchema = z.json().transform((value): JsonValue => value);
async function planAction(
  app: CcApplication,
  slug: string,
  action: string,
  body: unknown,
): Promise<CommitReport<JsonValue, CcErrorCode>> {
  const resolved = await resolveWrite(app, slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, slug, action),
    body,
    deliveryPlanMutationViewSchema,
    specRecovery(slug),
  );
  if (!response.ok) return response.report;
  const recovery = recoveryFacts([
    { kind: "spec-delivery-attempt", id: response.value.attempt.id },
  ]);
  const json = jsonSchema.safeParse(response.value);
  if (!json.success)
    return {
      effect: "applied",
      recovery,
      result: invalidResponse("delivery plan"),
    };
  return {
    effect: "applied",
    recovery,
    result: { ok: true, data: json.data, hint: statusHint(app, slug) },
  };
}
export const planOpenHandler = scalar<typeof S.specPlanOpenSpec, JsonValue>(
  ({ app, ctx }) => planAction(app, ctx.args.slug, "plan-open", {}),
);
export const planProposeHandler = scalar<
  typeof S.specPlanProposeSpec,
  JsonValue
>(({ app, ctx }) => planAction(app, ctx.args.slug, "plan-propose", {}));
export const planReopenHandler = scalar<typeof S.specPlanReopenSpec, JsonValue>(
  ({ app, ctx }) =>
    ctx.flags.reason.trim()
      ? planAction(app, ctx.args.slug, "plan-reopen", {
          reason: ctx.flags.reason,
        })
      : Promise.resolve({
          effect: "not_applied",
          result: usage("Reopening requires a nonempty durable reason."),
        }),
);
export const planSignOffHandler = scalar<
  typeof S.specPlanSignOffSpec,
  JsonValue
>(async ({ app, ctx }) => {
  let candidateId = ctx.flags.candidate;
  let candidateHash = ctx.flags["candidate-hash"];
  if ((candidateId === undefined) !== (candidateHash === undefined))
    return {
      effect: "not_applied",
      result: usage(
        "Supply both --candidate and --candidate-hash, or neither to read the frozen proposal.",
      ),
    };
  if (candidateId === undefined || candidateHash === undefined) {
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return { effect: "not_applied", result: resolved };
    const preview = await readValue(
      app,
      resolved.value,
      `${specPath(resolved.value, ctx.args.slug)}/plan-preview?stage=proposed`,
      deliveryPlanPreviewViewSchema,
    );
    if (!preview.ok) return { effect: "not_applied", result: preview };
    if (
      preview.value.candidateId === null ||
      preview.value.candidateHash === null
    )
      return {
        effect: "not_applied",
        result: refused(
          "The proposed delivery plan has no frozen candidate identity; propose the plan before requesting sign-off.",
        ),
      };
    candidateId = preview.value.candidateId;
    candidateHash = preview.value.candidateHash;
  }
  return planAction(app, ctx.args.slug, "plan-sign-off", {
    candidateId,
    candidateHash,
  });
});
const abandonedSchema = z.object({ attemptId: z.string().min(1) }).strict();
export const planAbandonHandler = scalar<
  typeof S.specPlanAbandonSpec,
  z.infer<typeof abandonedSchema>
>(async ({ app, ctx }) => {
  if (!ctx.flags.reason.trim())
    return {
      effect: "not_applied",
      result: usage("Abandoning a plan requires a nonempty durable reason."),
    };
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "plan-abandon"),
    { reason: ctx.flags.reason },
    abandonedSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-delivery-attempt", id: response.value.attemptId },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

const parametersSchema = z.record(z.string(), jsonSchema);
type Start = MutationHandler<
  typeof S.specStartSpec,
  CcApplication,
  { context: ConversationContext; revisionId: string },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof parametersSchema>
>;
const start: Start = {
  decode: parametersSchema,
  async prepare({ app, ctx, payload }) {
    if (
      "selectedTaskIds" in payload &&
      "selectedCriterionIds" in payload &&
      "exclusionDispositions" in payload
    )
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message:
            "Execution scope documents are retired; the approved delivery plan is the execution graph.",
        }),
        instruction: humanInstruction(
          `Use cctl spec plan open ${ctx.args.slug} to author the delivery graph; spec start --file accepts only its parameter values.`,
        ),
      };
    if (!specSlugSchema.safeParse(ctx.args.slug).success)
      return usage("The spec slug is invalid.");
    const resolved = await resolveCcConversation(app);
    if (!resolved.ok) return resolved;
    const edit = await readEditContext(app, resolved.value, ctx.args.slug);
    if (!edit.ok) return edit;
    const revisionId =
      edit.value.latestApprovedRevision?.id ?? edit.value.currentRevision?.id;
    if (revisionId === undefined)
      return refused(
        "The spec has no revision to launch; read spec status before retrying.",
      );
    return { ok: true, value: { context: resolved.value, revisionId } };
  },
  commit: writeRunner<
    Parameters<Start["commit"]>[0],
    z.infer<typeof specStartExecutionReceiptSchema>,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const { context, revisionId } = prepared.value;
      const response = await postValue(
        app,
        context,
        actionPath(context, ctx.args.slug, "start-execution"),
        {
          revisionId,
          sessionName: context.session,
          parameters: payload,
          ...(ctx.flags.park ? { park: true } : {}),
        },
        specStartExecutionReceiptSchema,
        recoveryFacts([{ kind: "spec-revision", id: revisionId }]),
      );
      if (!response.ok) return response.report;
      const receipt = response.value;
      const recovery =
        "parked" in receipt
          ? recoveryFacts([
              { kind: "spec-delivery-attempt", id: receipt.parked.attemptId },
              {
                kind: "spec-delivery-candidate",
                id: receipt.parked.candidateId,
              },
            ])
          : recoveryFacts([
              {
                kind: "workflow-execution",
                id: receipt.deliveryPlan.workflowExecutionId,
              },
              {
                kind: "spec-delivery-attempt",
                id: receipt.deliveryPlan.attemptId,
              },
              {
                kind: "spec-delivery-candidate",
                id: receipt.deliveryPlan.candidateId,
              },
            ]);
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: receipt,
          hint: statusHint(app, ctx.args.slug),
        },
      };
    },
  }),
};
export const startHandler = mutation(start);

const discoveredSchema = taskElementPayloadSchema.omit({ kind: true });
const captureSchema = z
  .object({
    discovery: z
      .object({
        id: z.string().min(1),
        executionId: z.string().min(1),
        workflowExecutionId: z.string().min(1),
        attemptId: z.string().min(1).nullable(),
        title: z.string().min(1),
      })
      .strict(),
    restartRequired: z.boolean(),
    replacement: z
      .object({
        abandonedExecutionId: z.string().min(1),
        abandonedWorkflowExecutionId: z.string().min(1),
        replacementAttemptId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
type Capture = MutationHandler<
  typeof S.specCaptureSpec,
  CcApplication,
  import("./native-write-support").WriteContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof discoveredSchema>
>;
const capture: Capture = {
  decode: discoveredSchema,
  async prepare({ app, ctx }) {
    if (
      ctx.flags["blocking-reason"] !== undefined &&
      !ctx.flags["blocking-reason"].trim()
    )
      return usage(
        "A blocking reason must be nonempty because it becomes the run's durable abandonment reason.",
      );
    return resolveWrite(app, ctx.args.slug);
  },
  commit: writeRunner<
    Parameters<Capture["commit"]>[0],
    z.infer<typeof captureSchema>,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const context = prepared.value;
      const response = await postValue(
        app,
        context,
        actionPath(context, ctx.args.slug, "capture-scope-amendment"),
        {
          discoveredTask: payload,
          ...(ctx.flags.execution === undefined
            ? {}
            : { executionId: ctx.flags.execution }),
          ...(ctx.flags["blocking-reason"] === undefined
            ? {}
            : { blockingReason: ctx.flags["blocking-reason"].trim() }),
        },
        captureSchema,
        ctx.flags.execution === undefined
          ? specRecovery(ctx.args.slug)
          : recoveryFacts([
              { kind: "workflow-execution", id: ctx.flags.execution },
            ]),
      );
      if (!response.ok) return response.report;
      const { discovery, replacement } = response.value;
      const recovery = recoveryFacts([
        { kind: "spec-discovery", id: discovery.id },
        { kind: "workflow-execution", id: discovery.workflowExecutionId },
        ...(replacement === null
          ? []
          : [
              {
                kind: "spec-delivery-attempt",
                id: replacement.replacementAttemptId,
              },
            ]),
      ]);
      const paths = postLaunchPathActs({
        slug: ctx.args.slug,
        workflowExecutionId: discovery.workflowExecutionId,
      });
      const guidance =
        replacement === null
          ? `The run keeps its pinned scope. The discovery is queued for a later plan. Post-launch paths: ${paths.join("; ")}.`
          : `Stop work on retired execution ${replacement.abandonedWorkflowExecutionId}. Review replacement attempt ${replacement.replacementAttemptId}, author its replacement graph through workflow replace, then propose and obtain human sign-off before launching it. Capture never changes the retired run's pinned scope.`;
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: response.value,
          instruction: humanInstruction(guidance),
        },
      };
    },
  }),
};
export const captureHandler = mutation(capture);
