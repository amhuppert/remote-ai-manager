import { quoteLiteralText } from "../../framework/literal-text";
import path from "node:path";
import {
  invocation,
  recoveryFacts,
  runner,
  writeRunner,
  type CommandSpec,
  type JsonData,
  type HandlerInput,
  type ReadHandler,
  type WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import {
  VALIDATION_LEASE_HEADER,
  VALIDATION_POLL_MAX_WAIT_MS,
  validationCancelResponseSchema,
  validationListResponseSchema,
  validationPollResponseSchema,
  validationSubmitBodySchema,
  validationSubmitResponseSchema,
  type ValidationListResponse,
  type ValidationPollResponse,
} from "@/lib/validation/api-schemas";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcConversationTarget,
  type CcErrorCode,
} from "../../framework/context";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import { observeJob, waitDurationMs } from "../../framework/observe-job";
import {
  cliRequest,
  encodePathSegment,
  type ConversationTargetContext,
} from "../../transport";
import {
  validateStatusCommand,
  type validateRunSpec,
  type validateStatusSpec,
  type validateCancelSpec,
  type validateListSpec,
} from "./definitions";

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
type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
const acceptedReceiptSchema = validationSubmitResponseSchema.options[0].pick({
  kind: true,
  runId: true,
});
type RunData = {
  runId: string;
  commandName: string;
  requestedScope: "changed" | "full";
  effectiveScope: "changed" | "full";
  queuePositions: number[];
  result: ValidationRunResult | null;
  leaseStored: boolean;
};
const invalid = (message: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  }) as const;
function validationPath(context: ConversationTargetContext) {
  return `${conversationTargetApiBase(context.target)}/validation`;
}
function leasePath(app: CcApplication, runId: string) {
  return path.join(
    resolveConfigDirFrom(app.env, app.host),
    `validation-lease-${encodeURIComponent(runId)}.token`,
  );
}
async function removeLease(app: CcApplication, runId: string) {
  try {
    await app.host.removeFile?.(leasePath(app, runId));
  } catch {
    /* Cleanup must not replace the durable verdict. */
  }
}
type PrintableResult = JsonData<ValidationRunResult>;
function resultMessage(result: PrintableResult): string {
  switch (result.kind) {
    case "skipped_by_policy":
      return result.message;
    case "capacity_unavailable":
      return `Validation capacity unavailable: requested ${result.cost}, in use ${result.inUse}/${result.limit}, queue depth ${result.queueDepth}${result.blockedByOlderWaiter ? "; an older waiter owns the next admission" : ""}. Use --queue-if-busy to wait.`;
    case "command_not_found":
      return `Unknown validation command ${result.name}. Registered commands: ${result.knownCommands.join(", ") || "none"}.`;
    case "cost_exceeds_limit":
      return `Validation ${result.name} costs ${result.cost}, exceeding capacity ${result.limit}.`;
    case "queued":
      return `Validation ${result.runId} is queued at position ${result.position + 1}.`;
    case "passed":
      return `Validation passed${result.filesMatched !== undefined ? ` (${result.filesMatched} files matched)` : ""}.`;
    case "failed":
      return `Validation failed${result.exitCode === null ? " before process launch" : ` with exit ${result.exitCode}`}.`;
    case "timed_out":
      return `Validation exceeded its ${result.timeoutMs}ms server time limit.`;
    case "cancelled":
      return "Validation was cancelled.";
    case "interrupted":
      return "Validation was interrupted by a server restart.";
  }
}
function pollText(data: JsonData<ValidationPollResponse>): string {
  return (
    [
      `${data.runId}: ${data.status}${data.position === null ? "" : ` (queue position ${data.position + 1})`}`,
      ...(data.requestedScope
        ? [
            `scope: ${data.requestedScope} → ${data.effectiveScope ?? "unknown"}`,
          ]
        : []),
      ...(data.result
        ? [
            resultMessage(data.result),
            ...("output" in data.result && data.result.output
              ? [data.result.output]
              : []),
          ]
        : []),
    ].join("\n") + "\n"
  );
}
function activeText(
  data: JsonData<Pick<ValidationListResponse, "capacity" | "runs">>,
): string {
  return (
    [
      `Capacity: ${data.capacity.inUse}/${data.capacity.limit}; queue depth ${data.capacity.queueDepth}`,
      ...(data.runs.length
        ? data.runs.map(
            (run) =>
              `${run.runId} ${run.commandName}: ${run.status}, cost ${run.cost}${run.position === null ? "" : `, position ${run.position + 1}`}`,
          )
        : ["No active validation runs."]),
    ].join("\n") + "\n"
  );
}
export const listHandler: Read<typeof validateListSpec> = {
  run: runner<
    Input<typeof validateListSpec>,
    ValidationListResponse,
    CcErrorCode
  >({
    async run({ app }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: validationPath(resolved.value),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = validationListResponseSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalid("The validation command listing is invalid.");
    },
    text: (data) =>
      quoteLiteralText(
        `${data.commands
          .map((command) => {
            const cost = command.cost;
            const costs =
              typeof cost === "number"
                ? `cost ${cost}`
                : `full cost ${cost.full}${command.changedScope === "native" ? `, changed cost ${cost.changed ?? cost.full}${command.pathArgs === "paths" && cost.paths !== undefined ? `, paths cost ${typeof cost.paths === "number" ? cost.paths : `${cost.paths.base}+${cost.paths.perPath}/path`}` : ""}` : ""}`;
            return `${command.name}: ${costs}; ${command.enabled ? "enabled" : "disabled by policy"}; changed scope ${command.changedScope}; paths ${command.pathArgs}${command.timeoutMs === null ? "" : `; timeout ${command.timeoutMs}ms`}${command.description ? `\n  ${command.description}` : ""}`;
          })
          .join("\n")}\n${activeText(data)}`,
      ),
  }),
};
export const statusHandler: Read<typeof validateStatusSpec> = {
  run: runner<
    Input<typeof validateStatusSpec>,
    ValidationPollResponse | Pick<ValidationListResponse, "capacity" | "runs">,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const runId = ctx.args["run-id"];
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${validationPath(resolved.value)}${runId ? `/${encodePathSegment(runId)}` : ""}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      if (runId) {
        const parsed = validationPollResponseSchema.safeParse(response.body);
        return parsed.success && parsed.data.runId === runId
          ? { ok: true, data: parsed.data }
          : invalid("The validation status response is invalid.");
      }
      const parsed = validationListResponseSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: { runs: parsed.data.runs, capacity: parsed.data.capacity },
          }
        : invalid("The active validation listing is invalid.");
    },
    text: (data) =>
      quoteLiteralText("runId" in data ? pollText(data) : activeText(data)),
  }),
};
export const cancelHandler: Write<typeof validateCancelSpec> = {
  run: writeRunner<
    Input<typeof validateCancelSpec>,
    { runId: string; cancelled: true },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const runId = ctx.args["run-id"];
      const token = (
        await app.host.readTextFile(leasePath(app, runId))
      )?.trim();
      if (!token)
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message:
                "This command has no private submitter lease for that run. Interrupt its submitting command to cancel it.",
            }),
          },
        };
      const recovery = recoveryFacts([{ kind: "validation-run", id: runId }]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: `${validationPath(resolved.value)}/${encodePathSegment(runId)}/cancel`,
        headers: { [VALIDATION_LEASE_HEADER]: token },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = validationCancelResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalid(
            "The validation cancellation response is invalid; read status before retrying.",
          ),
        };
      await removeLease(app, runId);
      return {
        effect: "applied",
        recovery,
        result: { ok: true, data: { runId, cancelled: true } },
      };
    },
    text: ({ runId }) => quoteLiteralText(`Cancelled validation ${runId}.\n`),
  }),
};
export const runHandler: Write<typeof validateRunSpec> = {
  run: writeRunner<Input<typeof validateRunSpec>, RunData, CcErrorCode>({
    async run({ app, ctx }) {
      if (ctx.flags.scope === "full" && ctx.passthrough.length)
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message:
                "Full scope cannot be combined with explicit file paths.",
            }),
          },
        };
      const timeoutMs = waitDurationMs(ctx.flags.timeout);
      if (timeoutMs === null)
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: "The observation duration is too large.",
            }),
          },
        };
      const body = validationSubmitBodySchema.safeParse({
        commandName: ctx.args.name,
        scope: ctx.flags.scope,
        queueIfBusy: ctx.flags["queue-if-busy"] ?? false,
        ...(ctx.passthrough.length ? { scopePaths: [...ctx.passthrough] } : {}),
        ...(app.env["CC_VALIDATION_RUN_ID"]
          ? { nestedValidationRunId: app.env["CC_VALIDATION_RUN_ID"] }
          : {}),
        ...(app.env["CC_WORKFLOW_EXECUTION_ID"] !== undefined
          ? { workflowExecutionId: app.env["CC_WORKFLOW_EXECUTION_ID"] }
          : {}),
        ...(app.env["CC_WORKFLOW_CONTEXT_ID"] !== undefined
          ? { workflowContextId: app.env["CC_WORKFLOW_CONTEXT_ID"] }
          : {}),
      });
      if (!body.success)
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: body.error.issues
                .map((issue) => issue.message)
                .join("; "),
            }),
          },
        };
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const context = resolved.value;
      const target = recoveryFacts([
        { kind: "conversation", id: context.target.conversationId },
      ]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: validationPath(context),
        body: body.data,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, target);
      const parsed = validationSubmitResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        const receipt = acceptedReceiptSchema.safeParse(response.body);
        if (receipt.success)
          return {
            effect: "applied",
            recovery: recoveryFacts([
              { kind: "validation-run", id: receipt.data.runId },
            ]),
            result: invalid(
              "The server accepted the validation run but its remaining receipt fields were invalid. Read validation status before retrying.",
            ),
          };
        return {
          effect: "unknown",
          recovery: target,
          result: invalid(
            "The validation submit response did not provide a valid receipt. Inspect validation status before retrying.",
          ),
        };
      }
      const submitted = parsed.data;
      if (submitted.kind === "not_started")
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error(
              submitted.result.kind === "command_not_found"
                ? "CC_USAGE"
                : "CC_OPERATION_FAILED",
              { message: resultMessage(submitted.result), details: submitted },
            ),
          },
        };
      const { runId, lease } = submitted;
      const recovery = recoveryFacts([{ kind: "validation-run", id: runId }]);
      const followup = hint(
        invocation(validateStatusCommand, {
          args: { "run-id": runId },
          flags: {
            ...explicitScopeFlags(app),
            project: context.project,
            conversation: context.target.conversationId,
            ...(context.target.scope === "session"
              ? { session: context.target.sessionName }
              : {}),
          },
        }),
        "Read the durable validation result",
      );
      const data: RunData = {
        runId,
        commandName: ctx.args.name,
        requestedScope: submitted.requestedScope,
        effectiveScope: submitted.effectiveScope,
        queuePositions:
          submitted.position === null ? [] : [submitted.position + 1],
        result: null,
        leaseStored: false,
      };
      if (!lease || lease.runId !== runId)
        return {
          effect: "applied",
          recovery,
          result: {
            ...invalid(
              "The accepted validation run has no valid submitter lease; status remains readable.",
            ),
            data,
            hint: followup,
          },
        };
      try {
        if (app.host.writePrivateTextFile) {
          await app.host.writePrivateTextFile(
            leasePath(app, runId),
            lease.token,
          );
          data.leaseStored = true;
        }
      } catch {
        data.leaseStored = false;
      }
      try {
        const observed = await observeJob<ValidationPollResponse>({
          clock: ctx.clock,
          signal: ctx.signal,
          timeoutMs,
          async poll({ remainingMs }) {
            const waitMs = Math.floor(
              Math.min(
                VALIDATION_POLL_MAX_WAIT_MS,
                Math.max(0, remainingMs - 2_000),
              ),
            );
            const deadlineMs = Math.max(
              1,
              Math.ceil(Math.min(remainingMs, waitMs + 2_000)),
            );
            const started = ctx.clock.now();
            const response = await cliRequest(app.host, {
              ...context,
              method: "GET",
              path: `${validationPath(context)}/${encodePathSegment(runId)}${waitMs > 0 ? `?waitMs=${waitMs}` : ""}`,
              headers: { [VALIDATION_LEASE_HEADER]: lease.token },
              timeoutMs: deadlineMs,
            });
            if (
              response.kind === "connection" &&
              ctx.clock.now() - started >= deadlineMs
            )
              return { kind: "pending" };
            if (response.kind !== "ok")
              return { kind: "failure", failure: ccRequestFailure(response) };
            const parsed = validationPollResponseSchema.safeParse(
              response.body,
            );
            if (!parsed.success || parsed.data.runId !== runId)
              return { kind: "invalid" };
            const status = parsed.data;
            if (
              status.position !== null &&
              data.queuePositions.at(-1) !== status.position + 1
            )
              data.queuePositions.push(status.position + 1);
            if (status.requestedScope !== null)
              data.requestedScope = status.requestedScope;
            if (status.effectiveScope !== null)
              data.effectiveScope = status.effectiveScope;
            if (status.status === "queued" || status.status === "running")
              return { kind: "pending" };
            if (
              !status.result ||
              status.result.kind !== status.status ||
              ("runId" in status.result && status.result.runId !== runId)
            )
              return { kind: "invalid" };
            return { kind: "done", value: status };
          },
          async onCancel() {
            const response = await cliRequest(app.host, {
              ...context,
              method: "POST",
              cleanupTimeoutMs: 5_000,
              path: `${validationPath(context)}/${encodePathSegment(runId)}/cancel`,
              headers: { [VALIDATION_LEASE_HEADER]: lease.token },
            });
            if (response.kind !== "ok") return ccRequestFailure(response);
            if (
              !validationCancelResponseSchema.safeParse(response.body).success
            )
              return invalid(
                "The cancellation receipt was unreadable; inspect the run state.",
              );
          },
        });
        if (observed.kind === "done" && observed.value.result) {
          data.result = observed.value.result;
          const zeroMatch =
            data.result.kind === "passed" &&
            data.result.filesMatched === 0 &&
            ctx.flags["require-match"];
          return {
            effect: "applied",
            recovery,
            result:
              data.result.kind === "passed" && !zeroMatch
                ? { ok: true, data }
                : {
                    ok: false,
                    data,
                    error: ccErrors.error("CC_OPERATION_FAILED", {
                      message: zeroMatch
                        ? "Validation matched zero files; --require-match requires at least one."
                        : resultMessage(data.result),
                    }),
                    hint: followup,
                  },
          };
        }
        if (observed.kind === "failure")
          return {
            effect: "applied",
            recovery,
            result: { ...observed.failure, data },
          };
        if (observed.kind === "cancelled" && observed.failure)
          return {
            effect: "applied",
            recovery,
            result: { ...observed.failure, data },
          };
        const result =
          observed.kind === "invalid"
            ? invalid(
                "Validation status remained unreadable after repeated polls.",
              )
            : ({
                ok: false,
                error: ccErrors.error("CC_OPERATION_FAILED", {
                  message:
                    observed.kind === "timeout"
                      ? "Validation observation timed out. The server still owns the run; inspect its durable status."
                      : "Validation observation was interrupted and cancellation requested.",
                }),
              } as const);
        return {
          effect: "applied",
          recovery,
          result: { ...result, data, hint: followup },
        };
      } finally {
        await removeLease(app, runId);
      }
    },
    text: (data) =>
      quoteLiteralText(
        [
          `Validation ${data.commandName}: ${data.runId}; scope ${data.requestedScope} → ${data.effectiveScope}`,
          ...(data.queuePositions.length
            ? [`Queue positions: ${data.queuePositions.join(", ")}`]
            : []),
          ...(data.result
            ? [
                resultMessage(data.result),
                ...("output" in data.result && data.result.output
                  ? [data.result.output]
                  : []),
              ]
            : []),
          ...(data.result?.kind === "passed" && data.result.filesMatched === 0
            ? [
                "No files matched this scope; use --require-match when a real scoped pass is required.",
              ]
            : []),
          ...(!data.leaseStored && !data.result
            ? [
                "No private lease file was stored; explicit cancellation requires the submitting command's lease.",
              ]
            : []),
        ].join("\n") + "\n",
      ),
  }),
};
