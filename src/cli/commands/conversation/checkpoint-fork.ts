import { z } from "zod";

import { checkpointForkRequestSchema } from "@/lib/conversation-checkpoints/fork-schemas";
import { checkpointReceiptSchema } from "@/lib/conversation-checkpoints/receipt";
import { renderBounded } from "../../disclosure";
import {
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  readJsonObjectFile,
  usageFailure,
  EXIT_OPERATION_FAILED,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../../shared";
import {
  conversationBasePath,
  resolveConversationCommandTarget,
  scopeFlags,
} from "./target";

const createdSchema = z.object({
  conversation: z.object({ id: z.string().min(1) }),
  receipt: checkpointReceiptSchema,
  reused: z.boolean(),
});

export async function runCheckpointFork(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
  verb: "fork" | "fork-check",
): Promise<CliResult> {
  const command = `conversation checkpoint ${verb}`;
  const denied = checkFlags(values, command, flags.json);
  if (denied) return denied;
  const [conversationId, operationId, ...extra] = rest;
  if (!conversationId || !operationId || extra.length > 0 || !values["file"]) {
    return usageFailure(
      `${command} takes <conversation-id> <operation-id> --file <request.json>`,
      flags.json,
    );
  }
  const file = await readJsonObjectFile(
    host,
    values["file"],
    "checkpoint fork",
    flags.json,
  );
  if (!file.ok) return file.result;
  const request = checkpointForkRequestSchema.safeParse(file.value);
  if (!request.success) {
    return usageFailure(
      request.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
      flags.json,
    );
  }
  const resolved = await resolveConversationCommandTarget(
    conversationId,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const response = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "POST",
    path: `${conversationBasePath(target)}/checkpoints/${encodePathSegment(operationId)}/fork${verb === "fork-check" ? "/check" : ""}`,
    body: request.data,
  });
  if (response.kind !== "ok") return failureFromRequest(response, flags.json);
  if (verb === "fork-check") {
    if (
      !z.object({ eligible: z.literal(true) }).safeParse(response.body).success
    ) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "unexpected checkpoint fork eligibility response",
        json: flags.json,
      });
    }
    return renderBounded(host, {
      command,
      json: flags.json,
      namePrefix: "checkpoint-fork-check",
      humanBody: "eligible: checkpoint fork\n",
      envelope: { ok: true, eligible: true },
    });
  }
  const created = createdSchema.safeParse(response.body);
  if (!created.success)
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected checkpoint fork response",
      json: flags.json,
    });
  const { conversation, receipt, reused } = created.data;
  const scope = scopeFlags(target.target);
  return renderBounded(host, {
    command,
    json: flags.json,
    namePrefix: `checkpoint-fork-${conversation.id}`,
    humanBody: `fork ${reused ? "reused" : "created"}: ${conversation.id}\ncheckpoint: ${receipt.operationId} phase=${receipt.phase}\nsource: ${conversationId} checkpoint ${operationId}\nTask saved as a draft. Backend/model remain editable until first submission.\n`,
    envelope: {
      ok: true,
      conversationId: conversation.id,
      receipt,
      reused,
      sourceReadCommand: `cctl conversation read ${conversationId} --outline ${scope}`,
      sourceCheckpointCommand: `cctl conversation checkpoint get ${conversationId} ${operationId} ${scope}`,
      hint: `read the fork receipt: cctl conversation checkpoint get ${conversation.id} ${receipt.operationId} ${scope}`,
    },
  });
}
