"use client";

import { useMemo } from "react";
import NotificationsPanel, {
  type NotificationItem,
  type ConversationNotification,
  type MergeNotification,
  type CommitNotification,
  type WorkflowNotification,
} from "./NotificationsPanel";
import { useActiveConversationsQuery } from "@/lib/queries";
import { useNotificationJobs } from "@/stores/notification.store";
import { useActiveWorkflows } from "@/stores/workflow.store";
import {
  useUnifiedPanelOpen,
  useCloseUnifiedPanel,
} from "@/stores/unified-panel.store";

export default function NotificationsPanelContainer() {
  const panelOpen = useUnifiedPanelOpen();
  const closePanel = useCloseUnifiedPanel();
  const { data: activeConversations, isPending } =
    useActiveConversationsQuery();
  const jobs = useNotificationJobs();
  const activeWorkflows = useActiveWorkflows();

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

    // Map background jobs
    for (const job of jobs.values()) {
      if (job.jobType === "merge") {
        const statusMap: Record<
          string,
          "running" | "success" | "conflicts" | "error"
        > = {
          running: "running",
          completed: "success",
          failed: "error",
          conflicts: "conflicts",
        };
        result.push({
          type: "merge",
          id: job.jobId,
          timestamp: job.completedAt ?? job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: statusMap[job.status] ?? "running",
          mergeHash: job.mergeHash,
          conflictCount: job.conflictCount,
          errorMessage: job.errorMessage,
        } satisfies MergeNotification);
      } else if (job.jobType === "commit") {
        const statusMap: Record<string, "running" | "success" | "error"> = {
          running: "running",
          completed: "success",
          failed: "error",
        };
        result.push({
          type: "commit",
          id: job.jobId,
          timestamp: job.completedAt ?? job.startedAt,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          status: statusMap[job.status] ?? "running",
          commitHash: job.commitHash,
          errorMessage: job.errorMessage,
        } satisfies CommitNotification);
      }
    }

    // Sort by timestamp descending
    result.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return result;
  }, [activeConversations, jobs, activeWorkflows]);

  return (
    <NotificationsPanel
      open={panelOpen}
      items={items}
      loading={isPending}
      onClose={closePanel}
    />
  );
}
