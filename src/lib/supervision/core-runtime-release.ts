import type { ConversationCore } from "@/lib/conversation-core/executor";
import type { RuntimeHost } from "@/lib/conversation-core/runtime-host";

/**
 * What a collaboration's release of its originating conversation's idle
 * runtime finds on the core (design C5b §5): the core host is where a core
 * conversation's runtime lives between turns. A collaboration's claim is
 * refused while custody holds it, so a live runtime here is one nothing owns;
 * custody or a running turn is still answered `busy`, touching nothing.
 */
export async function releaseIdleCoreRuntime(
  deps: {
    core: Pick<ConversationCore, "isBusy" | "holdsCustody">;
    host: Pick<RuntimeHost, "isLive" | "release">;
  },
  conversationId: string,
): Promise<"released" | "not_hosted" | "busy"> {
  if (
    deps.core.holdsCustody(conversationId) ||
    deps.core.isBusy(conversationId)
  )
    return "busy";
  if (!deps.host.isLive(conversationId)) return "not_hosted";
  await deps.host.release(conversationId);
  return "released";
}
