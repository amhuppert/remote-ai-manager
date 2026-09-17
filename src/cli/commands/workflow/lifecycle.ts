import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  mutation,
  recoveryFacts,
  runner,
  writeRunner,
  type Failure,
  type JsonData,
} from "cli-for-agents";
import { hint, instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import { ccErrors, type CcApplication } from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcSession,
  type CcErrorCode,
} from "../../framework/context";
import { observeJob } from "../../framework/observe-job";
import { waitDurationMs } from "../../framework/observe-job";
import {
  cliRequest,
  encodePathSegment,
  type SessionContext,
} from "../../transport";
import { ccWriteFailure } from "../../framework/request";
import {
  waitCommand,
  type startSpec,
  type runSpec,
  type waitSpec,
  type abandonSpec,
  type livePauseSpec,
  type liveResumeSpec,
  type liveAbortSpec,
} from "./definitions";
import {
  abandonResponseSchema,
  cliGraphWorkflowLaunchReceiptSchema,
  startResponseSchema,
  workflowBoundaryResponseSchema,
  workflowBoundaryResultSchema,
} from "./schemas";
import {
  graphPath,
  principal,
  callerHeaders,
  planPayloadSchema,
  parseInputBindings,
  jsonValueSchema,
  invalid,
  usage,
  workflowFailure,
  writeResponse,
  type Input,
  type Read,
  type Write,
  type Mutation,
  type JsonObject,
} from "./shared";

type LaunchReceipt = z.infer<typeof cliGraphWorkflowLaunchReceiptSchema>;
type BoundaryData = {
  executionId: string;
  cursor: string | null;
  receipt?: LaunchReceipt;
  result?: z.infer<typeof workflowBoundaryResultSchema>;
};
type BoundaryResult =
  | { ok: true; data: BoundaryData }
  | (Failure<BoundaryData, CcErrorCode> & { data: BoundaryData });
function boundaryText(data: JsonData<BoundaryData>): string {
  const result = data.result;
  return (
    [
      ...(data.receipt
        ? [
            `Launched ${data.executionId}: ${data.receipt.status}`,
            `Origin: ${data.receipt.origin.kind}; ${data.receipt.deepLink}`,
            ...(data.receipt.warnings ?? []).map(
              (warning) => `Advice at ${warning.path}: ${warning.message}`,
            ),
          ]
        : []),
      ...(result
        ? [
            `${result.executionId}: ${result.boundaryKind}; status ${result.status}; cursor ${result.cursor}`,
            ...(result.contextId ? [`Context: ${result.contextId}`] : []),
            `Outputs: ${JSON.stringify(result.outputs)}`,
            ...(result.haltReason
              ? [`Halt: ${JSON.stringify(result.haltReason)}`]
              : []),
            ...result.pendingActions.map(
              (action) => `Pending action: ${JSON.stringify(action)}`,
            ),
            result.deepLink,
          ]
        : [
            `Execution ${data.executionId}; cursor ${data.cursor ?? "initial"}`,
          ]),
    ].join("\n") + "\n"
  );
}
async function waitBoundary(input: {
  app: CcApplication;
  ctx: Input<typeof waitSpec>["ctx"] | Input<typeof runSpec>["ctx"];
  context: SessionContext;
  executionId: string;
  cursor: string | null;
  timeoutMs: number;
  receipt?: LaunchReceipt;
}): Promise<BoundaryResult> {
  const { app, ctx, context, executionId, cursor } = input;
  const data: BoundaryData = {
    executionId,
    cursor,
    ...(input.receipt ? { receipt: input.receipt } : {}),
  };
  const continuation = invocation(waitCommand, {
    args: { "execution-id": executionId },
    flags: {
      ...explicitScopeFlags(app),
      project: context.project,
      session: context.session,
      ...(cursor ? { cursor } : {}),
    },
  });
  const observed = await observeJob<
    z.infer<typeof workflowBoundaryResultSchema>
  >({
    clock: ctx.clock,
    signal: ctx.signal,
    timeoutMs: input.timeoutMs,
    async poll({ remainingMs }) {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const started = ctx.clock.now();
      const response = await cliRequest(app.host, {
        ...context,
        method: "GET",
        path: `${graphPath(context)}/executions/${encodePathSegment(executionId)}/result${params.size ? `?${params}` : ""}`,
        timeoutMs: Math.max(1, Math.ceil(remainingMs)),
      });
      if (
        response.kind === "connection" &&
        ctx.clock.now() - started >= remainingMs
      )
        return { kind: "pending" };
      if (response.kind !== "ok")
        return { kind: "failure", failure: workflowFailure(response) };
      const parsed = workflowBoundaryResponseSchema.safeParse(response.body);
      if (
        !parsed.success ||
        (parsed.data.result && parsed.data.result.executionId !== executionId)
      )
        return { kind: "invalid" };
      return parsed.data.result
        ? { kind: "done", value: parsed.data.result }
        : { kind: "pending" };
    },
  });
  if (observed.kind === "done")
    return {
      ok: true,
      data: {
        ...data,
        cursor: String(observed.value.cursor),
        result: observed.value,
      },
    };
  if (observed.kind === "failure") return { ...observed.failure, data };
  if (observed.kind === "invalid")
    return {
      ...invalid(
        "Workflow boundary responses remained unreadable; reattach to the same execution.",
      ),
      data,
    };
  return {
    ok: false,
    data,
    error: ccErrors.error("CC_OPERATION_FAILED", {
      message:
        observed.kind === "timeout"
          ? "The workflow wait timed out; the execution remains available."
          : "The workflow wait was interrupted; the execution remains available.",
      continuation,
    }),
    hint: hint(continuation, "Reattach to this execution boundary"),
  };
}
export const waitHandler: Read<typeof waitSpec> = {
  run: runner<Input<typeof waitSpec>, BoundaryData, CcErrorCode>({
    async run({ app, ctx }) {
      const timeoutMs = waitDurationMs(ctx.flags.timeout);
      if (timeoutMs === null)
        return usage("The wait duration exceeds the supported clock range.");
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return resolved;
      return waitBoundary({
        app,
        ctx,
        context: resolved.value,
        executionId: ctx.args["execution-id"],
        cursor: ctx.flags.cursor ?? null,
        timeoutMs,
      });
    },
    text: (data) => quoteLiteralText(boundaryText(data)),
  }),
};
type Run = Mutation<
  typeof runSpec,
  { context: SessionContext; timeoutMs: number; inputs: JsonObject | undefined }
>;
const runImplementation: Run = {
  decode: planPayloadSchema,
  async prepare({ app, ctx }) {
    if (app.env["CC_CONVERSATION_SCOPE"] === "project")
      return usage(
        "workflow run requires a session conversation; launch from an ordinary session conversation.",
      );
    if (ctx.flags.timeout !== undefined && !ctx.flags.wait)
      return usage("--timeout applies only with --wait.");
    const timeoutMs = waitDurationMs(ctx.flags.timeout ?? "30m");
    if (timeoutMs === null)
      return usage("The wait duration exceeds the supported clock range.");
    const inputs = parseInputBindings(ctx.flags.inputs);
    if (!inputs.ok) return inputs;
    const resolved = await resolveCcSession(app);
    return resolved.ok
      ? {
          ok: true,
          value: { context: resolved.value, timeoutMs, inputs: inputs.data },
        }
      : resolved;
  },
  commit: writeRunner<Parameters<Run["commit"]>[0], BoundaryData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const { context, inputs, timeoutMs } = prepared.value;
      const response = await cliRequest(app.host, {
        ...context,
        ...principal(app),
        method: "POST",
        path: `${graphPath(context)}/run`,
        body: { plan: payload, ...(inputs !== undefined ? { inputs } : {}) },
      });
      const target = recoveryFacts([{ kind: "session", id: context.session }]);
      if (response.kind !== "ok") return ccWriteFailure(response, target);
      const parsed = z
        .object({ receipt: cliGraphWorkflowLaunchReceiptSchema })
        .safeParse(response.body);
      if (!parsed.success) {
        const id = z
          .object({ receipt: z.object({ executionId: z.string().min(1) }) })
          .safeParse(response.body);
        return id.success
          ? {
              effect: "applied",
              recovery: recoveryFacts([
                { kind: "workflow-execution", id: id.data.receipt.executionId },
              ]),
              result: invalid(
                "The accepted workflow launch receipt was incomplete; inspect this execution.",
              ),
            }
          : {
              effect: "unknown",
              recovery: target,
              result: invalid(
                "The workflow launch acknowledgement was unreadable; inspect session status before retrying.",
              ),
            };
      }
      const receipt = parsed.data.receipt;
      const recovery = recoveryFacts([
        { kind: "workflow-execution", id: receipt.executionId },
      ]);
      if (ctx.flags.wait)
        return {
          effect: "applied",
          recovery,
          result: await waitBoundary({
            app,
            ctx,
            context,
            executionId: receipt.executionId,
            cursor: null,
            timeoutMs,
            receipt,
          }),
        };
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: { executionId: receipt.executionId, cursor: null, receipt },
          hint: hint(
            invocation(waitCommand, {
              args: { "execution-id": receipt.executionId },
              flags: {
                ...explicitScopeFlags(app),
                project: context.project,
                session: context.session,
              },
            }),
            "Observe the next execution boundary",
          ),
        },
      };
    },
    text: (data) => quoteLiteralText(boundaryText(data)),
  }),
};
export const runHandler = mutation(runImplementation);
export const startHandler: Write<typeof startSpec> = {
  run: writeRunner<
    Input<typeof startSpec>,
    z.infer<typeof startResponseSchema> & { definitionId: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const inputs = parseInputBindings(ctx.flags.inputs);
      if (!inputs.ok) return { effect: "not_applied", result: inputs };
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const context = resolved.value;
      const definitionId = ctx.args["definition-id"];
      const response = await writeResponse(
        app,
        {
          ...context,
          ...principal(app),
          ...callerHeaders(app),
          method: "POST",
          path: graphPath(context),
          body: {
            definitionId,
            ...(inputs.data ? { parameters: inputs.data } : {}),
          },
        },
        startResponseSchema,
        recoveryFacts([{ kind: "workflow-definition", id: definitionId }]),
        true,
      );
      if (response.effect !== "applied") return response;
      const data = { ...response.result.data, definitionId };
      const executionId = data.execution.executionId;
      if (!executionId.trim())
        return {
          effect: "unknown",
          recovery: response.recovery,
          result: invalid("The launch response has no durable execution id."),
        };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "workflow-execution", id: executionId },
        ]),
        result: {
          ok: true,
          data,
          ...(data.receipt?.status === "awaiting_definition_approval"
            ? {
                instruction: instruction(
                  "cc-workflow-definition-approval",
                  `Approve the pending workflow definition to resume execution ${executionId}.`,
                ),
              }
            : {
                hint: hint(
                  invocation(waitCommand, {
                    args: { "execution-id": executionId },
                    flags: {
                      ...explicitScopeFlags(app),
                      project: context.project,
                      session: context.session,
                    },
                  }),
                  "Observe the execution",
                ),
              }),
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        `${data.definitionId}: execution ${data.execution.executionId}, ${data.receipt?.status ?? data.execution.status}.\n${(data.receipt?.warnings ?? []).map((warning) => `${warning.path}: ${warning.message}`).join("\n")}\n`,
      ),
  }),
};
export const abandonHandler: Write<typeof abandonSpec> = {
  run: writeRunner<
    Input<typeof abandonSpec>,
    z.infer<typeof abandonResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return writeResponse(
        app,
        {
          ...resolved.value,
          ...principal(app),
          method: "POST",
          path: `${graphPath(resolved.value)}/abandon`,
          body: {
            executionId: ctx.args["execution-id"],
            reason: ctx.flags.reason,
          },
        },
        abandonResponseSchema,
        recoveryFacts([
          { kind: "workflow-execution", id: ctx.args["execution-id"] },
        ]),
        true,
      );
    },
    text: (data) =>
      quoteLiteralText(
        `Abandoned ${data.execution.executionId}; status ${data.execution.status}; archived ${data.execution.archived}.\n`,
      ),
  }),
};
const activeActSchema = z.object({
  execution: z
    .object({ executionId: z.string().min(1), status: z.string() })
    .catchall(jsonValueSchema),
  released: z.boolean().optional(),
});
type ActData = z.infer<typeof activeActSchema>;
async function act(
  app: CcApplication,
  action: "pause" | "resume" | "abort",
  reason?: string,
) {
  const resolved = await resolveCcSession(app);
  if (!resolved.ok) return { effect: "not_applied", result: resolved } as const;
  const response = await writeResponse(
    app,
    {
      ...resolved.value,
      ...principal(app),
      method: "POST",
      path: `${graphPath(resolved.value)}/${action}`,
      ...(reason ? { body: { reason } } : {}),
    },
    activeActSchema,
    recoveryFacts([{ kind: "session", id: resolved.value.session }]),
    true,
  );
  return response.effect === "applied"
    ? {
        ...response,
        recovery: recoveryFacts([
          {
            kind: "workflow-execution",
            id: response.result.data.execution.executionId,
          },
        ]),
      }
    : response;
}
function actText(data: JsonData<ActData>) {
  return `Execution ${data.execution.executionId}: ${data.execution.status}${data.released ? "; lease released" : ""}.\n`;
}
export const livePauseHandler: Write<typeof livePauseSpec> = {
  run: writeRunner<Input<typeof livePauseSpec>, ActData, CcErrorCode>({
    run: ({ app }) => act(app, "pause"),
    text: (data) => quoteLiteralText(actText(data)),
  }),
};
export const liveResumeHandler: Write<typeof liveResumeSpec> = {
  run: writeRunner<Input<typeof liveResumeSpec>, ActData, CcErrorCode>({
    run: ({ app }) => act(app, "resume"),
    text: (data) => quoteLiteralText(actText(data)),
  }),
};
export const liveAbortHandler: Write<typeof liveAbortSpec> = {
  run: writeRunner<Input<typeof liveAbortSpec>, ActData, CcErrorCode>({
    run: ({ app, ctx }) => act(app, "abort", ctx.flags.reason),
    text: (data) => quoteLiteralText(actText(data)),
  }),
};
