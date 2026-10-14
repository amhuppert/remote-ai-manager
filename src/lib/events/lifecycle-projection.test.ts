import { describe, it, expect } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
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

function devServerStatusEvent(
  status: "starting" | "running" | "stopped" | "error",
): SSEEvent {
  return {
    type: "dev-server-status",
    scope: "session",
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

  it("projects a project-root dev-server-status to a project/server scopeId", () => {
    expect(
      projectLifecycle({
        type: "dev-server-status",
        scope: "project",
        projectName: "p",
        serverName: "next",
        status: "running",
        port: 3000,
        remoteUrl: null,
        errorMessage: null,
        ownedByThisSession: true,
        worktreePath: "/repos/p",
        ownerPid: 12,
        logFilePath: null,
      }),
    ).toEqual({ scope: "dev-server", scopeId: "p/next", status: "running" });
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
