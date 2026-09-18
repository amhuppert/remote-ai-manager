import { quoteLiteralText } from "../../framework/literal-text";
import type {
  CommandSpec,
  Failure,
  HandlerInput,
  Invocation,
  ReadHandler,
  ReportedRecovery,
  WriteHandler,
} from "cli-for-agents";
import {
  checkpointAdvice,
  checkpointRationale,
  checkpointRefusal,
} from "./checkpoint-guidance";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  conversationTargetApiBase,
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  cliRequest,
  encodePathSegment,
  readConversationScope,
  readSessionEnv,
  type TokenSource,
} from "../../transport";
import {
  resolveCcProject,
  type CcContextResult,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  ccRequestFailure,
  ccWriteFailure,
  type CcFailedRequest,
  type CcWriteFailure,
} from "../../framework/request";

export type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export interface NativeTarget {
  server: string;
  explicitServer?: string;
  token: string | null;
  tokenSource: TokenSource | null;
  target: ConversationTarget;
  callerConversationId: string | null;
}

export async function resolveTarget(
  app: CcApplication,
  positional: string | undefined,
): Promise<CcContextResult<NativeTarget>> {
  const base = await resolveCcProject(app);
  if (!base.ok) return base;
  const id =
    positional ?? app.globals.conversation ?? app.env["CC_CONVERSATION_ID"];
  if (!id)
    return {
      ok: false,
      error: ccErrors.error("CC_USAGE", {
        message:
          "no conversation — pass <conversation-id>, --conversation, or set CC_CONVERSATION_ID",
      }),
    };
  const session =
    app.globals.session ??
    (app.globals.project || readConversationScope(app.env) === "project"
      ? null
      : readSessionEnv(app.env));
  return {
    ok: true,
    value: {
      server: base.value.server,
      ...(app.globals.server === undefined
        ? {}
        : { explicitServer: app.globals.server }),
      token: base.value.token,
      tokenSource: base.value.tokenSource,
      target:
        session === null
          ? projectConversationTarget(base.value.project, id)
          : sessionConversationTarget(base.value.project, session, id),
      callerConversationId: app.env["CC_CONVERSATION_ID"] ?? null,
    },
  };
}

export function basePath(target: NativeTarget): string {
  return conversationTargetApiBase(target.target);
}
export function requestParams(target: NativeTarget) {
  return {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    ...(target.callerConversationId === null
      ? {}
      : { headers: { "x-cc-conversation-id": target.callerConversationId } }),
  };
}
export function scopeFlags(target: NativeTarget) {
  return {
    ...(target.explicitServer === undefined
      ? {}
      : { server: target.explicitServer }),
    project: target.target.projectName,
    ...(target.target.scope === "session"
      ? { session: target.target.sessionName }
      : {}),
  };
}
export function invalidResponse(noun: string): Failure<never, CcErrorCode> {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The server returned an invalid ${noun} response.`,
    }),
  };
}
export function isScopeMiss(response: CcFailedRequest): boolean {
  return (
    response.kind === "error" &&
    response.status === 404 &&
    (response.code === "conversation_not_found" ||
      response.error === "Session not found" ||
      response.error === "Project not found")
  );
}
const ownerSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("project"), projectName: z.string().min(1) }),
  z.object({
    scope: z.literal("session"),
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
  }),
]);

/** Owner discovery can advise a scoped mutation, but never authorizes retrying it. */
export async function mutationFailure(
  app: CcApplication,
  target: NativeTarget,
  response: CcFailedRequest,
  recovery: ReportedRecovery,
  action: (owner: NativeTarget) => Invocation<"write">,
): Promise<CcWriteFailure> {
  const refusal = checkpointRefusal(response);
  const failure = ccWriteFailure(
    response.kind === "error" && refusal && !response.rationale
      ? { ...response, rationale: checkpointRationale(refusal.code) }
      : response,
    recovery,
    refusal && response.kind === "error" && response.status !== 400
      ? { errorCode: "CC_OPERATION_FAILED" }
      : {},
  );
  if (refusal && !failure.result.instruction)
    return {
      ...failure,
      result: {
        ok: false,
        error: failure.result.error,
        hint: checkpointAdvice(
          target,
          refusal.code,
          refusal.operationId,
          refusal.receipt,
        ),
      },
    };
  if (
    failure.result.instruction ||
    !isScopeMiss(response) ||
    app.globals.project !== undefined ||
    app.globals.session !== undefined ||
    target.target.conversationId === target.callerConversationId
  )
    return failure;
  const owner = await cliRequest(app.host, {
    ...requestParams(target),
    method: "GET",
    path: `/api/conversations/${encodePathSegment(target.target.conversationId)}`,
  });
  if (owner.kind !== "ok") return failure;
  const parsed = ownerSchema.safeParse(owner.body);
  if (!parsed.success) return failure;
  const scope = parsed.data;
  const discovered: NativeTarget = {
    ...target,
    target:
      scope.scope === "project"
        ? projectConversationTarget(
            scope.projectName,
            target.target.conversationId,
          )
        : sessionConversationTarget(
            scope.projectName,
            scope.sessionName,
            target.target.conversationId,
          ),
  };
  return {
    ...failure,
    result: {
      ok: false,
      error: failure.result.error,
      hint: hint(
        action(discovered),
        "This conversation lives elsewhere; target its owner explicitly",
      ),
    },
  };
}

/** A bare evidence reference can discover its owner. Mutations never enter this path. */
export async function readInScope<T extends { readonly kind: "ok" }>(
  app: CcApplication,
  positional: string | undefined,
  read: (target: NativeTarget) => Promise<T | CcFailedRequest>,
  failure: (
    response: CcFailedRequest,
  ) => Failure<never, CcErrorCode> = ccRequestFailure,
): Promise<
  | { readonly ok: true; readonly value: T; readonly target: NativeTarget }
  | Failure<never, CcErrorCode>
> {
  const resolved = await resolveTarget(app, positional);
  if (!resolved.ok) return resolved;
  let target = resolved.value;
  const first = await read(target);
  if (first.kind === "ok") return { ok: true, value: first, target };
  if (
    !isScopeMiss(first) ||
    app.globals.project !== undefined ||
    app.globals.session !== undefined ||
    target.target.conversationId === target.callerConversationId
  )
    return failure(first);
  const owner = await cliRequest(app.host, {
    ...requestParams(target),
    method: "GET",
    path: `/api/conversations/${encodePathSegment(target.target.conversationId)}`,
  });
  if (owner.kind !== "ok")
    return failure(
      owner.kind === "error" && owner.status === 404 ? first : owner,
    );
  const parsed = ownerSchema.safeParse(owner.body);
  if (!parsed.success) return invalidResponse("conversation owner");
  const scope = parsed.data;
  target = {
    ...target,
    target:
      scope.scope === "project"
        ? projectConversationTarget(
            scope.projectName,
            target.target.conversationId,
          )
        : sessionConversationTarget(
            scope.projectName,
            scope.sessionName,
            target.target.conversationId,
          ),
  };
  const second = await read(target);
  return second.kind === "ok"
    ? { ok: true, value: second, target }
    : failure(second);
}

/** Keep transcript evidence from being interpreted as the surrounding CLI protocol. */
export function quoteEvidence(value: string): string {
  return quoteLiteralText(value);
}
