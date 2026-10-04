/**
 * Agent-facing Run endpoints for the shared supervision path.
 *
 * - POST /api/projects/[name]/sessions/[session]/runs                → launch an agent run
 * - GET  /api/projects/[name]/sessions/[session]/runs/[runId]        → the run view
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/answer → answer a seat's question
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/control → pause | resume | cancel
 * - POST /api/projects/[name]/sessions/[session]/runs/[runId]/decide → human approval decision (people only)
 * - POST /api/projects/[name]/sessions/[session]/contexts/tasks      → a seat's task command
 *
 * The calling conversation is the principal: it owns the runs it launches, and
 * only the owner steers or answers them. A seat conversation changes tasks only
 * in the Context its seat binding names.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CONVERSATION_IDENTITY_HEADER,
  readConversationIdentity,
} from "@/lib/agent-gateway/conversation-identity";
import { LANE_IDENTITY_HEADER } from "@/lib/agent-gateway/lane-identity";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { ContextInputRefusedError } from "@/lib/execution-context/advance";
import { haltDispositionSchema } from "@/lib/execution-context/schemas";
import type { Logger } from "@/lib/logging";
import {
  jsonError,
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import {
  agentLaunchRequestSchema,
  resolveAgentLaunch,
  type AgentLaunchRequest,
  type ResolvedSeat,
} from "./launch";
import { RunControlRefusedError } from "./host";
import { describeRun } from "./observation";
import type { RunRecord } from "./schemas";
import type { RunSupervision } from "./supervision";

type RouteContext = { params: Promise<Record<string, string>> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

export interface RunRouteDeps {
  auth: Pick<AgentAuth, "requireToken" | "validateOptionalToken">;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    sessionName: string;
    worktreePath: string;
    conversations: Array<{ id: string }>;
  } | null>;
  supervision(): RunSupervision;
  /** Backend, model selection and admission for every seat the launch names. */
  resolveSeats(input: {
    projectPath: string;
    request: AgentLaunchRequest;
  }): Promise<
    | {
        ok: true;
        seats: { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };
      }
    | { ok: false; status: number; error: string; code?: string }
  >;
  newRunId(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

const answerSchema = z
  .object({ questionId: z.string().min(1), text: z.string().min(1) })
  .strict();
const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z
    .object({
      action: z.literal("resume"),
      dispositions: z
        .array(
          z
            .object({
              contextId: z.string().min(1),
              occurrence: z.string().min(1),
              disposition: haltDispositionSchema,
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);
const decideSchema = z
  .object({
    contextId: z.string().min(1),
    candidateId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().min(1).optional(),
  })
  .strict();
const taskCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete"), taskId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reopen"), taskId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("add"),
      taskId: z.string().min(1),
      title: z.string().min(1),
      instructions: z.string().min(1).optional(),
    })
    .strict(),
]);

/** Refusals the Run or a Context reports without changing anything; anything else is a fault. */
function isRefusal(error: unknown): error is Error {
  return (
    error instanceof RunControlRefusedError ||
    error instanceof ContextInputRefusedError
  );
}

interface Caller {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  what: string,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError("Request body must be JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: `Invalid ${what}`,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    ),
  };
}

export function createRunRouteHandlers(
  deps: RunRouteDeps,
): Record<
  "launch" | "show" | "answer" | "control" | "decide" | "tasks",
  Handler
> {
  /** Token, session and a verified calling conversation of that session. */
  async function resolveCaller(
    request: Request,
    context: RouteContext,
  ): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return { ok: false, response: denied };
    const { name, session } = await context.params;
    const resolved = await resolveProjectSessionOr404(
      deps,
      name ?? "",
      session ?? "",
    );
    if (!resolved.ok) return resolved;
    const { projectPath, session: sessionState } = resolved.value;
    const identity = readConversationIdentity(
      request.headers.get(CONVERSATION_IDENTITY_HEADER),
    );
    if (
      identity.kind !== "valid" ||
      identity.scope.sessionName !== sessionState.sessionName ||
      !sessionState.conversations.some(
        (conversation) => conversation.id === identity.scope.conversationId,
      )
    ) {
      return {
        ok: false,
        response: jsonError(
          "Runs are launched and steered by a conversation of this session",
          403,
          "conversation_identity_required",
          undefined,
          "Run this command from an agent conversation in the session.",
        ),
      };
    }
    return {
      ok: true,
      caller: {
        projectPath,
        sessionName: sessionState.sessionName,
        worktreePath: sessionState.worktreePath,
        conversationId: identity.scope.conversationId,
      },
    };
  }

  /** The caller's own run in this session; anyone else gets a refusal naming the owner. */
  async function resolveOwnedRun(
    request: Request,
    context: RouteContext,
  ): Promise<
    | { ok: true; caller: Caller; run: RunRecord }
    | { ok: false; response: Response }
  > {
    const resolved = await resolveCaller(request, context);
    if (!resolved.ok) return resolved;
    const { runId } = await context.params;
    const run = deps.supervision().runs.observe(runId ?? "")?.record ?? null;
    if (
      run === null ||
      run.projectPath !== resolved.caller.projectPath ||
      run.sessionName !== resolved.caller.sessionName
    ) {
      return { ok: false, response: notFound(`Run "${runId}" not found`) };
    }
    if (run.ownerConversationId !== resolved.caller.conversationId) {
      return {
        ok: false,
        response: jsonError(
          `Only the conversation that launched run ${run.runId} can steer it`,
          403,
          "not_run_owner",
          { ownerConversationId: run.ownerConversationId },
        ),
      };
    }
    return { ok: true, caller: resolved.caller, run };
  }

  return {
    async launch(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(
        request,
        agentLaunchRequestSchema,
        "agent run launch",
      );
      if (!body.ok) return body.response;
      if (body.value.humanApproval === true) {
        return jsonError(
          "Human approval is not available for agent runs yet: no Command Center surface lets Alex make the decision",
          400,
          "human_approval_unavailable",
          undefined,
          "Launch without humanApproval and review the result yourself, or ask Alex.",
        );
      }
      const { caller } = resolved;
      // A seat's child would bind the workspace the seat's own context holds and
      // wait for it, while the seat waits for the child.
      if (deps.supervision().core.seatBinding(caller.conversationId) !== null) {
        return jsonError(
          "A supervised seat cannot launch runs",
          403,
          "seat_cannot_launch",
          undefined,
          "Finish your assigned work, or ask your owner with cctl ask.",
        );
      }
      const seats = await deps.resolveSeats({
        projectPath: caller.projectPath,
        request: body.value,
      });
      if (!seats.ok) {
        return NextResponse.json(
          {
            error: seats.error,
            ...(seats.code !== undefined ? { code: seats.code } : {}),
          },
          { status: seats.status },
        );
      }
      const runId = deps.newRunId();
      const launch = resolveAgentLaunch({
        request: body.value,
        runId,
        cause: `launch:${runId}`,
        projectPath: caller.projectPath,
        session: {
          sessionName: caller.sessionName,
          worktreePath: caller.worktreePath,
        },
        owner: {
          conversationId: caller.conversationId,
          sessionName: caller.sessionName,
        },
        seats: seats.seats,
      });
      const record = await deps.supervision().runs.launch(launch);
      deps.log.info("runs.launched", {
        runId,
        sessionName: caller.sessionName,
        conversationId: caller.conversationId,
        backend: seats.seats.implementer.backend,
      });
      return NextResponse.json(
        {
          runId,
          contextIds: launch.invocations.map(
            (invocation) => invocation.request.contextId,
          ),
          progress: record.progress,
        },
        { status: 202 },
      );
    },

    async show(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const { runId } = await context.params;
      const supervision = deps.supervision();
      const run = supervision.runs.observe(runId ?? "")?.record ?? null;
      const inSession =
        run !== null &&
        run.projectPath === resolved.caller.projectPath &&
        run.sessionName === resolved.caller.sessionName;
      const view = inSession ? describeRun(supervision, run.runId) : null;
      if (view === null) return notFound(`Run "${runId}" not found`);
      return NextResponse.json(view);
    },

    async answer(request, context) {
      const owned = await resolveOwnedRun(request, context);
      if (!owned.ok) return owned.response;
      const body = await readBody(request, answerSchema, "answer");
      if (!body.ok) return body.response;
      const supervision = deps.supervision();
      const question = supervision.requests.question(body.value.questionId);
      const seat =
        question === null
          ? null
          : supervision.core.seatBinding(question.conversationId);
      const belongs =
        seat !== null &&
        owned.run.facts.invocations.some((i) => i.contextId === seat.contextId);
      if (!belongs)
        return notFound(
          `Question "${body.value.questionId}" is not open in run ${owned.run.runId}`,
        );
      if (
        !supervision.requests.answer(body.value.questionId, body.value.text)
      ) {
        return jsonError(
          `Question "${body.value.questionId}" is no longer open`,
          409,
          "question_closed",
        );
      }
      deps.log.info("runs.question_answered", {
        runId: owned.run.runId,
        questionId: body.value.questionId,
      });
      return NextResponse.json({ ok: true });
    },

    async control(request, context) {
      const owned = await resolveOwnedRun(request, context);
      if (!owned.ok) return owned.response;
      const body = await readBody(request, controlSchema, "run control");
      if (!body.ok) return body.response;
      const runs = deps.supervision().runs;
      const { runId } = owned.run;
      // The CLI holds no revision, so the act applies to the run as it is now.
      try {
        if (body.value.action === "pause") await runs.pause(runId, null);
        if (body.value.action === "resume")
          await runs.resume(runId, null, body.value.dispositions ?? []);
        if (body.value.action === "cancel") await runs.cancel(runId, null);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.control_refused", {
          runId,
          action: body.value.action,
          error: error.message,
        });
        return jsonError(error.message, 409, "run_control_refused");
      }
      deps.log.info("runs.control_applied", {
        runId,
        action: body.value.action,
      });
      return NextResponse.json({
        ok: true,
        progress: runs.observe(runId)?.record.progress ?? null,
      });
    },

    // Human approval is a person's decision: no agent credential may make it,
    // including the run's owner (design §5.5, §7.7).
    async decide(request, context) {
      const transport = await deps.auth.validateOptionalToken(request);
      if (transport.kind === "invalid") return jsonError("Invalid token", 401);
      const presentsAgent =
        transport.kind === "valid" ||
        request.headers.has(CONVERSATION_IDENTITY_HEADER) ||
        request.headers.has(LANE_IDENTITY_HEADER);
      if (presentsAgent) {
        return jsonError(
          "Only a person decides a result awaiting human approval",
          403,
          "human_decision_required",
          undefined,
          "Tell Alex the run, context and candidate awaiting the decision; agents cannot approve it.",
        );
      }
      const { name, session, runId } = await context.params;
      const resolved = await resolveProjectSessionOr404(
        deps,
        name ?? "",
        session ?? "",
      );
      if (!resolved.ok) return resolved.response;
      const run = deps.supervision().runs.observe(runId ?? "")?.record ?? null;
      if (
        run === null ||
        run.projectPath !== resolved.value.projectPath ||
        run.sessionName !== resolved.value.session.sessionName
      ) {
        return notFound(`Run "${runId}" not found`);
      }
      const body = await readBody(request, decideSchema, "approval decision");
      if (!body.ok) return body.response;
      const { contextId, ...decision } = body.value;
      try {
        deps.supervision().runs.decide(run.runId, contextId, decision);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        deps.log.warn("runs.decision_refused", {
          runId: run.runId,
          contextId,
          error: error.message,
        });
        return jsonError(error.message, 409, "decision_refused");
      }
      deps.log.info("runs.decision_recorded", {
        runId: run.runId,
        contextId,
        decision: decision.decision,
      });
      return NextResponse.json({ ok: true });
    },

    async tasks(request, context) {
      const resolved = await resolveCaller(request, context);
      if (!resolved.ok) return resolved.response;
      const body = await readBody(request, taskCommandSchema, "task command");
      if (!body.ok) return body.response;
      const supervision = deps.supervision();
      const seat = supervision.core.seatBinding(resolved.caller.conversationId);
      if (seat === null) {
        return jsonError(
          "Only a supervised seat conversation changes its context's tasks",
          403,
          "not_a_seat",
        );
      }
      const result = supervision.contexts.applyTaskCommand(
        seat.contextId,
        seat,
        body.value,
      );
      if (result.kind === "refused")
        return jsonError(result.reason, 409, "task_command_refused");
      return NextResponse.json({ ok: true, contextId: seat.contextId });
    },
  };
}

export const newRunId = (): string => `run-${randomUUID()}`;
