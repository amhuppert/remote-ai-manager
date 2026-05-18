import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
} from "@/lib/schemas";

export interface AgentCapabilityEventIdentifiers {
  level: AgentCapabilityCascadeLayer;
  projectName?: string;
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
    if (!event.projectName || !event.sessionName) return [];
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

  if (!event.projectName || !event.sessionName || !event.conversationId) {
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
