import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
  AgentCapabilityConversationScope,
} from "./schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

export interface AgentCapabilityEventIdentifiers {
  level: AgentCapabilityCascadeLayer;
  projectName?: string;
  conversationScope?: AgentCapabilityConversationScope;
  sessionName?: string;
  conversationId?: string;
  cascadeKind: AgentCapabilityCascadeKind;
}

export interface AgentCapabilityQueryKeyMatcher {
  queryKey: readonly unknown[];
}

export function computeAgentCapabilityInvalidations(
  event: AgentCapabilityEventIdentifiers,
): readonly AgentCapabilityQueryKeyMatcher[] {
  const root = ["agent-capabilities"] as const;

  if (event.level === "global") {
    return [{ queryKey: root }];
  }

  if (event.level === "project") {
    if (!event.projectName) return [];
    return [
      {
        queryKey: [...root, "project", event.projectName, event.cascadeKind],
      },
      {
        queryKey: [...root, "session", event.projectName, event.cascadeKind],
      },
      {
        queryKey: [
          ...root,
          "conversation",
          event.projectName,
          event.cascadeKind,
        ],
      },
    ];
  }

  if (event.level === "session") {
    if (
      !event.projectName ||
      !event.sessionName ||
      event.sessionName === PROJECT_CONVERSATION_SESSION_SENTINEL
    ) {
      return [];
    }
    return [
      {
        queryKey: [
          ...root,
          "session",
          event.projectName,
          event.cascadeKind,
          event.sessionName,
        ],
      },
      {
        queryKey: [
          ...root,
          "conversation",
          event.projectName,
          event.cascadeKind,
          event.sessionName,
        ],
      },
    ];
  }

  if (!event.projectName || !event.conversationId) {
    return [];
  }

  if (event.conversationScope === "project") {
    if (event.sessionName) return [];
    return [
      {
        queryKey: [
          ...root,
          "conversation",
          event.projectName,
          event.cascadeKind,
          "project",
          event.conversationId,
        ],
      },
    ];
  }

  if (
    !event.sessionName ||
    event.sessionName === PROJECT_CONVERSATION_SESSION_SENTINEL
  ) {
    return [];
  }

  return [
    {
      queryKey: [
        ...root,
        "conversation",
        event.projectName,
        event.cascadeKind,
        event.sessionName,
        event.conversationId,
      ],
    },
  ];
}
