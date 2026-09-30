import type { SubscriptionView } from "@/lib/subscriptions/controls-schemas";
export function subscriptionFixture(
  overrides: Partial<SubscriptionView> = {},
): SubscriptionView {
  return {
    subscription: {
      id: "subscription-1",
      recipient: {
        projectPath: "/repos/command-center",
        conversationId: "conversation-1",
      },
      source: { kind: "notepad", id: "notepad-1" },
      reason:
        "Keep the implementation aligned with the latest product decisions.",
      mode: "passive",
      eventKinds: null,
      expiresAt: null,
      status: "following",
      cursor: "4",
      createdAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-09-30T12:00:00.000Z",
      unfollowedAt: null,
      pausedAt: null,
      missingAt: null,
      lastError: null,
    },
    owner: {
      target: {
        scope: "session",
        projectName: "command-center",
        sessionName: "Notifications",
        conversationId: "conversation-1",
      },
      projectPath: "/repos/command-center",
      conversationTitle: "Implement agent notifications",
      archived: false,
    },
    sourceTitle: "Command Center Vision",
    sourceHref: null,
    wait: null,
    batch: null,
    pendingCount: 2,
    unreadCount: 2,
    holdReason: null,
    rateLimitUntil: null,
    actions: ["pause", "unfollow"],
    ...overrides,
  };
}
