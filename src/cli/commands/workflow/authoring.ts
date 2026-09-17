import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  mutation,
  payloadRead,
  recoveryFacts,
  runner,
  writeRunner,
  type JsonData,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  workflowDefinitionEditRequestSchema,
  workflowLiveEditRequestSchema,
} from "@/lib/workflows/edit-schemas";
import {
  planReviewRecordResponseSchema,
  planReviewStatusResponseSchema,
} from "@/lib/workflows/plan-review/status-schemas";
import {
  explicitScopeFlags,
  resolveCcProject,
  resolveCcSession,
  type CcErrorCode,
} from "../../framework/context";
import type { ProjectContext, SessionContext } from "../../transport";
import { specPlanStatusCommand } from "../spec/native-definitions";
import {
  getCommand,
  type validateSpec,
  type createSpec,
  type replaceSpec,
  type reviewGetSpec,
  type reviewRecordSpec,
  type editSpec,
  type editPreviewSpec,
  type deleteSpec,
  type liveEditSpec,
  type liveEditPreviewSpec,
  type liveAmendSpec,
} from "./definitions";
import {
  amendResponseSchema,
  editResponseSchema,
  liveEditResponseSchema,
  mutationResponseSchema,
  validateResponseSchema,
} from "./schemas";
import {
  callerHeaders,
  definitionPath,
  definitionsPath,
  graphPath,
  invalid,
  jsonObjectSchema,
  planPayloadSchema,
  principal,
  readResponse,
  usage,
  writeResponse,
  okSchema,
  type Input,
  type Write,
  type PayloadRead,
  type Mutation,
} from "./shared";

type Validate = PayloadRead<typeof validateSpec>;
type ValidationData = z.infer<typeof validateResponseSchema> & { valid: true };
const validateImplementation: Validate = {
  decode: planPayloadSchema,
  run: runner<Parameters<Validate["run"]>[0], ValidationData, CcErrorCode>({
    async run({ app, ctx, payload }) {
      if (ctx.flags.definition && ctx.flags.tier === "global")
        return usage(
          "Managed --definition preflight cannot use --tier global.",
        );
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams();
      if (ctx.flags.tier === "global") query.set("tier", "global");
      if (ctx.flags.definition) query.set("definition", ctx.flags.definition);
      const response = await readResponse(
        app,
        {
          ...resolved.value,
          ...callerHeaders(app),
          method: "POST",
          path: `${graphPath(resolved.value)}/validate${query.size ? `?${query}` : ""}`,
          body: payload,
        },
        validateResponseSchema,
      );
      if (!response.ok) return response;
      if (ctx.flags.definition && !response.data.preflight)
        return invalid(
          "The server did not return the requested managed definition preflight.",
        );
      return { ok: true, data: { ...response.data, valid: true } };
    },
    text: (data) => {
      const preflight = data.preflight;
      return quoteLiteralText(
        [
          "Plan is valid.",
          ...(data.warnings ?? []).map(
            (warning) =>
              `Advice at ${warning.path}${warning.recordId ? ` (${warning.recordId})` : ""}: ${warning.message}`,
          ),
          ...(preflight
            ? [
                `Managed draft: ${preflight.specSlug}`,
                ...preflight.findings.flatMap((finding) => [
                  `${finding.severity}: ${finding.elementHandle} [${finding.ruleId}] ${finding.message}`,
                  ...(finding.rationale
                    ? [`Reason: ${finding.rationale}`]
                    : []),
                ]),
                `Coverage: ${preflight.summary.claimed} of ${preflight.summary.selected} selected criteria covered; ${preflight.summary.unclaimed} uncovered`,
                `Dispositions: ${preflight.summary.dispositions.map((entry) => `${entry.kind} ${entry.count}`).join(", ") || "none"}`,
                `Charter: ${preflight.summary.charter.state}`,
              ]
            : []),
        ].join("\n") + "\n",
      );
    },
  }),
};
export const validateHandler = payloadRead(validateImplementation);
type DefinitionData = z.infer<typeof mutationResponseSchema> & {
  expectedRevision: number;
};
function definitionText(data: JsonData<DefinitionData>): string {
  return (
    [
      `Saved ${data.item.name} (${data.item.id}); revision ${data.item.revision}.`,
      `Next write: expectedRevision ${data.expectedRevision}`,
      ...(data.warnings ?? []).map(
        (warning) => `Advice at ${warning.path}: ${warning.message}`,
      ),
      ...(data.reviewStatus ? [`Review: ${data.reviewStatus.state}`] : []),
      ...(data.item.management
        ? [
            `Managed spec: ${data.item.management.specSlug}`,
            ...(data.proposeGate
              ? [
                  `Propose findings: ${data.proposeGate.blockingBefore} → ${data.proposeGate.blockingAfter} (blocks_propose)`,
                ]
              : ["Read plan status for the current propose findings."]),
          ]
        : []),
    ].join("\n") + "\n"
  );
}
type Create = Mutation<typeof createSpec, ProjectContext>;
const createImplementation: Create = {
  decode: planPayloadSchema,
  prepare: ({ app }) => resolveCcProject(app),
  commit: writeRunner<
    Parameters<Create["commit"]>[0],
    DefinitionData,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const context = prepared.value;
      const response = await writeResponse(
        app,
        {
          ...context,
          ...callerHeaders(app),
          method: "POST",
          path: definitionsPath(context),
          body: {
            ...payload,
            ...(ctx.flags["acknowledge-review"]
              ? { acknowledgeReviewHash: ctx.flags["acknowledge-review"] }
              : {}),
          },
        },
        mutationResponseSchema,
        recoveryFacts([{ kind: "project", id: context.project }]),
        true,
      );
      if (response.effect !== "applied") return response;
      const data = {
        ...response.result.data,
        expectedRevision: response.result.data.item.revision,
      };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "workflow-definition", id: data.item.id },
        ]),
        result: {
          ok: true,
          data,
          hint: hint(
            invocation(getCommand, {
              args: { "definition-id": data.item.id },
              flags: { ...explicitScopeFlags(app), project: context.project },
            }),
            "Inspect the saved definition before launch",
          ),
        },
      };
    },
    text: (data) => quoteLiteralText(definitionText(data)),
  }),
};
export const createHandler = mutation(createImplementation);
type Replace = Mutation<typeof replaceSpec, ProjectContext>;
const replaceImplementation: Replace = {
  decode: planPayloadSchema,
  prepare: async ({ app, payload }) => {
    if (
      !Number.isInteger(payload.expectedRevision) ||
      typeof payload.expectedRevision !== "number" ||
      payload.expectedRevision < 1
    )
      return usage("Replacement requires expectedRevision from workflow get.");
    return resolveCcProject(app);
  },
  commit: writeRunner<
    Parameters<Replace["commit"]>[0],
    DefinitionData,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const context = prepared.value;
      const id = ctx.args["definition-id"];
      const response = await writeResponse(
        app,
        {
          ...context,
          ...callerHeaders(app),
          method: "PUT",
          path: definitionPath(context, "project", id),
          body: {
            ...payload,
            ...(ctx.flags["acknowledge-review"]
              ? { acknowledgeReviewHash: ctx.flags["acknowledge-review"] }
              : {}),
          },
        },
        mutationResponseSchema,
        recoveryFacts([{ kind: "workflow-definition", id }]),
        true,
      );
      if (response.effect !== "applied") return response;
      const data = {
        ...response.result.data,
        expectedRevision: response.result.data.item.revision,
      };
      return {
        ...response,
        result: {
          ok: true,
          data,
          ...(data.item.management
            ? {
                hint: hint(
                  invocation(specPlanStatusCommand, {
                    flags: explicitScopeFlags(app),
                    args: { slug: data.item.management.specSlug },
                  }),
                  "Read the managed draft's remaining propose findings",
                ),
              }
            : {}),
        },
      };
    },
    text: (data) => quoteLiteralText(definitionText(data)),
  }),
};
export const replaceHandler = mutation(replaceImplementation);
type ReviewGet = PayloadRead<typeof reviewGetSpec>;
const reviewGetImplementation: ReviewGet = {
  decode: planPayloadSchema,
  run: runner<
    Parameters<ReviewGet["run"]>[0],
    z.infer<typeof planReviewStatusResponseSchema>,
    CcErrorCode
  >({
    async run({ app, payload }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      return readResponse(
        app,
        {
          ...resolved.value,
          method: "POST",
          path: `${definitionsPath(resolved.value)}/reviews/status`,
          body: { plan: payload },
        },
        planReviewStatusResponseSchema,
      );
    },
    text: ({ status }) =>
      quoteLiteralText(
        [
          `Plan review: ${status.state}; revision ${status.definitionHash}`,
          ...(status.state === "unreviewed"
            ? ["No review has been recorded for this content."]
            : [
                `Reviewer: ${status.reviewerConversationId} at ${status.reviewedAt}`,
                ...(status.findings ? [status.findings] : []),
                ...(status.reviewer.note ? [status.reviewer.note] : []),
                ...status.reviewer.commands.map((command) => command.command),
              ]),
        ].join("\n") + "\n",
      ),
  }),
};
export const reviewGetHandler = payloadRead(reviewGetImplementation);
type ReviewRecord = Mutation<
  typeof reviewRecordSpec,
  { context: ProjectContext; reviewer: string }
>;
const reviewRecordImplementation: ReviewRecord = {
  decode: planPayloadSchema,
  async prepare({ app, ctx }) {
    const reviewer = (
      ctx.flags.reviewer ??
      app.env["CC_CONVERSATION_ID"] ??
      ""
    ).trim();
    if (!reviewer)
      return usage(
        "Review recording requires --reviewer or an issuing conversation.",
      );
    if (
      ctx.flags.verdict === "changes-requested" &&
      !ctx.flags.findings?.trim()
    )
      return usage(
        "Changes-requested requires nonempty --findings or --findings-file.",
      );
    const resolved = await resolveCcProject(app);
    return resolved.ok
      ? { ok: true, value: { context: resolved.value, reviewer } }
      : resolved;
  },
  commit: writeRunner<
    Parameters<ReviewRecord["commit"]>[0],
    { review: z.infer<typeof planReviewRecordResponseSchema> },
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const { context, reviewer } = prepared.value;
      const response = await writeResponse(
        app,
        {
          ...context,
          method: "POST",
          path: `${definitionsPath(context)}/reviews`,
          body: {
            plan: payload,
            reviewerConversationId: reviewer,
            verdict:
              ctx.flags.verdict === "changes-requested"
                ? "changes_requested"
                : "approved",
            ...(ctx.flags.findings === undefined
              ? {}
              : { findings: ctx.flags.findings }),
          },
        },
        planReviewRecordResponseSchema,
        recoveryFacts([{ kind: "conversation", id: reviewer }]),
        true,
      );
      if (response.effect !== "applied") return response;
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "plan-review", id: response.result.data.id },
        ]),
        result: { ok: true, data: { review: response.result.data } },
      };
    },
    text: ({ review }) =>
      quoteLiteralText(
        `Recorded ${review.verdict} review of ${review.definitionHash} by ${review.reviewerConversationId}.\n`,
      ),
  }),
};
export const reviewRecordHandler = mutation(reviewRecordImplementation);
const editPayloadSchema = workflowDefinitionEditRequestSchema
  .omit({ dryRun: true })
  .strict();
const liveEditPayloadSchema = workflowLiveEditRequestSchema
  .omit({ source: true, dryRun: true })
  .extend({ source: z.literal("cli").optional() })
  .strict();
type EditData = z.infer<typeof editResponseSchema> & {
  expectedRevision: number;
};
function editText(data: JsonData<EditData>) {
  return `${data.dryRun ? "Preview" : "Applied"}: ${data.applied} operations; ${data.item.id} revision ${data.item.revision}.\nNext write: expectedRevision ${data.expectedRevision}\n${data.proposeGate ? `Propose findings: ${data.proposeGate.blockingBefore} → ${data.proposeGate.blockingAfter}\n` : ""}`;
}
type Edit = Mutation<
  typeof editSpec,
  ProjectContext,
  z.infer<typeof editPayloadSchema>
>;
const editImplementation: Edit = {
  decode: editPayloadSchema,
  prepare: ({ app }) => resolveCcProject(app),
  commit: writeRunner<Parameters<Edit["commit"]>[0], EditData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const id = ctx.args["definition-id"];
      const response = await writeResponse(
        app,
        {
          ...prepared.value,
          method: "PATCH",
          path: definitionPath(prepared.value, ctx.flags.tier, id),
          body: payload,
        },
        editResponseSchema,
        recoveryFacts([{ kind: "workflow-definition", id }]),
        true,
      );
      return response.effect === "applied"
        ? {
            ...response,
            result: {
              ok: true,
              data: {
                ...response.result.data,
                expectedRevision: response.result.data.item.revision,
              },
            },
          }
        : response;
    },
    text: (data) => quoteLiteralText(editText(data)),
  }),
};
export const editHandler = mutation(editImplementation);
type EditPreview = PayloadRead<
  typeof editPreviewSpec,
  z.infer<typeof editPayloadSchema>
>;
const editPreviewImplementation: EditPreview = {
  decode: editPayloadSchema,
  run: runner<Parameters<EditPreview["run"]>[0], EditData, CcErrorCode>({
    async run({ app, ctx, payload }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await readResponse(
        app,
        {
          ...resolved.value,
          method: "PATCH",
          path: definitionPath(
            resolved.value,
            ctx.flags.tier,
            ctx.args["definition-id"],
          ),
          body: { ...payload, dryRun: true },
        },
        editResponseSchema,
        true,
      );
      if (!response.ok) return response;
      return response.data.dryRun === true
        ? {
            ok: true,
            data: {
              ...response.data,
              expectedRevision: response.data.item.revision,
            },
          }
        : invalid("The edit preview response did not confirm a dry run.");
    },
    text: (data) => quoteLiteralText(editText(data)),
  }),
};
export const editPreviewHandler = payloadRead(editPreviewImplementation);
type LiveEditData = z.infer<typeof liveEditResponseSchema> & {
  baseLiveRevision: number;
  executionId: string;
};
function liveEditText(data: JsonData<LiveEditData>) {
  return `${data.dryRun ? "Preview" : "Applied"}: ${data.applied} operations; execution ${data.executionId}; liveRevision ${data.liveRevision}.\nNext write: baseLiveRevision ${data.baseLiveRevision}\nAffected contexts: ${data.affectedContextIds.join(", ") || "none"}\n`;
}
type LiveEdit = Mutation<
  typeof liveEditSpec,
  SessionContext,
  z.infer<typeof liveEditPayloadSchema>
>;
const liveEditImplementation: LiveEdit = {
  decode: liveEditPayloadSchema,
  prepare: ({ app }) => resolveCcSession(app),
  commit: writeRunner<
    Parameters<LiveEdit["commit"]>[0],
    LiveEditData,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const response = await writeResponse(
        app,
        {
          ...prepared.value,
          ...principal(app),
          method: "POST",
          path: `${graphPath(prepared.value)}/runtime-edits`,
          body: { ...payload, source: "cli" },
        },
        liveEditResponseSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: payload.executionId },
        ]),
        true,
      );
      return response.effect === "applied"
        ? {
            ...response,
            result: {
              ok: true,
              data: {
                ...response.result.data,
                baseLiveRevision: response.result.data.liveRevision,
                executionId: payload.executionId,
              },
            },
          }
        : response;
    },
    text: (data) => quoteLiteralText(liveEditText(data)),
  }),
};
export const liveEditHandler = mutation(liveEditImplementation);
type LiveEditPreview = PayloadRead<
  typeof liveEditPreviewSpec,
  z.infer<typeof liveEditPayloadSchema>
>;
const liveEditPreviewImplementation: LiveEditPreview = {
  decode: liveEditPayloadSchema,
  run: runner<Parameters<LiveEditPreview["run"]>[0], LiveEditData, CcErrorCode>(
    {
      async run({ app, payload }) {
        const resolved = await resolveCcSession(app);
        if (!resolved.ok) return resolved;
        const response = await readResponse(
          app,
          {
            ...resolved.value,
            ...principal(app),
            method: "POST",
            path: `${graphPath(resolved.value)}/runtime-edits`,
            body: { ...payload, source: "cli", dryRun: true },
          },
          liveEditResponseSchema,
          true,
        );
        if (!response.ok) return response;
        return response.data.dryRun === true
          ? {
              ok: true,
              data: {
                ...response.data,
                baseLiveRevision: response.data.liveRevision,
                executionId: payload.executionId,
              },
            }
          : invalid(
              "The live edit preview response did not confirm a dry run.",
            );
      },
      text: (data) => quoteLiteralText(liveEditText(data)),
    },
  ),
};
export const liveEditPreviewHandler = payloadRead(
  liveEditPreviewImplementation,
);
const amendPayloadSchema = z
  .object({ operations: z.array(jsonObjectSchema).min(1) })
  .catchall(z.json());
type Amend = Mutation<
  typeof liveAmendSpec,
  SessionContext,
  z.infer<typeof amendPayloadSchema>
>;
const liveAmendImplementation: Amend = {
  decode: amendPayloadSchema,
  prepare: ({ app }) => resolveCcSession(app),
  commit: writeRunner<
    Parameters<Amend["commit"]>[0],
    z.infer<typeof amendResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      return writeResponse(
        app,
        {
          ...prepared.value,
          ...principal(app),
          ...callerHeaders(app),
          method: "POST",
          path: `${graphPath(prepared.value)}/amend`,
          body: { ...payload, reason: ctx.flags.reason },
        },
        amendResponseSchema,
        recoveryFacts([{ kind: "session", id: prepared.value.session }]),
        true,
      );
    },
    text: (data) =>
      quoteLiteralText(
        [
          `Amended ${data.amended} operations; liveRevision ${data.liveRevision}; policy ${data.policyBasis}.`,
          `Working definition: ${data.previousWorkingDefinitionHash} → ${data.workingDefinitionHash ?? "unchanged"}`,
          `Added contexts: ${data.addedContextIds.join(", ") || "none"}`,
          `Added tasks: ${data.addedTaskIds.join(", ") || "none"}`,
          `Added edges: ${data.addedEdgeIds.join(", ") || "none"}`,
        ].join("\n") + "\n",
      ),
  }),
};
export const liveAmendHandler = mutation(liveAmendImplementation);
export const deleteHandler: Write<typeof deleteSpec> = {
  run: writeRunner<
    Input<typeof deleteSpec>,
    { definitionId: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const definitionId = ctx.args["definition-id"];
      const response = await writeResponse(
        app,
        {
          ...resolved.value,
          method: "DELETE",
          path: definitionPath(resolved.value, "project", definitionId),
        },
        okSchema,
        recoveryFacts([{ kind: "workflow-definition", id: definitionId }]),
        true,
      );
      return response.effect === "applied"
        ? { ...response, result: { ok: true, data: { definitionId } } }
        : response;
    },
    text: ({ definitionId }) =>
      quoteLiteralText(`Deleted workflow ${definitionId}.\n`),
  }),
};
