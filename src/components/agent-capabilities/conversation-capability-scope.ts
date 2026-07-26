/**
 * Which capability-cascade layer a conversation's overrides are read from and
 * written to, derived from the conversation's EXPLICIT scope.
 *
 * A project conversation cascades global → project → conversation: it has no
 * session layer, and its conversation layer is addressed by
 * `conversationScope: "project"` with no session name at all. Deriving that
 * from whether a session name is absent (or looks like the internal sentinel)
 * is what produced session-shaped capability requests for project
 * conversations, so both composer surfaces — the slash-command filter and the
 * configuration drawer — resolve the scope through this one function (R7.2).
 */

import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

export interface ConversationCapabilityScopeArgs {
  scope: ConversationScopeRef;
  projectName: string;
  /**
   * Absent before the conversation exists — the composer mounts ahead of the
   * first turn, and there is no conversation layer to cascade through yet. The
   * project composer spells that absence as an empty id, which addresses
   * `/conversations//agent-capabilities` unless it is treated as absent here.
   */
  conversationId: string | undefined;
}

export function conversationCapabilityScope({
  scope,
  projectName,
  conversationId,
}: ConversationCapabilityScopeArgs): AgentCapabilityScope {
  if (!conversationId) {
    return scope.scope === "project"
      ? { level: "project", projectName }
      : { level: "session", projectName, sessionName: scope.sessionName };
  }
  return scope.scope === "project"
    ? {
        level: "conversation",
        projectName,
        conversationScope: "project",
        conversationId,
      }
    : {
        level: "conversation",
        projectName,
        sessionName: scope.sessionName,
        conversationId,
      };
}

/**
 * The cascade layers a conversation of this scope can be configured at. The
 * conversation layer is offered only once the conversation exists — a layer
 * whose scope silently resolved to its parent would let the user believe an
 * override was recorded on the conversation.
 */
export function conversationCapabilityLayers(
  args: ConversationCapabilityScopeArgs,
): readonly AgentCapabilityLayerOption[] {
  const { scope, projectName, conversationId } = args;
  return [
    { label: "Global", scope: { level: "global" } },
    { label: "Project", scope: { level: "project", projectName } },
    ...(scope.scope === "session"
      ? [
          {
            label: "Session",
            scope: {
              level: "session",
              projectName,
              sessionName: scope.sessionName,
            },
          } as const,
        ]
      : []),
    ...(conversationId
      ? [
          {
            label: "Conversation",
            scope: conversationCapabilityScope(args),
          },
        ]
      : []),
  ];
}
