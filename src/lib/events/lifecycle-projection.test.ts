import { describe, it, expect } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { GraphWorkflowStatusEvent } from "@/lib/workflow-graph/event-schemas";
import {
  LIFECYCLE_EVENT_TYPES,
  projectLifecycle,
} from "./lifecycle-projection";

function conversationStatusEvent(
  status: "running" | "awaiting" | "waiting_for_input",
): SSEEvent {
  return {
    type: "conversation-status",
    scope: "session",
    projectName: "p",
    sessionName: "s",
    conversationId: "conv-1",
    status,
  };
}

function jobStatusEvent(
  status:
    | "running"
    | "completed"
    | "failed"
    | "conflicts"
    | "ready-to-land"
    | "discarded",
): SSEEvent {
  return {
    type: "job-status",
    jobType: "merge",
    status,
    projectName: "p",
    sessionName: "s",
    jobId: "job-1",
    branchName: "csm/x",
  };
}

function graphWorkflowStatusEvent(
  workflowStatus: GraphWorkflowStatusEvent["workflowStatus"],
): SSEEvent {
  return {
    type: "graph-workflow-status",
    projectName: "p",
    sessionName: "s",
    executionId: "exec-1",
    workflowStatus,
    activeContextIds: [],
    activeBatchIds: [],
    activeJoinIds: [],
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
  };
}

function taskStatusEvent(
  status: "pending" | "running" | "interrupted" | "completed" | "failed",
): SSEEvent {
  return {
    type: "graph-workflow-task-status",
    projectName: "p",
    sessionName: "s",
    executionId: "exec-1",
    taskId: "task-1",
    contextId: "ctx-1",
    status,
    source: "user",
    order: 1,
  };
}

function devServerStatusEvent(
  status: "starting" | "running" | "stopped" | "error",
): SSEEvent {
  return {
    type: "dev-server-status",
    projectName: "p",
    sessionName: "s",
    serverName: "next",
    status,
    port: null,
    remoteUrl: null,
    errorMessage: null,
    ownedByThisSession: false,
    worktreePath: null,
    ownerPid: null,
    logFilePath: null,
  };
}

describe("LIFECYCLE_EVENT_TYPES enumeration", () => {
  it("pins the exact supported lifecycle set — adding a lifecycle event is a deliberate change to this list", () => {
    expect([...LIFECYCLE_EVENT_TYPES].sort()).toEqual(
      [
        "conversation-status",
        "ask-question",
        "job-status",
        "graph-workflow-status",
        "graph-workflow-context-status",
        "graph-workflow-task-status",
        "dev-server-status",
        "debug-mode-status",
        "debug-log-received",
        "scoped-status",
      ].sort(),
    );
  });
});

describe("projectLifecycle — supported lifecycle events", () => {
  it("projects conversation-status to the conversation scope with the mapped lifecycle status", () => {
    expect(projectLifecycle(conversationStatusEvent("running"))).toEqual({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
    });
    expect(projectLifecycle(conversationStatusEvent("awaiting"))?.status).toBe(
      "paused",
    );
    expect(
      projectLifecycle(conversationStatusEvent("waiting_for_input"))?.status,
    ).toBe("paused");
  });

  it("projects ask-question to a paused conversation", () => {
    expect(
      projectLifecycle({
        type: "ask-question",
        scope: "session",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-q",
        questionId: "q-1",
        questions: [
          {
            question: "ok?",
            multiSelect: false,
            options: [],
            required: true,
            allowNote: true,
          },
        ],
      }),
    ).toEqual({ scope: "conversation", scopeId: "conv-q", status: "paused" });
  });

  it("projects job-status to the merge_job scope across every status branch", () => {
    expect(projectLifecycle(jobStatusEvent("completed"))).toEqual({
      scope: "merge_job",
      scopeId: "job-1",
      status: "completed",
    });
    expect(projectLifecycle(jobStatusEvent("failed"))?.status).toBe("failed");
    expect(projectLifecycle(jobStatusEvent("conflicts"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(jobStatusEvent("running"))?.status).toBe("running");
    expect(projectLifecycle(jobStatusEvent("ready-to-land"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(jobStatusEvent("discarded"))?.status).toBe(
      "completed",
    );
  });

  it("projects graph-workflow-status to the graph_workflow scope across every status branch", () => {
    expect(projectLifecycle(graphWorkflowStatusEvent("completed"))).toEqual({
      scope: "graph_workflow",
      scopeId: "exec-1",
      status: "completed",
    });
    expect(projectLifecycle(graphWorkflowStatusEvent("halted"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(graphWorkflowStatusEvent("paused"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(graphWorkflowStatusEvent("pending"))?.status).toBe(
      "running",
    );
    expect(projectLifecycle(graphWorkflowStatusEvent("running"))?.status).toBe(
      "running",
    );
    expect(projectLifecycle(graphWorkflowStatusEvent("aborted"))?.status).toBe(
      "failed",
    );
  });

  it("projects graph-workflow-context-status to its own context scope without overwriting execution status", () => {
    const contextEvent = (
      status:
        | "pending"
        | "ready"
        | "running"
        | "completed"
        | "halted"
        | "awaiting_approval"
        | "awaiting_user_input",
    ): SSEEvent => ({
      type: "graph-workflow-context-status",
      projectName: "p",
      sessionName: "s",
      executionId: "exec-ctx",
      contextId: "ctx-1",
      status,
      remainingTaskCount: 2,
      iterationCount: 1,
    });

    expect(projectLifecycle(contextEvent("completed"))).toEqual({
      scope: "graph_workflow_context",
      scopeId: "exec-ctx/ctx-1",
      status: "completed",
    });
    expect(projectLifecycle(contextEvent("halted"))?.status).toBe("paused");
    expect(projectLifecycle(contextEvent("awaiting_approval"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(contextEvent("awaiting_user_input"))?.status).toBe(
      "paused",
    );
    expect(projectLifecycle(contextEvent("pending"))?.status).toBe("running");
    expect(projectLifecycle(contextEvent("ready"))?.status).toBe("running");
    expect(projectLifecycle(contextEvent("running"))?.status).toBe("running");
  });

  it("projects graph-workflow-task-status across every task status branch", () => {
    expect(projectLifecycle(taskStatusEvent("completed"))).toEqual({
      scope: "graph_workflow_task",
      scopeId: "exec-1/task-1",
      status: "completed",
    });
    expect(projectLifecycle(taskStatusEvent("failed"))?.status).toBe("failed");
    expect(projectLifecycle(taskStatusEvent("pending"))?.status).toBe(
      "running",
    );
    expect(projectLifecycle(taskStatusEvent("running"))?.status).toBe(
      "running",
    );
    expect(projectLifecycle(taskStatusEvent("interrupted"))?.status).toBe(
      "paused",
    );
  });

  it("projects dev-server-status with a project/session/server composite scopeId across every status branch", () => {
    expect(projectLifecycle(devServerStatusEvent("running"))).toEqual({
      scope: "dev-server",
      scopeId: "p/s/next",
      status: "running",
    });
    expect(projectLifecycle(devServerStatusEvent("starting"))?.status).toBe(
      "running",
    );
    expect(projectLifecycle(devServerStatusEvent("stopped"))?.status).toBe(
      "completed",
    );
    expect(projectLifecycle(devServerStatusEvent("error"))?.status).toBe(
      "failed",
    );
  });

  it("projects both debug events to a running debug scope keyed by conversationId", () => {
    expect(
      projectLifecycle({
        type: "debug-mode-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-d",
        active: true,
        recording: true,
      }),
    ).toEqual({ scope: "debug", scopeId: "conv-d", status: "running" });
    expect(
      projectLifecycle({
        type: "debug-log-received",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-d",
        entryCount: 3,
      }),
    ).toEqual({ scope: "debug", scopeId: "conv-d", status: "running" });
  });

  it("passes scoped-status scope/scopeId/status through for recognized scopes", () => {
    expect(
      projectLifecycle({
        type: "scoped-status",
        scope: "collaboration",
        scopeId: "wf-collab-1",
        status: "paused",
        timestamp: "2026-04-28T00:00:00.000Z",
        projectName: "p",
        sessionName: "s",
      }),
    ).toEqual({
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "paused",
    });
  });

  it("narrows an unrecognized scoped-status scope to the generic workflow scope", () => {
    expect(
      projectLifecycle({
        type: "scoped-status",
        scope: "totally-unknown",
        scopeId: "wf-x",
        status: "running",
        timestamp: "2026-04-28T00:00:00.000Z",
        projectName: "p",
        sessionName: "s",
      }),
    ).toEqual({ scope: "workflow", scopeId: "wf-x", status: "running" });
  });
});

describe("projectLifecycle — wire-only events return null (no manufactured fallback)", () => {
  it("returns null for conversation-unread instead of manufacturing conversation/unknown/running", () => {
    expect(
      projectLifecycle({
        type: "conversation-unread",
        scope: "session",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-unread-1",
        unread: true,
      }),
    ).toBeNull();
  });

  it("returns null for graph-workflow-lane-status instead of manufacturing conversation/unknown/running", () => {
    expect(
      projectLifecycle({
        type: "graph-workflow-lane-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-lane-1",
        laneId: "lane-1",
        kind: "worktree",
        status: "active",
        branchName: "csm/lane-1",
        worktreePath: null,
        includedContextIds: [],
        lastCommittingContextId: null,
      }),
    ).toBeNull();
  });

  it("returns null for wire-only mutations and point events", () => {
    const wireOnly: SSEEvent[] = [
      {
        type: "message-queue-updated",
        scope: "session",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        message: {
          id: "queued-1",
          content: [{ type: "text", text: "hi" }],
          status: "pending",
          enqueuedAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
          deliveredAt: null,
          cancelledAt: null,
          failedAt: null,
          error: null,
          metadata: null,
        },
      },
      {
        type: "notification-updated",
        id: "notif-1",
        read: true,
      },
      {
        type: "graph-workflow-shared-documents-updated",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        documents: [],
      },
      {
        type: "ticket-changed",
        change: "updated",
        projectName: "p",
        ticketNumber: 1,
        listItem: null,
        attachmentIndexChanged: false,
      },
    ];
    for (const event of wireOnly) {
      expect(projectLifecycle(event)).toBeNull();
    }
  });
});
