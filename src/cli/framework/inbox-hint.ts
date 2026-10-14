import { invocation } from "cli-for-agents";
import { hint, type Hint } from "cli-for-agents/guidance";
import { CONVERSATION_IDENTITY_ENV_VAR } from "@/lib/agent-gateway/conversation-identity";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import { inboxSummarySchema } from "@/lib/subscriptions/controls-schemas";
import { inboxListCommand } from "../commands/subscription/definitions";
import {
  cliRequest,
  readConversationScope,
  readSessionEnv,
} from "../transport";
import { resolveCcConversationTarget } from "./context";
import type { CcApplication } from "./family";

function hasMatchingAmbientIdentity(app: CcApplication) {
  const { env, globals } = app;
  const scope = readConversationScope(env);
  const conversation = env["CC_CONVERSATION_ID"];
  if (
    !scope ||
    !conversation ||
    !env["CC_PROJECT"] ||
    !env["CC_SERVER_URL"] ||
    !env["CC_API_TOKEN"] ||
    (env[CONVERSATION_IDENTITY_ENV_VAR] &&
      env[CONVERSATION_IDENTITY_ENV_VAR] !== conversation)
  )
    return false;
  const session = readSessionEnv(env);
  if (scope === "session" && !session) return false;
  return (
    (globals.server === undefined || globals.server === env["CC_SERVER_URL"]) &&
    (globals.token === undefined || globals.token === env["CC_API_TOKEN"]) &&
    (globals.project === undefined || globals.project === env["CC_PROJECT"]) &&
    (globals.conversation === undefined ||
      globals.conversation === conversation) &&
    (globals.session === undefined ||
      (scope === "session" && globals.session === session))
  );
}

/** A summary reads recorded counts only; it must never reconcile or accept input. */
export async function loadInboxHint(
  app: CcApplication,
): Promise<Hint | undefined> {
  if (!hasMatchingAmbientIdentity(app)) return undefined;
  try {
    const resolved = await resolveCcConversationTarget(app);
    if (!resolved.ok) return undefined;
    const { target, ...connection } = resolved.value;
    let parsed = inboxSummarySchema.safeParse(app.inboxHintState);
    if (!parsed.success) {
      const response = await cliRequest(app.host, {
        ...connection,
        method: "GET",
        path: `${conversationTargetApiBase(target)}/inbox/summary`,
        headers: { "x-cc-conversation-id": target.conversationId },
        timeoutMs: 300,
      });
      if (response.kind !== "ok") return undefined;
      parsed = inboxSummarySchema.safeParse(response.body);
    }
    if (
      !parsed.success ||
      !parsed.data.hintsEnabled ||
      parsed.data.pendingCount === 0
    )
      return undefined;
    return hint(
      invocation(inboxListCommand, {
        flags: {
          project: target.projectName,
          conversation: target.conversationId,
          ...(target.scope === "session"
            ? { session: target.sessionName }
            : {}),
          ...(app.globals.server === undefined
            ? {}
            : { server: app.globals.server }),
        },
      }),
      `Inspect ${parsed.data.pendingCount} pending update${parsed.data.pendingCount === 1 ? "" : "s"}`,
    );
  } catch {
    return undefined;
  }
}
