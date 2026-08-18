import {
  conversationTargetApiBase,
  projectConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  EXIT_OK,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failureFromRequestNotFoundAsUsage,
  readConversationScope,
  readSessionEnv,
  render,
  resolveProjectContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl notify "<message>" [--title <t>]` — send a push to the user via the
 * addressed conversation's notifications endpoint (docs/design/cc-cli/02 §2.1),
 * at session or project scope per the resolved target. A notification
 * is terminal: on success there is deliberately NO hint. When push is
 * unconfigured the endpoint returns 409 and the CLI exits 1 with the server's
 * one-line reason (agents treat that as non-fatal).
 */
export async function runNotify(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "notify", json);
  if (denied) return denied;

  const message = rest[0];
  if (message === undefined) {
    return usageFailure("notify requires a message argument", json);
  }
  if (rest.length > 1) {
    return usageFailure(
      "notify takes a single message argument — quote multi-word messages",
      json,
    );
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, token, tokenSource } = resolved.context;

  // Scope asymmetry is deliberate: a SESSION notification is addressed at the
  // session, which owns the notification surface for every conversation in it. A
  // project conversation has no session, so the conversation itself is the
  // addressable owner. The env session read is a falsy check — the neutralized
  // "" of a project conversation must not build `/sessions//notifications`.
  const session = flags.session ?? readSessionEnv(env);
  let notificationsPath: string;
  if (session !== null) {
    notificationsPath = `/api/projects/${encodePathSegment(project)}/sessions/${encodePathSegment(session)}/notifications`;
  } else if (readConversationScope(env) === "project") {
    const conversation = flags.conversation ?? env["CC_CONVERSATION_ID"];
    if (!conversation) {
      return usageFailure(
        "no conversation — pass --conversation or set CC_CONVERSATION_ID",
        json,
      );
    }
    notificationsPath = `${conversationTargetApiBase(
      projectConversationTarget(project, conversation),
    )}/notifications`;
  } else {
    return usageFailure("no session — pass --session or set CC_SESSION", json);
  }

  const title = values["title"];
  const body: { message: string; title?: string } = { message };
  if (title !== undefined) body.title = title;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "POST",
    path: notificationsPath,
    body,
  });

  // An unknown project/session/conversation is a caller mistake (exit 2), not a
  // server outage.
  if (result.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(result, json);
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, "notification sent\n", { ok: true }),
    stderr: "",
  };
}
