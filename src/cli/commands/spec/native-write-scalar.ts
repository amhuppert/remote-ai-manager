import { explicitScopeFlags } from "../../framework/context";
import { invocation, recoveryFacts, type JsonValue } from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import { projectSpecComment } from "@/lib/specs/comment-projection";
import { specSlugSchema } from "@/lib/specs/handles";
import { approvalRequestReceiptSchema } from "@/lib/specs/review-service";
import {
  specAliasSchema,
  specCommentRowSchema,
  specExecutionRowSchema,
  specRevisionSchema,
  specRevisionSupersessionSchema,
  specSchema,
} from "@/lib/specs/schemas";
import {
  approvalLedgerSchema,
  specAssumptionViewSchema,
  specProposeResultViewSchema,
  specQuestionViewSchema,
} from "@/lib/specs/view-schemas";
import type * as S from "./native-write-definitions";
import { specRequestApprovalCommand } from "./native-write-definitions";
import {
  approvalLedgerLines,
  pendingBlockLines,
  signOffLines,
} from "./projection-text";
import {
  actionPath,
  attachment,
  bareHandle,
  humanInstruction,
  invalidResponse,
  postValue,
  quoteData,
  readValue,
  refused,
  resolveWrite,
  scalar,
  specPath,
  specRecovery,
  statusHint,
  usage,
  writeRevision,
  type Write,
} from "./native-write-support";

const amendSchema = z
  .object({
    revision: specRevisionSchema,
    skippedWithdrawnRevisions: z.array(specRevisionSchema),
  })
  .strict();
const withdrawSchema = z
  .object({
    withdrawn: specRevisionSchema,
    draft: specRevisionSchema,
    approvalLedger: approvalLedgerSchema,
  })
  .strict();
const dismissSchema = z
  .object({
    withdrawn: specRevisionSchema,
    supersession: specRevisionSupersessionSchema,
  })
  .strict();
const advancedSchema = z.object({ revision: specRevisionSchema }).strict();
const returnedSchema = z
  .object({
    revision: specRevisionSchema,
    withdrawnRevision: specRevisionSchema,
  })
  .strict();
const renamedSchema = z
  .object({ spec: specSchema, alias: specAliasSchema })
  .strict();
const questionStatusSchema = z.object({
  openQuestions: z.array(
    z.object({
      id: z.string().min(1),
      handle: z.string().min(1),
      recordVersion: z.number().int().positive(),
    }),
  ),
});

export const amendHandler = scalar<
  typeof S.specAmendSpec,
  z.infer<typeof amendSchema>
>(async ({ app, ctx }) => {
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "open-amendment"),
    {},
    amendSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-revision", id: response.value.revision.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const withdrawProposalHandler = scalar<
  typeof S.specWithdrawProposalSpec,
  z.infer<typeof withdrawSchema>
>(async ({ app, ctx }) => {
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "withdraw-proposal"),
    { revisionId: ctx.flags.revision },
    withdrawSchema,
    recoveryFacts([{ kind: "spec-revision", id: ctx.flags.revision }]),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-revision", id: response.value.draft.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const dismissSupersededHandler = scalar<
  typeof S.specDismissSupersededSpec,
  z.infer<typeof dismissSchema>
>(async ({ app, ctx }) => {
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  if (!ctx.flags.reason.trim())
    return {
      effect: "not_applied",
      result: usage("The dismissal reason must not be empty."),
    };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "dismiss-superseded"),
    { revisionId: ctx.flags.revision, reason: ctx.flags.reason },
    dismissSchema,
    recoveryFacts([{ kind: "spec-revision", id: ctx.flags.revision }]),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-revision", id: response.value.withdrawn.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const advanceHandler = scalar<
  typeof S.specAdvanceSpec,
  z.infer<typeof advancedSchema>
>(async ({ app, ctx }) => {
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const revision = await writeRevision(app, resolved.value, ctx.args.slug);
  if (!revision.ok) return { effect: "not_applied", result: revision };
  const recovery = recoveryFacts([
    { kind: "spec-revision", id: revision.value },
  ]);
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "advance"),
    { revisionId: revision.value, expectedStage: ctx.flags.from },
    advancedSchema,
    recovery,
  );
  return response.ok
    ? {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const returnToRequirementsHandler = scalar<
  typeof S.specReturnToRequirementsSpec,
  z.infer<typeof returnedSchema>
>(async ({ app, ctx }) => {
  if (!ctx.flags.reason.trim())
    return {
      effect: "not_applied",
      result: usage("The return reason must not be empty."),
    };
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const revision = await writeRevision(app, resolved.value, ctx.args.slug);
  if (!revision.ok) return { effect: "not_applied", result: revision };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "return-to-requirements"),
    { expectedRevisionId: revision.value, reason: ctx.flags.reason.trim() },
    returnedSchema,
    recoveryFacts([{ kind: "spec-revision", id: revision.value }]),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-revision", id: response.value.revision.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const proposeHandler = scalar<
  typeof S.specProposeSpec,
  z.infer<typeof specProposeResultViewSchema>
>(
  async ({ app, ctx }) => {
    if (ctx.flags.notes !== undefined && !ctx.flags.notes.trim())
      return {
        effect: "not_applied",
        result: usage("Proposal notes must not be empty."),
      };
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return { effect: "not_applied", result: resolved };
    const revision = await writeRevision(app, resolved.value, ctx.args.slug);
    if (!revision.ok) return { effect: "not_applied", result: revision };
    const recovery = recoveryFacts([
      { kind: "spec-revision", id: revision.value },
    ]);
    const response = await postValue(
      app,
      resolved.value,
      actionPath(resolved.value, ctx.args.slug, "propose"),
      {
        revisionId: revision.value,
        ...(ctx.flags.notes === undefined ? {} : { notes: ctx.flags.notes }),
      },
      specProposeResultViewSchema,
      recovery,
    );
    if (!response.ok) return response.report;
    return {
      effect: "applied",
      recovery,
      result: {
        ok: true,
        data: response.value,
        ...(response.value.pendingBlock
          ? {
              instruction: humanInstruction(
                response.value.pendingBlock.instruction,
              ),
            }
          : { hint: statusHint(app, ctx.args.slug) }),
      },
    };
  },
  (data) => {
    const view = specProposeResultViewSchema.parse(data);
    const block = view.pendingBlock;
    const repairs = view.approvalRequests.filter(
      (request) =>
        request.outcome === "not-filed" ||
        request.outcome === "delivery-uncertain",
    );
    const requests = view.approvalRequests.map((request) => {
      const outcome =
        request.outcome === "delivery-uncertain"
          ? "filed, notice delivery uncertain"
          : request.outcome.replaceAll("-", " ");
      return `  ${request.gate} ${outcome}${request.attentionId === null ? "" : ` (attention ${request.attentionId})`}`;
    });
    return (
      [
        `proposed revision ${view.revision.number} (${view.revision.id}) — ${view.revision.state}`,
        `acts next: ${repairs.length ? "agent" : (block?.actsNext ?? "agent")}${block ? ` — ${block.display}` : ""}`,
        ...approvalLedgerLines(view.approvalLedger),
        ...(block ? pendingBlockLines(block) : []),
        ...(block?.signOff
          ? ["revision sign-off:", ...signOffLines(block.signOff)]
          : []),
        ...(requests.length ? ["approval requests:", ...requests] : []),
        ...(repairs.length
          ? [
              `request notification repair owed: ${repairs.map((request) => request.gate).join(", ")}`,
            ]
          : []),
      ].join("\n") + "\n"
    );
  },
);

type Reply = Omit<ReturnType<typeof projectSpecComment>, "anchor"> & {
  anchor: JsonValue;
};
export const replyHandler = scalar<typeof S.specReplySpec, Reply>(
  async ({ app, ctx }) => {
    if (!ctx.flags.body.trim())
      return {
        effect: "not_applied",
        result: usage("Reply text must not be empty."),
      };
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return { effect: "not_applied", result: resolved };
    const response = await postValue(
      app,
      resolved.value,
      actionPath(resolved.value, ctx.args.slug, "reply"),
      { threadId: ctx.flags.thread, body: ctx.flags.body },
      specCommentRowSchema,
      recoveryFacts([{ kind: "spec-thread", id: ctx.flags.thread }]),
    );
    if (!response.ok) return response.report;
    const reply = projectSpecComment(response.value, {
      handleByElementId: new Map(),
      revisionNumberById: new Map(),
    });
    const anchor = z.json().safeParse(reply.anchor);
    const recovery = recoveryFacts([{ kind: "spec-comment", id: reply.id }]);
    if (!anchor.success)
      return {
        effect: "applied",
        recovery,
        result: invalidResponse("comment anchor"),
      };
    const data: Reply = { ...reply, anchor: anchor.data };
    return {
      effect: "applied",
      recovery,
      result: { ok: true, data, hint: statusHint(app, ctx.args.slug) },
    };
  },
  (data) => `Replied in thread ${data.threadId}\n${quoteData(data.body)}\n`,
);

export const questionHandler = scalar<
  typeof S.specQuestionSpec,
  z.infer<typeof specQuestionViewSchema>
>(async ({ app, ctx }) => {
  if (!ctx.flags.text.trim())
    return {
      effect: "not_applied",
      result: usage("Question text must not be empty."),
    };
  if (ctx.flags.element !== undefined) {
    const valid = bareHandle(ctx.flags.element, ctx.args.slug, "content");
    if (!valid.ok) return { effect: "not_applied", result: valid };
  }
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const element = await attachment(
    app,
    resolved.value,
    ctx.args.slug,
    ctx.flags.element,
  );
  if (!element.ok) return { effect: "not_applied", result: element };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "open-question"),
    { elementId: element.value, text: ctx.flags.text },
    specQuestionViewSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-question", id: response.value.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const assumeHandler = scalar<
  typeof S.specAssumeSpec,
  z.infer<typeof specAssumptionViewSchema>
>(async ({ app, ctx }) => {
  if (!ctx.flags.text.trim())
    return {
      effect: "not_applied",
      result: usage("Assumption text must not be empty."),
    };
  if (ctx.flags.element !== undefined) {
    const valid = bareHandle(ctx.flags.element, ctx.args.slug, "content");
    if (!valid.ok) return { effect: "not_applied", result: valid };
  }
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const element = await attachment(
    app,
    resolved.value,
    ctx.args.slug,
    ctx.flags.element,
  );
  if (!element.ok) return { effect: "not_applied", result: element };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "propose-assumption"),
    { elementId: element.value, text: ctx.flags.text },
    specAssumptionViewSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec-assumption", id: response.value.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});

export const answerHandler = scalar<
  typeof S.specAnswerSpec,
  z.infer<typeof specQuestionViewSchema>
>(async ({ app, ctx }) => {
  const slash = ctx.args.target.indexOf("/");
  if (slash < 1)
    return {
      effect: "not_applied",
      result: usage(
        "Answer takes a qualified question handle such as native-sdd/Q2.",
      ),
    };
  const slug = ctx.args.target.slice(0, slash);
  const handle = bareHandle(ctx.args.target, slug, "question");
  if (!handle.ok) return { effect: "not_applied", result: handle };
  const resolved = await resolveWrite(app, slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const status = await readValue(
    app,
    resolved.value,
    `${specPath(resolved.value, slug)}/status`,
    questionStatusSchema,
  );
  if (!status.ok) return { effect: "not_applied", result: status };
  const question = status.value.openQuestions.find(
    (candidate) => candidate.handle === handle.value,
  );
  if (!question)
    return {
      effect: "not_applied",
      result: refused(
        "The addressed question is not open; read spec status before answering.",
      ),
    };
  const recovery = recoveryFacts([{ kind: "spec-question", id: question.id }]);
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, slug, "answer-question"),
    {
      questionId: question.id,
      recordVersion: question.recordVersion,
      answer: ctx.flags.answer,
    },
    specQuestionViewSchema,
    recovery,
  );
  return response.ok
    ? {
        effect: "applied",
        recovery,
        result: { ok: true, data: response.value, hint: statusHint(app, slug) },
      }
    : response.report;
});

export const requestApprovalHandler: Write<typeof S.specRequestApprovalSpec> =
  scalar<
    typeof S.specRequestApprovalSpec,
    z.infer<typeof approvalRequestReceiptSchema>
  >(async ({ app, ctx }) => {
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return { effect: "not_applied", result: resolved };
    const revision = await writeRevision(app, resolved.value, ctx.args.slug);
    if (!revision.ok) return { effect: "not_applied", result: revision };
    const response = await postValue(
      app,
      resolved.value,
      actionPath(resolved.value, ctx.args.slug, "request-approval"),
      {
        revisionId: revision.value,
        gate: ctx.flags.gate,
        ...(ctx.flags.subject === undefined
          ? {}
          : { subject: ctx.flags.subject }),
      },
      approvalRequestReceiptSchema,
      recoveryFacts([{ kind: "spec-revision", id: revision.value }]),
    );
    return response.ok
      ? {
          effect: "applied",
          recovery: recoveryFacts([
            { kind: "approval-request", id: response.value.attentionId },
          ]),
          result: {
            ok: true,
            data: response.value,
            hint:
              response.value.deliveryOutcome === "delivery-uncertain"
                ? hint(
                    invocation(specRequestApprovalCommand, {
                      args: { slug: ctx.args.slug },
                      flags: { ...explicitScopeFlags(app), ...ctx.flags },
                    }),
                    "The request is saved; retry to resend the uncertain human notification without duplicating the request",
                  )
                : statusHint(app, ctx.args.slug),
          },
        }
      : response.report;
  });

export const renameHandler = scalar<
  typeof S.specRenameSpec,
  z.infer<typeof renamedSchema>
>(async ({ app, ctx }) => {
  if (!specSlugSchema.safeParse(ctx.flags.to).success)
    return {
      effect: "not_applied",
      result: usage("The new spec slug is invalid."),
    };
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "rename"),
    {
      slug: ctx.flags.to,
      ...(ctx.flags.name === undefined ? {} : { name: ctx.flags.name }),
    },
    renamedSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: specRecovery(response.value.spec.id),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, response.value.spec.slug),
        },
      }
    : response.report;
});

export const abandonHandler = scalar<
  typeof S.specAbandonSpec,
  {
    execution?: z.infer<typeof specExecutionRowSchema>;
    spec?: z.infer<typeof specSchema>;
  }
>(async ({ app, ctx }) => {
  if (!ctx.flags.reason.trim())
    return {
      effect: "not_applied",
      result: usage("Abandonment reason must not be empty."),
    };
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  if (ctx.flags.execution !== undefined) {
    const recovery = recoveryFacts([
      { kind: "workflow-execution", id: ctx.flags.execution },
    ]);
    const response = await postValue(
      app,
      resolved.value,
      actionPath(resolved.value, ctx.args.slug, "abandon-execution"),
      { executionId: ctx.flags.execution, reason: ctx.flags.reason },
      specExecutionRowSchema,
      recovery,
    );
    return response.ok
      ? {
          effect: "applied",
          recovery,
          result: {
            ok: true,
            data: { execution: response.value },
            hint: statusHint(app, ctx.args.slug),
          },
        }
      : response.report;
  }
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "abandon-spec"),
    { reason: ctx.flags.reason },
    specSchema,
    specRecovery(ctx.args.slug),
  );
  return response.ok
    ? {
        effect: "applied",
        recovery: specRecovery(response.value.id),
        result: {
          ok: true,
          data: { spec: response.value },
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});
