"use client";

import { useMemo, useCallback } from "react";
import NotificationsPanel, {
  type NotificationItem,
  type ConversationNotification,
  type GraphWorkflowNotification,
  type MergeNotification,
  type CommitNotification,
  type ResolveConflictsNotification,
} from "./NotificationsPanel";
import { useActiveConversationsQuery } from "@/lib/active-conversations/queries";
import { useNotificationsQuery } from "@/lib/notifications/queries";
import {
  useMarkNotificationAsReadMutation,
  useMarkAllNotificationsAsReadMutation,
  useDismissNotificationMutation,
} from "@/lib/notifications/mutations";
import { useNotificationJobs } from "@/stores/notification.store";
import {
  useUnifiedPanelOpen,
  useCloseUnifiedPanel,
} from "@/stores/unified-panel.store";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import { activeConversationHref } from "@/lib/active-conversations/row-helpers";
import type { Notification } from "@/lib/notifications/schemas";
import { projectConversationFocusHref } from "@/lib/project-conversations-client/routes";

export function mapActiveConversationsToNotifications(
  activeConversations: ActiveConversation[],
): ConversationNotification[] {
  return activeConversations.map((conv): ConversationNotification => {
    const base = {
      type: "conversation" as const,
      id: conv.id,
      timestamp: conv.lastActivityAt,
      projectName: conv.projectName,
      name: conv.name,
      status: conv.status,
      backend: conv.agentBackend,
      read: !conv.unread,
    };

    if (conv.scope === "session") {
      return {
        ...base,
        scope: "session",
        sessionName: conv.sessionName,
      };
    }

    return {
      ...base,
      scope: "project",
      contextLabel: "main",
      href: activeConversationHref(conv),
    };
  });
}

export function mapPersistedNotificationsToNotifications(
  notifications: Notification[],
): NotificationItem[] {
  const result: NotificationItem[] = [];

  for (const notif of notifications) {
    if (notif.source === "project-conversation") {
      result.push({
        type: "conversation",
        scope: "project",
        id: notif.id,
        timestamp: notif.createdAt,
        projectName: notif.projectName,
        contextLabel: "main",
        href: projectConversationFocusHref(
          notif.projectName,
          notif.conversationId,
        ),
        name: notif.conversationName ?? notif.conversationId,
        status: notif.status,
        read: notif.read,
        persisted: true,
      } satisfies ConversationNotification);
      continue;
    }

    const base = {
      id: notif.id,
      timestamp: notif.createdAt,
      projectName: notif.projectName,
      sessionName: notif.sessionName,
      branchName: notif.branchName,
      read: notif.read,
    };

    if (notif.jobType === "merge") {
      const statusMap: Record<
        string,
        "success" | "conflicts" | "error" | "ready-to-land" | "discarded"
      > = {
        "merge-completed": "success",
        "merge-failed": "error",
        "merge-conflicts": "conflicts",
        "merge-ready-to-land": "ready-to-land",
        "merge-discarded": "discarded",
      };
      result.push({
        ...base,
        type: "merge",
        status: statusMap[notif.type] ?? "error",
        mergeHash: notif.mergeHash,
        conflictCount: notif.conflictCount,
        errorMessage: notif.errorMessage,
      } satisfies MergeNotification);
    } else if (notif.jobType === "commit") {
      result.push({
        ...base,
        type: "commit",
        status: notif.type === "commit-completed" ? "success" : "error",
        commitHash: notif.commitHash,
        errorMessage: notif.errorMessage,
      } satisfies CommitNotification);
    } else if (notif.jobType === "resolve-conflicts") {
      result.push({
        ...base,
        type: "resolve-conflicts",
        status: notif.type === "resolve-completed" ? "success" : "error",
        mergeHash: notif.mergeHash,
        errorMessage: notif.errorMessage,
      } satisfies ResolveConflictsNotification);
    }
  }

  return result;
}

export default function NotificationsPanelContainer() {
  const panelOpen = useUnifiedPanelOpen();
  const closePanel = useCloseUnifiedPanel();
  const { data: activeData, isPending: convLoading } =
    useActiveConversationsQuery();
  const activeConversations = activeData?.conversations;
  const { data: notificationsData, isPending: notifLoading } =
    useNotificationsQuery({ enabled: panelOpen });
  const jobs = useNotificationJobs();
  const markAsRead = useMarkNotificationAsReadMutation();
  const markAllAsRead = useMarkAllNotificationsAsReadMutation();
  const dismiss = useDismissNotificationMutation();

  const handleMarkAsRead = useCallback(
    (id: string) => {
      markAsRead.mutate(id);
    },
    [markAsRead],
  );
  const handleMarkAllAsRead = useCallback(() => {
    markAllAsRead.mutate();
  }, [markAllAsRead]);
  const handleDismiss = useCallback(
    (id: string) => {
      dismiss.mutate(id);
    },
    [dismiss],
  );

  const items: NotificationItem[] = useMemo(() => {
    const result: NotificationItem[] = [];

    // Map active graph workflow executions
    if (activeData?.graphWorkflowExecutions) {
      for (const gw of activeData.graphWorkflowExecutions) {
        result.push({
          type: "graph-workflow",
          id: `gw-${gw.executionId}`,
          timestamp: gw.startedAt,
          projectName: gw.projectName,
          sessionName: gw.sessionName,
          status: gw.status,
          activeContextTitles: gw.activeContextTitles,
          completedContexts: gw.completedContexts,
          totalContexts: gw.totalContexts,
        } satisfies GraphWorkflowNotification);
      }
    }

    // Map active conversations
    if (activeConversations) {
      result.push(
        ...mapActiveConversationsToNotifications(activeConversations),
      );
    }

    // Map currently running jobs from Zustand store
    for (const job of jobs.values()) {
      if (job.jobType === "merge") {
        const isReadyToLand = job.status === "ready-to-land";
        result.push({
          type: "merge",
          id: job.jobId,
          timestamp: job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: isReadyToLand ? "ready-to-land" : "running",
          read: true,
          phase: job.phase,
          preparedSha: job.preparedSha,
          parkedRef: job.parkedRef,
        } satisfies MergeNotification);
      } else if (job.jobType === "commit") {
        result.push({
          type: "commit",
          id: job.jobId,
          timestamp: job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: "running",
          read: true,
          phase: job.phase,
        } satisfies CommitNotification);
      } else if (job.jobType === "resolve-conflicts") {
        result.push({
          type: "resolve-conflicts",
          id: job.jobId,
          timestamp: job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: "running",
          read: true,
        } satisfies ResolveConflictsNotification);
      }
    }

    // Map server-persisted notifications
    if (notificationsData) {
      result.push(
        ...mapPersistedNotificationsToNotifications(
          notificationsData.notifications,
        ),
      );
    }

    // Sort by timestamp descending
    result.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return result;
  }, [activeConversations, activeData, jobs, notificationsData]);

  const unreadCount = notificationsData?.unreadCount ?? 0;

  return (
    <NotificationsPanel
      open={panelOpen}
      items={items}
      loading={convLoading || notifLoading}
      unreadCount={unreadCount}
      onClose={closePanel}
      onMarkAsRead={handleMarkAsRead}
      onMarkAllAsRead={handleMarkAllAsRead}
      onDismiss={handleDismiss}
    />
  );
}
