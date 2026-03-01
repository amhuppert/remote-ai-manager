"use client";

import { useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import NotificationsPanel, {
  type NotificationItem,
  type ConversationNotification,
  type MergeNotification,
  type CommitNotification,
  type ResolveConflictsNotification,
  type WorkflowNotification,
} from "./NotificationsPanel";
import {
  useActiveConversationsQuery,
  useNotificationsQuery,
} from "@/lib/queries";
import { useNotificationJobs } from "@/stores/notification.store";
import { useActiveWorkflows } from "@/stores/workflow.store";
import {
  useUnifiedPanelOpen,
  useCloseUnifiedPanel,
} from "@/stores/unified-panel.store";
import { notificationKeys } from "@/lib/query-keys";

export default function NotificationsPanelContainer() {
  const panelOpen = useUnifiedPanelOpen();
  const closePanel = useCloseUnifiedPanel();
  const queryClient = useQueryClient();
  const { data: activeConversations, isPending: convLoading } =
    useActiveConversationsQuery();
  const { data: notificationsData, isPending: notifLoading } =
    useNotificationsQuery({ enabled: panelOpen });
  const jobs = useNotificationJobs();
  const activeWorkflows = useActiveWorkflows();

  const handleMarkAsRead = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/notifications/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        });
        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
      } catch {
        // best-effort
      }
    },
    [queryClient],
  );

  const handleMarkAllAsRead = useCallback(async () => {
    try {
      await fetch("/api/notifications/mark-all-read", { method: "POST" });
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    } catch {
      // best-effort
    }
  }, [queryClient]);

  const handleDismiss = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/notifications/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
      } catch {
        // best-effort
      }
    },
    [queryClient],
  );

  const items: NotificationItem[] = useMemo(() => {
    const result: NotificationItem[] = [];

    // Map active workflows
    for (const wf of activeWorkflows) {
      result.push({
        type: "workflow",
        id: `wf-${wf.projectName}-${wf.sessionName}`,
        timestamp: wf.updatedAt,
        projectName: wf.projectName,
        sessionName: wf.sessionName,
        status: wf.status as WorkflowNotification["status"],
        iterationCount: wf.iterationCount,
        maxIterations: wf.maxIterations,
      } satisfies WorkflowNotification);
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
          status: conv.status as "running" | "awaiting" | "waiting_for_input",
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
  }, [activeConversations, jobs, notificationsData, activeWorkflows]);

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
