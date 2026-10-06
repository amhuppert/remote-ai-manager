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
  workflowLaunchRequestSchema,
  type WorkflowLaunchRequest,
} from "@/lib/runs/workflow-definition";
import {
  runAmendedResponseSchema,
  runControlResponseSchema,
  runDefinitionResponseSchema,
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
  type runAmendSpec,
  type runAnswerSpec,
  type runDefinitionSpec,
  type runCancelSpec,
  type runLaunchSpec,
  type runPauseSpec,
  type runResumeSpec,
  type runRetrySpec,
  type runShowSpec,
  type runWorkflowSpec,
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

type Amend = MutationHandler<
  typeof runAmendSpec,
  CcApplication,
  { context: SessionContext },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  WorkflowLaunchRequest
>;

type LaunchWorkflow = MutationHandler<
  typeof runWorkflowSpec,
  CcApplication,
  { context: SessionContext },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  WorkflowLaunchRequest
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
  /** While paused: whether admitted work is still finishing. */
  draining: boolean | null;
  needsOwner: string[];
  revision: number;
  ownerConversationId: string;
  contexts: Array<{
    key: string;
    contextId: string;
    dependsOn: string[];
    waitingOn: string[];
    started: boolean;
    skipped: boolean;
    loop: string | null;
    lane: string | null;
    waitingOnLaneProvision: string | null;
    waitingOnPublications: string[];
    pass: number;
    progress: string | null;
    /** While paused: whether its admitted work is still finishing. */
    draining: boolean | null;
    /** While paused and drained: the step it takes on resume. */
    next: string | null;
    /** The step it stands at while running or waiting. */
    step: string | null;
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
  halts: string[];
  loops: Array<{ key: string; pass: number; maxPasses: number; state: string }>;
  lanes: RunView["lanes"];
  definitionRevision: number;
}

type ContextProgressView = NonNullable<RunView["contexts"][number]["progress"]>;

/** The step a context's progress stands at: its obligation, or its state when it has none. */
function stepOf(progress: Exclude<ContextProgressView, { kind: "paused" }>): string {
  return progress.kind === "running" || progress.kind === "waiting" ? progress.obligation.kind : progress.kind;
}

/** A pause reads as draining while admitted work still finishes, and as drained once it has. */
function pausedLabel(draining: boolean | null, next: string | null = null, run = false): string {
  if (draining === true) return run ? "paused (draining: admitted work is still finishing)" : "paused (draining)";
  if (next !== null) return `paused (next: ${next})`;
  return run ? "paused (drained)" : "paused";
}

/**
 * A context under its run's pause: the run's permit holds it, not its own
 * pause, so it reads as finishing while admitted work drains and as held after.
 */
function heldByRunPause(draining: boolean, step: string): string {
  return draining ? "running (admitted work finishing under the run's pause)" : `held by the run's pause (next: ${step})`;
}

function toViewData(view: RunView): RunViewData {
  return {
    runId: view.runId,
    title: view.title,
    kind: view.kind,
    progress: view.progress.kind,
    draining: view.progress.kind === "paused" ? view.progress.draining : null,
    needsOwner:
      view.progress.kind === "needs_owner" ? view.progress.reasons : [],
    revision: view.revision,
    ownerConversationId: view.ownerConversationId,
    contexts: view.contexts.map((context) => ({
      key: context.key,
      contextId: context.contextId,
      dependsOn: context.dependsOn,
      waitingOn: context.waitingOn,
      started: context.started,
      skipped: context.skipped,
      loop: context.loop,
      lane: context.lane,
      waitingOnLaneProvision: context.waitingOnLaneProvision,
      waitingOnPublications: context.waitingOnPublications,
      pass: context.pass,
      progress: context.progress?.kind ?? null,
      draining: context.progress?.kind === "paused" ? context.progress.draining : null,
      next: context.progress?.kind === "paused" && context.progress.next !== null ? stepOf(context.progress.next) : null,
      step:
        context.progress?.kind === "running" || context.progress?.kind === "waiting" ? stepOf(context.progress) : null,
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
    halts: view.halts,
    loops: view.loops,
    lanes: view.lanes,
    definitionRevision: view.definitionRevision,
  };
}

/**
 * Why a context has no progress yet: the run's own state first, then what it
 * waits on. A recorded start no context took up yet reads as starting.
 */
function notStartedState(
  runProgress: string,
  context: {
    started: boolean;
    skipped: boolean;
    waitingOn: readonly string[];
    waitingOnLaneProvision: string | null;
    waitingOnPublications: readonly string[];
  },
): string {
  if (context.skipped) return "skipped (its route was not taken)";
  if (runProgress === "cancelled" || runProgress === "stopping")
    return "not started (run cancelled)";
  if (runProgress === "paused") return "not started (run paused)";
  if (context.started) return "starting";
  if (context.waitingOn.length > 0)
    return `not started, waits on ${context.waitingOn.join(", ")}`;
  if (context.waitingOnLaneProvision !== null)
    return `not started, waits for lane ${context.waitingOnLaneProvision} to be provisioned`;
  if (context.waitingOnPublications.length > 0)
    return `not started, waits for lane ${context.waitingOnPublications.join(", ")} to publish`;
  return "starting";
}

function viewText(view: JsonData<RunViewData>): string {
  const lines = [
    `Run ${view.runId} (${view.kind}, definition revision ${view.definitionRevision}): ${view.title} — ${view.progress === "paused" ? pausedLabel(view.draining, null, true) : view.progress}`,
  ];
  for (const reason of view.needsOwner) lines.push(`needs you: ${reason}`);
  for (const context of view.contexts) {
    const halt =
      context.halt !== null
        ? ` (${context.halt}; occurrence ${context.occurrence ?? "?"})`
        : "";
    const state =
      context.progress === "paused"
        ? pausedLabel(context.draining, context.next)
        : view.progress === "paused" && context.step !== null
          ? heldByRunPause(view.draining === true, context.step)
          : (context.progress ?? notStartedState(view.progress, context));
    const pass =
      context.loop === null ? "" : ` (loop ${context.loop}, pass ${context.pass})`;
    lines.push(
      `- ${context.key} [${context.contextId}]${pass}: ${state}${halt}`,
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
  for (const lane of view.lanes) {
    const attempt = lane.attempt === null ? "" : ` (attempt ${lane.attempt})`;
    const detail = lane.detail === null ? "" : `: ${lane.detail}`;
    const commit = lane.commit === null ? "" : ` as ${lane.commit}`;
    lines.push(
      `lane ${lane.key} [${lane.branch} at ${lane.worktreePath}]: ${lane.state}${attempt}${commit}${detail}`,
    );
  }
  for (const loop of view.loops)
    lines.push(
      `loop ${loop.key}: pass ${loop.pass} of ${loop.maxPasses}, ${loop.state}`,
    );
  for (const halt of view.halts)
    if (!view.needsOwner.includes(halt)) lines.push(`cannot proceed: ${halt}`);
  for (const boundary of view.boundaries.slice(-5)) {
    lines.push(
      `boundary ${boundary.seq} ${boundary.kind}: ${boundary.summary}`,
    );
  }
  if (view.stalled.length > 0)
    lines.push(`stalled: ${view.stalled.join(", ")} — resume to reconcile`);
  return quoteLiteralText(`${lines.join("\n")}\n`);
}

/** Posts a launch payload to `suffix` and turns the receipt into the CLI result. */
async function postLaunch(input: {
  app: CcApplication;
  context: SessionContext;
  suffix: string;
  payload: unknown;
}) {
  const { app, context } = input;
  const target = recoveryFacts([sessionReference(context.session)]);
  const response = await cliRequest(app.host, {
    ...context,
    method: "POST",
    path: `${sessionPath(context)}/runs${input.suffix}`,
    body: input.payload,
    principalIdentity: resolveCcPrincipal(app),
  });
  if (response.kind !== "ok") return ccWriteFailure(response, target);
  const parsed = runLaunchedResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return {
      effect: "unknown" as const,
      recovery: target,
      result: invalid("The run endpoint did not return a launch receipt."),
    };
  }
  return {
    effect: "applied" as const,
    recovery: recoveryFacts([{ kind: "run", id: parsed.data.runId }]),
    result: {
      ok: true as const,
      data: parsed.data,
      hint: showHint(app, parsed.data.runId),
    },
  };
}

const launchedText = (data: JsonData<RunLaunchedResponse>) =>
  quoteLiteralText(
    `Run ${data.runId} launched (${data.progress.kind}). Its questions, halts and result arrive as run-boundary messages.\n`,
  );

async function prepareSession({ app }: { app: CcApplication }) {
  const context = await resolveCcSession(app);
  return context.ok
    ? ({ ok: true, value: { context: context.value } } as const)
    : context;
}

const launchImplementation: Launch = {
  decode: agentLaunchRequestSchema,
  prepare: prepareSession,
  commit: writeRunner<
    Parameters<Launch["commit"]>[0],
    RunLaunchedResponse,
    CcErrorCode
  >({
    run: ({ app, payload, prepared }) =>
      postLaunch({ app, context: prepared.value.context, suffix: "", payload }),
    text: launchedText,
  }),
};
export const launchHandler = mutation(launchImplementation);

const workflowImplementation: LaunchWorkflow = {
  decode: workflowLaunchRequestSchema,
  prepare: prepareSession,
  commit: writeRunner<
    Parameters<LaunchWorkflow["commit"]>[0],
    RunLaunchedResponse,
    CcErrorCode
  >({
    run: ({ app, payload, prepared }) =>
      postLaunch({
        app,
        context: prepared.value.context,
        suffix: "/workflow",
        payload,
      }),
    text: launchedText,
  }),
};
export const workflowHandler = mutation(workflowImplementation);

interface AmendData {
  runId: string;
  revision: number;
  progress: string | null;
  halts: string[];
}

const amendImplementation: Amend = {
  decode: workflowLaunchRequestSchema,
  prepare: prepareSession,
  commit: writeRunner<Parameters<Amend["commit"]>[0], AmendData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const runId = ctx.args["run-id"];
      const basedOn = ctx.flags["based-on"];
      const recovery = recoveryFacts([{ kind: "run", id: runId }]);
      const response = await cliRequest(app.host, {
        ...prepared.value.context,
        method: "POST",
        path: `${runPath(prepared.value.context, runId)}/amend`,
        body: { definition: payload, ...(basedOn !== undefined ? { basedOn } : {}) },
        principalIdentity: resolveCcPrincipal(app),
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = runAmendedResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown" as const,
          recovery,
          result: invalid("The amendment acknowledgement is invalid; read run show before retrying."),
        };
      return {
        effect: "applied" as const,
        recovery,
        result: {
          ok: true as const,
          data: {
            runId,
            revision: parsed.data.revision,
            progress: parsed.data.progress?.kind ?? null,
            halts: parsed.data.halts,
          },
          hint: showHint(app, runId),
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        [
          `Run ${data.runId}: definition revision ${data.revision} in force${data.progress === null ? "" : ` (${data.progress})`}.`,
          ...data.halts.map((halt) => `still cannot proceed: ${halt}`),
        ].join("\n") + "\n",
      ),
  }),
};
export const amendHandler = mutation(amendImplementation);

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

/**
 * JSON whose text survives being printed and saved: JSON leaves DEL, C1 controls
 * and the line and paragraph separators raw inside strings, which the literal
 * quoting would mark up and which line readers split on.
 */
function escapedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

interface DefinitionData {
  runId: string;
  revision: number;
  /** The workflow as written, JSON-encoded; null for an agent run. */
  definition: string | null;
}

export const definitionHandler: Read<typeof runDefinitionSpec> = {
  run: runner<Input<typeof runDefinitionSpec>, DefinitionData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${runPath(resolved.value, ctx.args["run-id"])}/definition`,
        principalIdentity: resolveCcPrincipal(app),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = runDefinitionResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.runId !== ctx.args["run-id"])
        return invalid("The run definition is invalid.");
      const { definition } = parsed.data;
      return {
        ok: true,
        data: {
          runId: parsed.data.runId,
          revision: parsed.data.revision,
          definition: definition === null ? null : escapedJson(definition),
        },
      };
    },
    // The definition alone, so it can be saved to a file, edited and amended.
    text: (data) =>
      quoteLiteralText(
        data.definition === null
          ? `Run ${data.runId} has no workflow definition to amend: it runs one agent, or was launched before definitions were kept.\n`
          : `${data.definition}\n`,
      ),
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

export const retryHandler: Write<typeof runRetrySpec> = {
  run: writeRunner<Input<typeof runRetrySpec>, { runId: string }, CcErrorCode>(
    {
      run: ({ app, ctx }) =>
        runWrite({
          app,
          runId: ctx.args["run-id"],
          suffix: "control",
          body: { action: "retry", lane: ctx.flags.lane },
          schema: runControlResponseSchema,
        }),
      text: ({ runId }) =>
        quoteLiteralText(`Run ${runId}: the lane will try again.\n`),
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
