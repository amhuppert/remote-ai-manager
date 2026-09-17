import type { CliError } from "cli-for-agents";
import {
  projectConversationTarget,
  sessionConversationTargetSchema,
} from "@/lib/conversations/conversation-target";
import {
  readConversationScope,
  readSessionEnv,
  resolveCliPrincipalIdentity,
  resolveToken,
  type CliPrincipalIdentity,
  type ConversationContext,
  type ConversationTargetContext,
  type LaneContext,
  type ProjectContext,
  type ProjectConversationContext,
  type SessionContext,
} from "../transport";
import { ccErrors, type CcApplication } from "./family";

export type CcErrorCode = keyof typeof ccErrors.definitions;
export type CcContextResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CliError<CcErrorCode> };

/** Follow-ups retain the caller's explicit target without publishing credentials. */
export function explicitScopeFlags(app: Pick<CcApplication, "globals">) {
  const { server, project, session, conversation } = app.globals;
  return {
    ...(server === undefined ? {} : { server }),
    ...(project === undefined ? {} : { project }),
    ...(session === undefined ? {} : { session }),
    ...(conversation === undefined ? {} : { conversation }),
  };
}

export async function resolveCcServer(
  app: CcApplication,
): Promise<CcContextResult<Omit<ProjectContext, "project">>> {
  const server = app.globals.server ?? app.env["CC_SERVER_URL"];
  if (!server)
    return contextFailure("no server URL — pass --server or set CC_SERVER_URL");
  const token = await resolveToken(app.globals, app.env, app.host);
  return {
    ok: true,
    value: { server, token: token.token, tokenSource: token.source },
  };
}

export async function resolveCcProject(
  app: CcApplication,
): Promise<CcContextResult<ProjectContext>> {
  const server = app.globals.server ?? app.env["CC_SERVER_URL"];
  if (!server) {
    return {
      ok: false,
      error: ccErrors.error("CC_USAGE", {
        message: "no server URL — pass --server or set CC_SERVER_URL",
      }),
    };
  }
  const project = app.globals.project ?? app.env["CC_PROJECT"];
  if (!project) {
    return {
      ok: false,
      error: ccErrors.error("CC_USAGE", {
        message: "no project — pass --project or set CC_PROJECT",
      }),
    };
  }
  const token = await resolveToken(app.globals, app.env, app.host);
  return {
    ok: true,
    value: { server, project, token: token.token, tokenSource: token.source },
  };
}

function contextFailure(message: string): CcContextResult<never> {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) };
}

export async function resolveCcSession(
  app: CcApplication,
): Promise<CcContextResult<SessionContext>> {
  const base = await resolveCcProject(app);
  if (!base.ok) return base;
  const session = app.globals.session ?? readSessionEnv(app.env);
  if (!session)
    return contextFailure("no session — pass --session or set CC_SESSION");
  return { ok: true, value: { ...base.value, session } };
}

export async function resolveCcConversation(
  app: CcApplication,
): Promise<CcContextResult<ConversationContext>> {
  const base = await resolveCcSession(app);
  if (!base.ok) return base;
  const conversation =
    app.globals.conversation ?? app.env["CC_CONVERSATION_ID"];
  if (!conversation)
    return contextFailure(
      "no conversation — pass --conversation or set CC_CONVERSATION_ID",
    );
  return { ok: true, value: { ...base.value, conversation } };
}

export async function resolveCcProjectConversation(
  app: CcApplication,
): Promise<CcContextResult<ProjectConversationContext>> {
  const base = await resolveCcProject(app);
  if (!base.ok) return base;
  const conversation =
    app.globals.conversation ?? app.env["CC_CONVERSATION_ID"];
  if (!conversation)
    return contextFailure(
      "no conversation — pass --conversation or set CC_CONVERSATION_ID",
    );
  return { ok: true, value: { ...base.value, conversation } };
}

export async function resolveCcConversationTarget(
  app: CcApplication,
): Promise<CcContextResult<ConversationTargetContext>> {
  const base = await resolveCcProjectConversation(app);
  if (!base.ok) return base;
  const { conversation, ...project } = base.value;
  const scope = readConversationScope(app.env);
  if (app.globals.session === undefined && scope === "project") {
    return {
      ok: true,
      value: {
        ...project,
        target: projectConversationTarget(project.project, conversation),
      },
    };
  }
  const session = app.globals.session ?? readSessionEnv(app.env);
  if (!session) {
    return contextFailure(
      scope === null && app.globals.session === undefined
        ? "no conversation scope — pass --session, or set CC_SESSION or CC_CONVERSATION_SCOPE"
        : "no session — pass --session or set CC_SESSION",
    );
  }
  const target = sessionConversationTargetSchema.safeParse({
    scope: "session",
    projectName: project.project,
    sessionName: session,
    conversationId: conversation,
  });
  if (!target.success)
    return contextFailure(
      target.error.issues.map((issue) => issue.message).join("; "),
    );
  return { ok: true, value: { ...project, target: target.data } };
}

export async function resolveCcLane(
  app: CcApplication,
): Promise<CcContextResult<LaneContext>> {
  const base = await resolveCcSession(app);
  if (!base.ok) return base;
  const executionId = app.env["CC_WORKFLOW_EXECUTION_ID"];
  if (!executionId)
    return contextFailure(
      "no workflow execution — set CC_WORKFLOW_EXECUTION_ID (lane conversations only)",
    );
  const contextId = app.env["CC_WORKFLOW_CONTEXT_ID"];
  if (!contextId)
    return contextFailure(
      "no workflow context — set CC_WORKFLOW_CONTEXT_ID (lane conversations only)",
    );
  return { ok: true, value: { ...base.value, executionId, contextId } };
}

export function resolveCcPrincipal(app: CcApplication): CliPrincipalIdentity {
  return resolveCliPrincipalIdentity(app.env);
}
