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
      for (const conv of activeConversations) {
        result.push({
          type: "conversation",
          id: conv.id,
          timestamp: conv.lastActivityAt,
          projectName: conv.projectName,
          sessionName: conv.sessionName,
          name: conv.name,
          status: conv.status as
            | "new"
            | "running"
            | "awaiting"
            | "waiting_for_input",
        } satisfies ConversationNotification);
      }
    }

    // Map currently running jobs from Zustand store
    for (const job of jobs.values()) {
      if (job.jobType === "merge") {
        result.push({
          type: "merge",
          id: job.jobId,
          timestamp: job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: "running",
          read: true,
          phase: job.phase,
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
      for (const notif of notificationsData.notifications) {
        const base = {
          id: notif.id,
          timestamp: notif.createdAt,
          projectName: notif.projectName,
          sessionName: notif.sessionName,
          branchName: notif.branchName,
          read: notif.read,
        };

        if (notif.jobType === "merge") {
          const statusMap: Record<string, "success" | "conflicts" | "error"> = {
            "merge-completed": "success",
            "merge-failed": "error",
            "merge-conflicts": "conflicts",
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
