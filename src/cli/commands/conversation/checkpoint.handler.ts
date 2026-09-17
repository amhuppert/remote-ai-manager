import { checkpointAdvice } from "./checkpoint-guidance";
import { randomUUID } from "node:crypto";
import {
  invocation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
  type Failure,
  type JsonData,
  type Omission,
  type Invocation,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import { checkpointRefusalSchema } from "@/lib/conversation-checkpoints/admission";
import {
  checkpointReceiptSchema,
  type CheckpointReceipt,
} from "@/lib/conversation-checkpoints/receipt";
import { cliRequest, encodePathSegment } from "../../transport";
import type { CcErrorCode } from "../../framework/context";
import { ccErrors } from "../../framework/family";
import { ccRequestFailure } from "../../framework/request";
import { observeJob } from "../../framework/observe-job";
import {
  checkpointCancelCommand,
  checkpointGetCommand,
  checkpointListCommand,
  checkpointReconcileCommand,
  compactContextCommand,
  type checkpointCancelSpec,
  type checkpointCheckSpec,
  type checkpointGetSpec,
  type checkpointListSpec,
  type checkpointReconcileSpec,
  type compactContextSpec,
} from "./definitions";
import {
  basePath,
  invalidResponse,
  mutationFailure,
  quoteEvidence,
  readInScope,
  requestParams,
  resolveTarget,
  scopeFlags,
  type Input,
  type Read,
  type Write,
  type NativeTarget,
} from "./native-target";

const receiptResponse = z.object({ receipt: checkpointReceiptSchema });
const startResponse = receiptResponse.extend({
  outcome: z.enum(["admitted", "reused"]),
  statusUrl: z.string().min(1),
});
const lifecycleResponse = receiptResponse.extend({
  outcome: z.enum(["cancelled", "completed", "repaired", "unchanged"]),
});
const seedSchema = z
  .object({
    seedText: z.string(),
    seedSha256: z.string(),
    schemaVersion: z.number().int(),
    createdAt: z.string(),
  })
  .nullable();
const seedResponse = receiptResponse.extend({ seed: seedSchema });
const listResponse = z.object({
  receipts: z.array(checkpointReceiptSchema),
  nextBefore: z.number().int().positive().nullable(),
});
const eligibilityResponse = z.object({
  eligible: z.boolean(),
  refusals: z.array(checkpointRefusalSchema),
  active: checkpointReceiptSchema.nullable(),
  hosted: z.boolean(),
});
const checkpointsPath = (target: NativeTarget) =>
  `${basePath(target)}/checkpoints`;
export const operationPath = (target: NativeTarget, operation: string) =>
  `${checkpointsPath(target)}/${encodePathSegment(operation)}`;
export function checkpointRead(target: NativeTarget, operationId: string) {
  return invocation(checkpointGetCommand, {
    args: {
      "conversation-id": target.target.conversationId,
      "operation-id": operationId,
    },
    flags: scopeFlags(target),
  });
}
function checkpointHint(target: NativeTarget, operationId: string) {
  return hint(
    checkpointRead(target, operationId),
    "Inspect this checkpoint's current receipt",
  );
}
function terminal(receipt: CheckpointReceipt): boolean {
  return [
    "ready",
    "applied",
    "failed",
    "cancelled",
    "needs_reconciliation",
  ].includes(receipt.phase);
}
function ready(receipt: CheckpointReceipt): boolean {
  return receipt.phase === "ready" || receipt.phase === "applied";
}
function receiptText(receipt: JsonData<CheckpointReceipt>): string {
  const acceptance = receipt.acceptance
    ? `accepted by attempt ${receipt.acceptance.attemptId}`
    : receipt.delivery
      ? `unconfirmed — attempt ${receipt.delivery.attemptId} is bound but no acceptance was recorded; whether input reached the provider is unresolved`
      : "none — the seed has not been delivered to a turn yet";
  return `Acceptance: ${acceptance}\ncheckpoint ${receipt.operationId} phase=${receipt.phase} ordinal=${receipt.ordinal} capturedThroughSeq=${receipt.boundary.capturedThroughSeq}\n${quoteEvidence(JSON.stringify(receipt, null, 2))}\n`;
}
function operationRecovery(receipt: CheckpointReceipt, requestId?: string) {
  return recoveryFacts([
    { kind: "checkpoint", id: receipt.operationId },
    { kind: "conversation", id: receipt.conversationId },
    ...(requestId ? [{ kind: "checkpoint-request", id: requestId }] : []),
  ]);
}

export const checkpointCheckHandler: Read<typeof checkpointCheckSpec> = {
  run: runner<
    Input<typeof checkpointCheckSpec>,
    z.infer<typeof eligibilityResponse> & {
      transition: string;
      findings: Array<
        z.infer<typeof checkpointRefusalSchema> & {
          blocks: string;
          remedy: Invocation;
        }
      >;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const recover = ctx.flags.recover;
      const query =
        recover === undefined
          ? ""
          : `?${new URLSearchParams({ recoversOperationId: recover })}`;
      const response = await readInScope(
        app,
        ctx.args["conversation-id"],
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${checkpointsPath(target)}/eligibility${query}`,
          }),
      );
      if (!response.ok) return response;
      const parsed = eligibilityResponse.safeParse(response.value.body);
      if (!parsed.success) return invalidResponse("checkpoint eligibility");
      const data = {
        ...parsed.data,
        transition: recover === undefined ? "compact_context" : "recovery",
        findings: parsed.data.refusals.map((refusal) => ({
          ...refusal,
          blocks: recover === undefined ? "compact_context" : "recovery",
          remedy: checkpointAdvice(
            response.target,
            refusal.code,
            refusal.operationId,
          ).invocation,
        })),
      };
      if (data.eligible)
        return {
          ok: true,
          data,
          hint: hint(
            invocation(compactContextCommand, {
              args: {
                "conversation-id": response.target.target.conversationId,
              },
              flags: {
                ...scopeFlags(response.target),
                ...(recover ? { recover } : {}),
              },
            }),
            "Checkpoint admission is clear; start the checked transition",
          ),
        };
      return {
        ok: false,
        data,
        error: ccErrors.error("CC_OPERATION_FAILED", {
          message: `Checkpoint ${recover === undefined ? "start" : "recovery"} is blocked.`,
          issues: data.findings.map((finding) => ({
            code: finding.code,
            message: `Checkpoint transition blocked by ${finding.code}; see findings.`,
          })),
        }),
        ...(data.findings[0]
          ? {
              hint: checkpointAdvice(
                response.target,
                data.findings[0].code,
                data.findings[0].operationId,
              ),
            }
          : {}),
      };
    },
    text: (data) =>
      `eligible: ${data.eligible}\nhosted: ${data.hosted}\n${data.findings.map((finding) => `blocks_${finding.blocks}: ${finding.code} — ${finding.reason}\n`).join("")}`,
  }),
};

export const checkpointListHandler: Read<typeof checkpointListSpec> = {
  run: runner<
    Input<typeof checkpointListSpec>,
    {
      receipts: CheckpointReceipt[];
      nextBefore: number | null;
      omission: Omission;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const query = new URLSearchParams();
      if (ctx.flags.before !== undefined)
        query.set("before", String(ctx.flags.before));
      if (ctx.flags.limit !== undefined)
        query.set("limit", String(ctx.flags.limit));
      const response = await readInScope(
        app,
        ctx.args["conversation-id"],
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${checkpointsPath(target)}${query.size ? `?${query}` : ""}`,
          }),
      );
      if (!response.ok) return response;
      const parsed = listResponse.safeParse(response.value.body);
      if (!parsed.success) return invalidResponse("checkpoint list");
      if (parsed.data.nextBefore === null)
        return {
          ok: true,
          data: {
            ...parsed.data,
            omission: page({
              items: parsed.data.receipts,
              total: { kind: "unknown" },
              more: false,
            }).omission,
          },
          ...(parsed.data.receipts.length === 0
            ? {
                hint: hint(
                  invocation(compactContextCommand, {
                    args: {
                      "conversation-id": response.target.target.conversationId,
                    },
                    flags: scopeFlags(response.target),
                  }),
                  "Start this conversation’s first checkpoint",
                ),
              }
            : {}),
        };
      const reveal = invocation(checkpointListCommand, {
        args: { "conversation-id": response.target.target.conversationId },
        flags: {
          ...scopeFlags(response.target),
          before: parsed.data.nextBefore,
          ...(ctx.flags.limit === undefined ? {} : { limit: ctx.flags.limit }),
        },
      });
      // The endpoint owns pagination; only the returned cursor can promise another page.
      const resultPage = page({
        items: parsed.data.receipts,
        total: { kind: "unknown" },
        more: true,
        reveal,
      });
      return {
        ok: true,
        data: { ...parsed.data, omission: resultPage.omission },
        hint: hint(
          reveal,
          "Read the older checkpoint receipts omitted from this page",
        ),
      };
    },
    text: ({ receipts, nextBefore }) =>
      `${receipts.length ? receipts.map((receipt) => `checkpoint ${receipt.operationId} ordinal=${receipt.ordinal} phase=${receipt.phase}`).join("\n") : "no checkpoints"}\n${nextBefore === null ? "" : `Older receipts omitted; next ordinal cursor ${nextBefore}\n`}`,
  }),
};

export const checkpointGetHandler: Read<typeof checkpointGetSpec> = {
  run: runner<
    Input<typeof checkpointGetSpec>,
    {
      receipt: CheckpointReceipt;
      detail: string;
      seed?: z.infer<typeof seedSchema>;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const detail = ctx.flags.detail;
      const response = await readInScope(
        app,
        ctx.args["conversation-id"],
        (target) =>
          cliRequest(app.host, {
            ...requestParams(target),
            method: "GET",
            path: `${operationPath(target, ctx.args["operation-id"])}?detail=${detail}`,
          }),
      );
      if (!response.ok) return response;
      if (detail === "seed") {
        const parsed = seedResponse.safeParse(response.value.body);
        return parsed.success
          ? { ok: true, data: { ...parsed.data, detail } }
          : invalidResponse("checkpoint seed");
      }
      const parsed = receiptResponse.safeParse(response.value.body);
      return parsed.success
        ? { ok: true, data: { ...parsed.data, detail } }
        : invalidResponse("checkpoint receipt");
    },
    text: ({ receipt, detail, seed }) =>
      `${receiptText(receipt)}${detail === "seed" ? (seed ? `Saved seed ${seed.seedSha256}\n${quoteEvidence(seed.seedText)}\n` : "Seed not frozen; no saved payload exists.\n") : ""}`,
  }),
};

type StartData = z.infer<typeof startResponse> & { requestId: string };
export const compactContextHandler: Write<typeof compactContextSpec> = {
  run: writeRunner<Input<typeof compactContextSpec>, StartData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveTarget(app, ctx.args["conversation-id"]);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = resolved.value;
      const requestId = randomUUID();
      const response = await cliRequest(app.host, {
        ...requestParams(target),
        method: "POST",
        path: checkpointsPath(target),
        body: {
          requestId,
          ...(ctx.flags.recover === undefined
            ? {}
            : { recoversOperationId: ctx.flags.recover }),
        },
      });
      const uncertainRecovery = recoveryFacts([
        { kind: "conversation", id: target.target.conversationId },
        { kind: "checkpoint-request", id: requestId },
      ]);
      if (response.kind !== "ok")
        return mutationFailure(
          app,
          target,
          response,
          uncertainRecovery,
          (owner) =>
            invocation(compactContextCommand, {
              args: { "conversation-id": owner.target.conversationId },
              flags: { ...scopeFlags(owner), ...ctx.flags },
            }),
        );
      const parsed = startResponse.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery: uncertainRecovery,
          result: invalidResponse("checkpoint admission"),
        };
      const started = { ...parsed.data, requestId };
      let lastReceipt = started.receipt;
      const recovery = operationRecovery(lastReceipt, requestId);
      if (!ctx.flags.wait)
        return {
          effect: "applied",
          recovery,
          result: {
            ok: true,
            data: started,
            hint: checkpointHint(target, lastReceipt.operationId),
          },
        };
      const observed = terminal(lastReceipt)
        ? { kind: "done" as const, value: lastReceipt }
        : await observeJob<CheckpointReceipt>({
            clock: ctx.clock,
            signal: ctx.signal,
            timeoutMs: 900_000,
            intervalMs: 2_000,
            async poll({ remainingMs }) {
              const result = await cliRequest(app.host, {
                ...requestParams(target),
                method: "GET",
                path: operationPath(target, started.receipt.operationId),
                timeoutMs: remainingMs,
              });
              if (result.kind !== "ok")
                return { kind: "failure", failure: ccRequestFailure(result) };
              const parsed = receiptResponse.safeParse(result.body);
              if (!parsed.success) return { kind: "invalid" };
              lastReceipt = parsed.data.receipt;
              return terminal(lastReceipt)
                ? { kind: "done", value: lastReceipt }
                : { kind: "pending" };
            },
          });
      const data = { ...started, receipt: lastReceipt };
      if (observed.kind === "done")
        return {
          effect: "applied",
          recovery,
          result: ready(observed.value)
            ? { ok: true, data }
            : {
                ok: false,
                data,
                error: ccErrors.error("CC_OPERATION_FAILED", {
                  message: `Checkpoint entered phase ${lastReceipt.phase}.`,
                  continuation: checkpointRead(target, lastReceipt.operationId),
                }),
                hint:
                  lastReceipt.phase === "needs_reconciliation"
                    ? checkpointAdvice(
                        target,
                        "reconciliation_failed",
                        lastReceipt.operationId,
                      )
                    : hint(
                        invocation(compactContextCommand, {
                          args: {
                            "conversation-id": target.target.conversationId,
                          },
                          flags: scopeFlags(target),
                        }),
                        "Inspect the failed checkpoint, then start a new operation",
                      ),
              },
        };
      const failure: Failure<never, CcErrorCode> =
        observed.kind === "failure"
          ? observed.failure
          : {
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message: `Checkpoint observation ${observed.kind}; the server still owns the operation.`,
                continuation: checkpointRead(target, lastReceipt.operationId),
              }),
            };
      return { effect: "applied", recovery, result: { ...failure, data } };
    },
    text: ({ receipt, outcome, requestId }) =>
      `${outcome} request=${requestId}\n${receiptText(receipt)}`,
  }),
};

function lifecycleRun(verb: "cancel" | "reconcile") {
  return writeRunner<
    Input<typeof checkpointCancelSpec> | Input<typeof checkpointReconcileSpec>,
    z.infer<typeof lifecycleResponse>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTarget(app, ctx.args["conversation-id"]);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = resolved.value;
      const operation = ctx.args["operation-id"];
      const recovery = recoveryFacts([
        { kind: "checkpoint", id: operation },
        { kind: "conversation", id: target.target.conversationId },
      ]);
      const response = await cliRequest(app.host, {
        ...requestParams(target),
        method: "POST",
        path: `${operationPath(target, operation)}/${verb}`,
      });
      if (response.kind !== "ok")
        return mutationFailure(app, target, response, recovery, (owner) =>
          verb === "cancel"
            ? invocation(checkpointCancelCommand, {
                args: {
                  "conversation-id": owner.target.conversationId,
                  "operation-id": operation,
                },
                flags: scopeFlags(owner),
              })
            : invocation(checkpointReconcileCommand, {
                args: {
                  "conversation-id": owner.target.conversationId,
                  "operation-id": operation,
                },
                flags: scopeFlags(owner),
              }),
        );
      const parsed = lifecycleResponse.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalidResponse(`checkpoint ${verb}`),
        };
      const advice =
        verb === "reconcile" &&
        parsed.data.receipt.phase === "needs_reconciliation"
          ? hint(
              invocation(compactContextCommand, {
                args: { "conversation-id": target.target.conversationId },
                flags: { ...scopeFlags(target), recover: operation },
              }),
              "Deterministic repair is done; explicitly start a recovery checkpoint",
            )
          : checkpointHint(target, operation);
      return {
        effect: "applied",
        recovery: operationRecovery(parsed.data.receipt),
        result: { ok: true, data: parsed.data, hint: advice },
      };
    },
    text: ({ outcome, receipt }) => `${outcome}\n${receiptText(receipt)}`,
  });
}
export const checkpointCancelHandler: Write<typeof checkpointCancelSpec> = {
  run: lifecycleRun("cancel"),
};
export const checkpointReconcileHandler: Write<typeof checkpointReconcileSpec> =
  { run: lifecycleRun("reconcile") };
