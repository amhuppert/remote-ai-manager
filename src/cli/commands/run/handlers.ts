import {
  invocation,
  mutation,
  recoveryFacts,
  runner,
  writeRunner,
  type CommandSpec,
  type HandlerInput,
  type JsonData,
  type MutationHandler,
  type ReadHandler,
  type WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  agentLaunchRequestSchema,
  type AgentLaunchRequest,
} from "@/lib/runs/launch";
import {
  runControlResponseSchema,
  runLaunchedResponseSchema,
  runViewSchema,
  type RunLaunchedResponse,
  type RunView,
} from "@/lib/runs/schemas";
import { quoteLiteralText } from "../../framework/literal-text";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcPrincipal,
  resolveCcSession,
  sessionReference,
  type CcErrorCode,
} from "../../framework/context";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import {
  cliRequest,
  encodePathSegment,
  type SessionContext,
} from "../../transport";
import {
  runShowCommand,
  type contextTaskAddSpec,
  type contextTaskCompleteSpec,
  type contextTaskReopenSpec,
  type runAnswerSpec,
  type runCancelSpec,
  type runLaunchSpec,
  type runPauseSpec,
  type runResumeSpec,
  type runShowSpec,
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
type Launch = MutationHandler<
  typeof runLaunchSpec,
  CcApplication,
  { context: SessionContext },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  AgentLaunchRequest
>;

const okSchema = z.object({ ok: z.literal(true) }).passthrough();

const invalid = (message: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  }) as const;
const usage = (message: string) =>
  ({ ok: false, error: ccErrors.error("CC_USAGE", { message }) }) as const;

function sessionPath(context: SessionContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}`;
}
function runPath(context: SessionContext, runId: string): string {
  return `${sessionPath(context)}/runs/${encodePathSegment(runId)}`;
}

function showHint(app: CcApplication, runId: string) {
  return hint(
    invocation(runShowCommand, {
      flags: explicitScopeFlags(app),
      args: { "run-id": runId },
    }),
    "Read the run's progress",
  );
}

/** The run view flattened to what an owner acts on; nested progress unions become labels. */
interface RunViewData {
  runId: string;
  title: string;
  kind: string;
  progress: string;
  needsOwner: string[];
  revision: number;
  ownerConversationId: string;
  contexts: Array<{
    key: string;
    contextId: string;
    progress: string | null;
    halt: string | null;
    occurrence: string | null;
    tasks: Array<{ id: string; title: string; status: string }>;
    seats: Record<string, string>;
    openQuestions: Array<{
      questionId: string;
      seat: string;
      text: string | null;
    }>;
    lastSummary: string | null;
    /** The accepted result, JSON-encoded. */
    output: string | null;
  }>;
  boundaries: Array<{
    seq: number;
    kind: string;
    summary: string;
    recordedAt: string;
    notified: boolean;
  }>;
  stalled: string[];
}

function toViewData(view: RunView): RunViewData {
  return {
    runId: view.runId,
    title: view.title,
    kind: view.kind,
    progress: view.progress.kind,
    needsOwner:
      view.progress.kind === "needs_owner" ? view.progress.reasons : [],
    revision: view.revision,
    ownerConversationId: view.ownerConversationId,
    contexts: view.contexts.map((context) => ({
      key: context.key,
      contextId: context.contextId,
      progress: context.progress?.kind ?? null,
      halt:
        context.progress?.kind === "halted"
          ? `${context.progress.halt}: ${context.progress.detail}`
          : null,
      occurrence: context.occurrence,
      tasks: context.tasks,
      seats: context.seats,
      openQuestions: context.openQuestions,
      lastSummary: context.lastSummary,
      output:
        context.output === null || context.output === undefined
          ? null
          : JSON.stringify(context.output),
    })),
    boundaries: view.boundaries,
    stalled: view.stalled,
  };
}

function viewText(view: JsonData<RunViewData>): string {
  const lines = [
    `Run ${view.runId} (${view.kind}): ${view.title} — ${view.progress}`,
  ];
  for (const reason of view.needsOwner) lines.push(`needs you: ${reason}`);
  for (const context of view.contexts) {
    const halt =
      context.halt !== null
        ? ` (${context.halt}; occurrence ${context.occurrence ?? "?"})`
        : "";
    lines.push(
      `- ${context.key} [${context.contextId}]: ${context.progress ?? "not started"}${halt}`,
    );
    for (const task of context.tasks)
      lines.push(`  task ${task.id} ${task.status}: ${task.title}`);
    for (const question of context.openQuestions) {
      lines.push(
        `  question ${question.questionId} from ${question.seat}: ${question.text ?? "(unreadable)"}`,
      );
    }
    if (context.lastSummary !== null)
      lines.push(`  last summary: ${context.lastSummary}`);
    if (context.output !== null) lines.push(`  result: ${context.output}`);
  }
  for (const boundary of view.boundaries.slice(-5)) {
    lines.push(
      `boundary ${boundary.seq} ${boundary.kind}: ${boundary.summary}`,
    );
  }
  if (view.stalled.length > 0)
    lines.push(`stalled: ${view.stalled.join(", ")} — resume to reconcile`);
  return quoteLiteralText(`${lines.join("\n")}\n`);
}

const launchImplementation: Launch = {
  decode: agentLaunchRequestSchema,
  async prepare({ app }) {
    const context = await resolveCcSession(app);
    return context.ok
      ? { ok: true, value: { context: context.value } }
      : context;
  },
  commit: writeRunner<
    Parameters<Launch["commit"]>[0],
    RunLaunchedResponse,
    CcErrorCode
  >({
    async run({ app, payload, prepared }) {
      const { context } = prepared.value;
      const target = recoveryFacts([sessionReference(context.session)]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: `${sessionPath(context)}/runs`,
        body: payload,
        principalIdentity: resolveCcPrincipal(app),
      });
      if (response.kind !== "ok") return ccWriteFailure(response, target);
      const parsed = runLaunchedResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          effect: "unknown",
          recovery: target,
          result: invalid("The run endpoint did not return a launch receipt."),
        };
      }
      return {
        effect: "applied",
        recovery: recoveryFacts([{ kind: "run", id: parsed.data.runId }]),
        result: {
          ok: true,
          data: parsed.data,
          hint: showHint(app, parsed.data.runId),
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        `Run ${data.runId} launched (${data.progress.kind}). Its questions, halts and result arrive as run-boundary messages.\n`,
      ),
  }),
};
export const launchHandler = mutation(launchImplementation);

export const showHandler: Read<typeof runShowSpec> = {
  run: runner<Input<typeof runShowSpec>, RunViewData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: runPath(resolved.value, ctx.args["run-id"]),
        principalIdentity: resolveCcPrincipal(app),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = runViewSchema.safeParse(response.body);
      return parsed.success && parsed.data.runId === ctx.args["run-id"]
        ? { ok: true, data: toViewData(parsed.data) }
        : invalid("The run view is invalid.");
    },
    text: viewText,
  }),
};

/** One owner write against a run: POST, parse the acknowledgement, point at run show. */
async function runWrite<T extends z.ZodType>(input: {
  app: CcApplication;
  runId: string;
  suffix: string;
  body: unknown;
  schema: T;
}) {
  const resolved = await resolveCcSession(input.app);
  if (!resolved.ok) return { effect: "not_applied" as const, result: resolved };
  const recovery = recoveryFacts([{ kind: "run", id: input.runId }]);
  const response = await cliRequest(input.app.host, {
    ...resolved.value,
    method: "POST",
    path: `${runPath(resolved.value, input.runId)}/${input.suffix}`,
    body: input.body,
    principalIdentity: resolveCcPrincipal(input.app),
  });
  if (response.kind !== "ok") return ccWriteFailure(response, recovery);
  const parsed = input.schema.safeParse(response.body);
  if (!parsed.success) {
    return {
      effect: "unknown" as const,
      recovery,
      result: invalid(
        "The run acknowledgement is invalid; read run show before retrying.",
      ),
    };
  }
  return {
    effect: "applied" as const,
    recovery,
    result: {
      ok: true as const,
      data: { runId: input.runId },
      hint: showHint(input.app, input.runId),
    },
  };
}

export const answerHandler: Write<typeof runAnswerSpec> = {
  run: writeRunner<Input<typeof runAnswerSpec>, { runId: string }, CcErrorCode>(
    {
      run: ({ app, ctx }) =>
        runWrite({
          app,
          runId: ctx.args["run-id"],
          suffix: "answer",
          body: { questionId: ctx.flags.question, text: ctx.flags.text },
          schema: okSchema,
        }),
      text: ({ runId }) =>
        quoteLiteralText(
          `Answered; the agent in run ${runId} continues with your answer.\n`,
        ),
    },
  ),
};

export const pauseHandler: Write<typeof runPauseSpec> = {
  run: writeRunner<Input<typeof runPauseSpec>, { runId: string }, CcErrorCode>({
    run: ({ app, ctx }) =>
      runWrite({
        app,
        runId: ctx.args["run-id"],
        suffix: "control",
        body: { action: "pause" },
        schema: runControlResponseSchema,
      }),
    text: ({ runId }) =>
      quoteLiteralText(
        `Run ${runId}: pausing; admitted work finishes first.\n`,
      ),
  }),
};
export const cancelHandler: Write<typeof runCancelSpec> = {
  run: writeRunner<Input<typeof runCancelSpec>, { runId: string }, CcErrorCode>(
    {
      run: ({ app, ctx }) =>
        runWrite({
          app,
          runId: ctx.args["run-id"],
          suffix: "control",
          body: { action: "cancel" },
          schema: runControlResponseSchema,
        }),
      text: ({ runId }) => quoteLiteralText(`Run ${runId}: cancelling.\n`),
    },
  ),
};

export const resumeHandler: Write<typeof runResumeSpec> = {
  run: writeRunner<Input<typeof runResumeSpec>, { runId: string }, CcErrorCode>(
    {
      async run({ app, ctx }) {
        const {
          context,
          occurrence,
          disposition,
          allowance,
          count,
          reason,
          evidence,
        } = ctx.flags;
        const named = [context, occurrence, disposition].filter(
          (value) => value !== undefined,
        ).length;
        if (named !== 0 && named !== 3) {
          return {
            effect: "not_applied",
            result: usage(
              "--context, --occurrence and --disposition go together.",
            ),
          };
        }
        let body: unknown = { action: "resume" };
        if (
          context !== undefined &&
          occurrence !== undefined &&
          disposition !== undefined
        ) {
          let chosen: Record<string, unknown> = { kind: disposition };
          if (disposition === "grant") {
            if (
              allowance === undefined ||
              count === undefined ||
              reason === undefined
            ) {
              return {
                effect: "not_applied",
                result: usage(
                  "A grant needs --allowance, --count and --reason.",
                ),
              };
            }
            chosen = { kind: "grant", allowance, count, reason };
          }
          if (disposition === "confirm_effect") {
            if (evidence === undefined)
              return {
                effect: "not_applied",
                result: usage("confirm_effect needs --evidence."),
              };
            chosen = { kind: "confirm_effect", evidence };
          }
          if (disposition === "rereview") {
            if (reason === undefined)
              return {
                effect: "not_applied",
                result: usage("A rereview needs --reason."),
              };
            chosen = { kind: "rereview", reason };
          }
          body = {
            action: "resume",
            dispositions: [
              { contextId: context, occurrence, disposition: chosen },
            ],
          };
        }
        return runWrite({
          app,
          runId: ctx.args["run-id"],
          suffix: "control",
          body,
          schema: runControlResponseSchema,
        });
      },
      text: ({ runId }) => quoteLiteralText(`Run ${runId}: resumed.\n`),
    },
  ),
};

/** A seat's task command; the server resolves the context from the calling conversation. */
async function taskWrite(app: CcApplication, body: Record<string, unknown>) {
  const resolved = await resolveCcSession(app);
  if (!resolved.ok) return { effect: "not_applied" as const, result: resolved };
  const recovery = recoveryFacts([sessionReference(resolved.value.session)]);
  const response = await cliRequest(app.host, {
    ...resolved.value,
    method: "POST",
    path: `${sessionPath(resolved.value)}/contexts/tasks`,
    body,
    principalIdentity: resolveCcPrincipal(app),
  });
  if (response.kind !== "ok") return ccWriteFailure(response, recovery);
  const parsed = z
    .object({ ok: z.literal(true), contextId: z.string() })
    .safeParse(response.body);
  if (!parsed.success) {
    return {
      effect: "unknown" as const,
      recovery,
      result: invalid("The task acknowledgement is invalid."),
    };
  }
  return {
    effect: "applied" as const,
    recovery,
    result: {
      ok: true as const,
      data: { taskId: String(body.taskId), contextId: parsed.data.contextId },
    },
  };
}

export const taskCompleteHandler: Write<typeof contextTaskCompleteSpec> = {
  run: writeRunner<
    Input<typeof contextTaskCompleteSpec>,
    { taskId: string; contextId: string },
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      taskWrite(app, { kind: "complete", taskId: ctx.args["task-id"] }),
    text: ({ taskId }) => quoteLiteralText(`Task ${taskId} done.\n`),
  }),
};
export const taskReopenHandler: Write<typeof contextTaskReopenSpec> = {
  run: writeRunner<
    Input<typeof contextTaskReopenSpec>,
    { taskId: string; contextId: string },
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      taskWrite(app, { kind: "reopen", taskId: ctx.args["task-id"] }),
    text: ({ taskId }) => quoteLiteralText(`Task ${taskId} reopened.\n`),
  }),
};
export const taskAddHandler: Write<typeof contextTaskAddSpec> = {
  run: writeRunner<
    Input<typeof contextTaskAddSpec>,
    { taskId: string; contextId: string },
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      taskWrite(app, {
        kind: "add",
        taskId: ctx.args["task-id"],
        title: ctx.flags.title,
        ...(ctx.flags.instructions !== undefined
          ? { instructions: ctx.flags.instructions }
          : {}),
      }),
    text: ({ taskId }) => quoteLiteralText(`Task ${taskId} added.\n`),
  }),
};
