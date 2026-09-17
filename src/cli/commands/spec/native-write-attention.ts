import {
  mutation,
  recoveryFacts,
  writeRunner,
  type MutationHandler,
} from "cli-for-agents";
import { z } from "zod";
import {
  specAttentionEditPayloadSchema,
  specAttentionMutationReceiptSchema,
  specSupersedeAssumptionPayloadSchema,
} from "@/lib/specs/schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import type * as S from "./native-write-definitions";
import {
  actionPath,
  attentionTarget,
  bareHandle,
  elementHint,
  postValue,
  resolveWrite,
  scalar,
  usage,
  type AttentionTarget,
  type WriteContext,
} from "./native-write-support";

type Receipt = z.infer<typeof specAttentionMutationReceiptSchema>;
type PreparedTarget = { context: WriteContext; target: AttentionTarget };
function recordId(target: AttentionTarget): string {
  return target.kind === "question" ? target.question.id : target.assumption.id;
}
function receiptRecovery(value: Receipt) {
  return recoveryFacts([
    { kind: `spec-${value.recordKind}`, id: value.recordId },
    ...(value.successor
      ? [{ kind: "spec-assumption", id: value.successor.id }]
      : []),
  ]);
}
type Edit = MutationHandler<
  typeof S.specAttentionEditSpec,
  CcApplication,
  PreparedTarget,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof specAttentionEditPayloadSchema>
>;
const edit: Edit = {
  decode: specAttentionEditPayloadSchema,
  async prepare({ app, ctx, payload }) {
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return resolved;
    const target = await attentionTarget(
      app,
      resolved.value,
      ctx.args.slug,
      ctx.args.handle,
      "attention",
    );
    if (!target.ok) return target;
    if (target.value.kind !== payload.kind)
      return usage(
        `The handle is a ${target.value.kind}, but the payload declares ${payload.kind}.`,
      );
    if (
      target.value.kind === "assumption" &&
      payload.kind === "assumption" &&
      ctx.flags["if-citation-version"] === undefined &&
      (payload.citationIntent?.kind === "replace" ||
        ((payload.text !== undefined || payload.attachment !== undefined) &&
          (target.value.assumption.currentDraftCitations?.citations.length ??
            0) > 0))
    )
      return usage(
        "This edit can change the draft's frozen premise; supply the observed --if-citation-version.",
      );
    return {
      ok: true,
      value: { context: resolved.value, target: target.value },
    };
  },
  commit: writeRunner<Parameters<Edit["commit"]>[0], Receipt, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const { context, target } = prepared.value;
      const response = await postValue(
        app,
        context,
        actionPath(context, ctx.args.slug, "edit-attention"),
        {
          recordId: recordId(target),
          expectedRecordVersion: ctx.flags["if-version"],
          ...(ctx.flags["if-citation-version"] === undefined
            ? {}
            : { expectedCitationVersion: ctx.flags["if-citation-version"] }),
          payload,
        },
        specAttentionMutationReceiptSchema,
        recoveryFacts([{ kind: `spec-${target.kind}`, id: recordId(target) }]),
      );
      return response.ok
        ? {
            effect: "applied",
            recovery: receiptRecovery(response.value),
            result: {
              ok: true,
              data: response.value,
              hint: elementHint(
                app,
                ctx.args.slug,
                response.value.recordHandle,
              ),
            },
          }
        : response.report;
    },
  }),
};
export const attentionEditHandler = mutation(edit);

export const attentionWithdrawHandler = scalar<
  typeof S.specAttentionWithdrawSpec,
  Receipt
>(async ({ app, ctx }) => {
  if (!ctx.flags.reason.trim())
    return {
      effect: "not_applied",
      result: usage("Withdrawal requires a nonempty durable reason."),
    };
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const target = await attentionTarget(
    app,
    resolved.value,
    ctx.args.slug,
    ctx.args.handle,
    "attention",
  );
  if (!target.ok) return { effect: "not_applied", result: target };
  if (
    target.value.kind === "assumption" &&
    ctx.flags["if-citation-version"] === undefined &&
    (target.value.assumption.currentDraftCitations?.citations.length ?? 0) > 0
  )
    return {
      effect: "not_applied",
      result: usage(
        "Withdrawing a cited assumption requires the observed --if-citation-version.",
      ),
    };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "withdraw-attention"),
    {
      recordId: recordId(target.value),
      expectedRecordVersion: ctx.flags["if-version"],
      ...(ctx.flags["if-citation-version"] === undefined
        ? {}
        : { expectedCitationVersion: ctx.flags["if-citation-version"] }),
      reason: ctx.flags.reason,
    },
    specAttentionMutationReceiptSchema,
    recoveryFacts([
      { kind: `spec-${target.value.kind}`, id: recordId(target.value) },
    ]),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: receiptRecovery(response.value),
        result: {
          ok: true,
          data: response.value,
          hint: elementHint(app, ctx.args.slug, response.value.recordHandle),
        },
      }
    : response.report;
});

type Supersede = MutationHandler<
  typeof S.specAttentionSupersedeSpec,
  CcApplication,
  { context: WriteContext; assumptionId: string; draftRevisionId?: string },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof specSupersedeAssumptionPayloadSchema>
>;
const supersede: Supersede = {
  decode: specSupersedeAssumptionPayloadSchema,
  async prepare({ app, ctx }) {
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return resolved;
    const target = await attentionTarget(
      app,
      resolved.value,
      ctx.args.slug,
      ctx.args.handle,
      "assumption",
    );
    if (!target.ok) return target;
    if (target.value.kind !== "assumption")
      return usage("Supersession requires an assumption handle.");
    const assumption = target.value.assumption;
    // A replay must retain the original operation's binding rather than follow a newer draft.
    const draftRevisionId =
      assumption.supersededByHandle === null
        ? assumption.currentDraftCitations?.revisionId
        : undefined;
    return {
      ok: true,
      value: {
        context: resolved.value,
        assumptionId: assumption.id,
        ...(draftRevisionId === undefined ? {} : { draftRevisionId }),
      },
    };
  },
  commit: writeRunner<Parameters<Supersede["commit"]>[0], Receipt, CcErrorCode>(
    {
      async run({ app, ctx, payload, prepared }) {
        const { context, assumptionId, draftRevisionId } = prepared.value;
        const response = await postValue(
          app,
          context,
          actionPath(context, ctx.args.slug, "supersede-assumption"),
          {
            assumptionId,
            ...(draftRevisionId === undefined ? {} : { draftRevisionId }),
            expectedRecordVersion: ctx.flags["if-version"],
            expectedCitationVersion: ctx.flags["if-citation-version"],
            payload,
          },
          specAttentionMutationReceiptSchema,
          recoveryFacts([
            { kind: "spec-assumption", id: assumptionId },
            { kind: "spec-supersession-operation", id: payload.operationId },
          ]),
        );
        return response.ok
          ? {
              effect: "applied",
              recovery: receiptRecovery(response.value),
              result: {
                ok: true,
                data: response.value,
                hint: elementHint(
                  app,
                  ctx.args.slug,
                  response.value.successor?.handle ??
                    response.value.recordHandle,
                ),
              },
            }
          : response.report;
      },
    },
  ),
};
export const attentionSupersedeHandler = mutation(supersede);

async function changeCitation(
  app: CcApplication,
  slug: string,
  handle: string,
  flags: { element: string; revision: string; "if-citation-version": number },
  operation: "cite" | "uncite",
) {
  const element = bareHandle(flags.element, slug, "content");
  if (!element.ok) return { effect: "not_applied" as const, result: element };
  const resolved = await resolveWrite(app, slug);
  if (!resolved.ok) return { effect: "not_applied" as const, result: resolved };
  const target = await attentionTarget(
    app,
    resolved.value,
    slug,
    handle,
    "assumption",
  );
  if (!target.ok) return { effect: "not_applied" as const, result: target };
  if (target.value.kind !== "assumption")
    return {
      effect: "not_applied" as const,
      result: usage("Citation changes require an assumption handle."),
    };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, slug, `${operation}-assumption`),
    {
      assumptionId: target.value.assumption.id,
      revisionId: flags.revision,
      elementHandle: element.value,
      expectedCitationVersion: flags["if-citation-version"],
    },
    specAttentionMutationReceiptSchema,
    recoveryFacts([
      { kind: "spec-assumption", id: target.value.assumption.id },
      { kind: "spec-revision", id: flags.revision },
    ]),
  );
  return response.ok
    ? {
        effect: "applied" as const,
        recovery: receiptRecovery(response.value),
        result: {
          ok: true as const,
          data: response.value,
          hint: elementHint(app, slug, response.value.recordHandle),
        },
      }
    : response.report;
}
export const attentionCiteHandler = scalar<
  typeof S.specAttentionCiteSpec,
  Receipt
>(({ app, ctx }) =>
  changeCitation(app, ctx.args.slug, ctx.args.handle, ctx.flags, "cite"),
);
export const attentionUnciteHandler = scalar<
  typeof S.specAttentionUnciteSpec,
  Receipt
>(({ app, ctx }) =>
  changeCitation(app, ctx.args.slug, ctx.args.handle, ctx.flags, "uncite"),
);
