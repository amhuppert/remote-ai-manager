import {
  mutation,
  recoveryFacts,
  writeRunner,
  type MutationHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  checkpointForkRequestSchema,
  type CheckpointForkRequest,
} from "@/lib/conversation-checkpoints/fork-schemas";
import {
  checkpointReceiptSchema,
  type CheckpointReceipt,
} from "@/lib/conversation-checkpoints/receipt";
import { cliRequest } from "../../transport";
import type { CcErrorCode } from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import type { checkpointForkSpec } from "./definitions";
import { checkpointRead, operationPath } from "./checkpoint.handler";
import {
  invalidResponse,
  requestParams,
  resolveTarget,
  type NativeTarget,
} from "./native-target";

type Handler = MutationHandler<
  typeof checkpointForkSpec,
  CcApplication,
  NativeTarget,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  CheckpointForkRequest
>;
const eligibleSchema = z.object({ eligible: z.literal(true) });
const createdSchema = z.object({
  conversation: z.object({ id: z.string().min(1) }),
  receipt: checkpointReceiptSchema,
  reused: z.boolean(),
});
const handler: Handler = {
  decode: checkpointForkRequestSchema,
  async prepare({ app, ctx, payload }) {
    const resolved = await resolveTarget(app, ctx.args["conversation-id"]);
    if (!resolved.ok) return resolved;
    const response = await cliRequest(app.host, {
      ...requestParams(resolved.value),
      method: "POST",
      path: `${operationPath(resolved.value, ctx.args["operation-id"])}/fork/check`,
      body: payload,
    });
    if (response.kind !== "ok") return ccRequestFailure(response);
    if (!eligibleSchema.safeParse(response.body).success)
      return invalidResponse("checkpoint fork eligibility");
    return resolved;
  },
  commit: writeRunner<
    Parameters<Handler["commit"]>[0],
    { conversationId: string; receipt: CheckpointReceipt; reused: boolean },
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const target = prepared.value;
      const recovery = recoveryFacts([
        { kind: "checkpoint", id: ctx.args["operation-id"] },
        { kind: "checkpoint-fork-request", id: payload.requestId },
      ]);
      const response = await cliRequest(app.host, {
        ...requestParams(target),
        method: "POST",
        path: `${operationPath(target, ctx.args["operation-id"])}/fork`,
        body: payload,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = createdSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalidResponse("checkpoint fork"),
        };
      const { conversation, receipt, reused } = parsed.data;
      const forkTarget = {
        ...target,
        target: { ...target.target, conversationId: conversation.id },
      };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "conversation", id: conversation.id },
          { kind: "checkpoint", id: receipt.operationId },
        ]),
        result: {
          ok: true,
          data: { conversationId: conversation.id, receipt, reused },
          hint: hint(
            checkpointRead(forkTarget, receipt.operationId),
            "Read the fork's checkpoint receipt",
          ),
        },
      };
    },
    text: ({ conversationId, receipt, reused }) =>
      `fork ${reused ? "reused" : "created"}: ${conversationId}\ncheckpoint ${receipt.operationId} phase=${receipt.phase}\nTask saved as a draft. Backend/model remain editable until first submission.\n`,
  }),
};
export default mutation(handler);
