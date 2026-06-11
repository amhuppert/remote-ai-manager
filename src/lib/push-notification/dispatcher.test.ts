import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pushForNotification,
  pushForConversationStatus,
  pushForGraphWorkflowEvent,
  pushForCollaborationEvent,
} from "./dispatcher";
import type {
  JobNotification,
  ProjectConversationNotification,
  PushNotificationConfig,
} from "@/lib/notifications/schemas";
import * as pushMod from "../notifications/push";

vi.mock("../notifications/push", () => ({
  sendPushNotification: vi.fn(),
}));

const sendPushNotification = vi.mocked(pushMod.sendPushNotification);

const pushConfig: PushNotificationConfig = {
  enabled: true,
  provider: "ntfy",
  serverUrl: "https://ntfy.sh",
  topic: "test-topic",
  triggers: {
    jobCompleted: true,
    waitingForInput: true,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: true,
  },
};

function makeNotification(
  overrides: Partial<JobNotification> = {},
): JobNotification {
  return {
    id: "test-id",
    source: "job",
    type: "merge-completed",
    title: "Merge completed",
    message: "Branch csm/feature merged",
    read: false,
    projectName: "my-project",
    sessionName: "my-session",
    branchName: "csm/feature",
    jobId: "job-1",
    jobType: "merge",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProjectConversationNotification(
  overrides: Partial<ProjectConversationNotification> = {},
): ProjectConversationNotification {
  return {
    id: "project-notification-1",
    source: "project-conversation",
    type: "project-conversation-ready",
    title: "Project conversation ready",
    message: "Project chat in my-project is ready.",
    read: false,
    projectName: "my-project",
    conversationId: "conversation-1",
    conversationName: "Project chat",
    status: "awaiting",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("pushForNotification", () => {
  beforeEach(() => {
    sendPushNotification.mockReset();
  });

  it("sends push for a completed notification", async () => {
    const notif = makeNotification();
    await pushForNotification(pushConfig, notif);

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "job-completed",
      title: "Merge completed",
      message: "Branch csm/feature merged",
      projectName: "my-project",
      sessionName: "my-session",
    });
  });

  it("sends push for a failed notification", async () => {
    const notif = makeNotification({
      type: "merge-failed",
      title: "Merge failed",
      message: "Error merging",
    });
    await pushForNotification(pushConfig, notif);

    expect(sendPushNotification).toHaveBeenCalledOnce();
  });

  it("does nothing when config is undefined", async () => {
    await pushForNotification(undefined, makeNotification());
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("does nothing for project-conversation notifications when config is undefined", async () => {
    await pushForNotification(undefined, makeProjectConversationNotification());
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("sends conversation-idle push for a project-conversation readiness notification without a session name", async () => {
    await pushForNotification(
      pushConfig,
      makeProjectConversationNotification({
        type: "project-conversation-ready",
        title: "Project conversation ready",
        message: "Project chat in my-project is ready.",
        status: "awaiting",
      }),
    );

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "conversation-idle",
      title: "Project conversation ready",
      message: "Project chat in my-project is ready.",
      projectName: "my-project",
      contextName: "Project chat",
    });
  });

  it("sends waiting-for-input push for a project-conversation input-needed notification without a session name", async () => {
    await pushForNotification(
      pushConfig,
      makeProjectConversationNotification({
        type: "project-conversation-input-needed",
        title: "Project conversation needs input",
        message: "Conversation conversation-2 in my-project needs input.",
        conversationId: "conversation-2",
        conversationName: null,
        status: "waiting_for_input",
      }),
    );

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "waiting-for-input",
      title: "Project conversation needs input",
      message: "Conversation conversation-2 in my-project needs input.",
      projectName: "my-project",
      contextName: "Conversation conversation-2",
    });
  });

  it("sends workflow-halted push for a project-conversation failure notification without a session name", async () => {
    await pushForNotification(
      pushConfig,
      makeProjectConversationNotification({
        type: "project-conversation-failed",
        title: "Project conversation failed",
        message: "Project chat in my-project failed: Tool call timed out",
        status: "failed",
        errorMessage: "Tool call timed out",
      }),
    );

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-halted",
      title: "Project conversation failed",
      message: "Project chat in my-project failed: Tool call timed out",
      projectName: "my-project",
      contextName: "Project chat",
    });
  });

  it("uses the existing conversation-idle trigger gate for project-conversation readiness notifications", async () => {
    await pushForNotification(
      {
        ...pushConfig,
        triggers: {
          ...pushConfig.triggers,
          conversationIdle: false,
        },
      },
      makeProjectConversationNotification(),
    );

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification.mock.calls[0]?.[1].trigger).toBe(
      "conversation-idle",
    );
  });
});

describe("pushForConversationStatus", () => {
  beforeEach(() => {
    sendPushNotification.mockReset();
  });

  it("sends push for waiting_for_input status", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "waiting_for_input",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "waiting-for-input",
      title: "Waiting for input",
      message: "Session sess needs your input",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("does not send push for running status", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("sends push for awaiting status (conversation idle)", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "conversation-idle",
      title: "Agent finished",
      message: "Session sess is now idle",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("suppresses idle push for iteration role conversations", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
      role: "iteration",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("suppresses idle push for validator role conversations", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
      role: "validator",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("suppresses waiting_for_input push for iteration role conversations", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "waiting_for_input",
      role: "iteration",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("sends push for awaiting status when role is initialization", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
      role: "initialization",
    });

    expect(sendPushNotification).toHaveBeenCalled();
  });

  it("sends push for awaiting status when role is null", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
      role: null,
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
  });
});

describe("pushForGraphWorkflowEvent", () => {
  beforeEach(() => {
    sendPushNotification.mockReset();
  });

  it("sends push when workflow completes", async () => {
    await pushForGraphWorkflowEvent(pushConfig, {
      kind: "workflow-completed",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-completed",
      title: "Graph workflow completed",
      message: "Graph workflow completed for session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends push when workflow is halted", async () => {
    await pushForGraphWorkflowEvent(pushConfig, {
      kind: "workflow-halted",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-halted",
      title: "Graph workflow halted",
      message: "Graph workflow halted for session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends push when circuit breaker trips", async () => {
    await pushForGraphWorkflowEvent(pushConfig, {
      kind: "circuit-breaker",
      projectName: "proj",
      sessionName: "sess",
      contextTitle: "Setup Infrastructure",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-halted",
      title: "Circuit breaker tripped",
      message:
        'Circuit breaker tripped in context "Setup Infrastructure" for session sess',
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends push when execution context completes", async () => {
    await pushForGraphWorkflowEvent(pushConfig, {
      kind: "context-completed",
      projectName: "proj",
      sessionName: "sess",
      contextTitle: "Setup Infrastructure",
      completedContexts: 3,
      totalContexts: 8,
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-completed",
      title: "Context completed (3/8)",
      message: 'Context "Setup Infrastructure" completed for session sess',
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends waiting-for-input push when a context awaits approval", async () => {
    await pushForGraphWorkflowEvent(pushConfig, {
      kind: "approval-pending",
      projectName: "proj",
      sessionName: "sess",
      contextTitle: "Setup Infrastructure",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "waiting-for-input",
      title: "Approval required",
      message:
        'Context "Setup Infrastructure" passed validators — review to continue',
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("does not send push when config is undefined", async () => {
    await pushForGraphWorkflowEvent(undefined, {
      kind: "workflow-completed",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});

describe("pushForCollaborationEvent", () => {
  beforeEach(() => {
    sendPushNotification.mockReset();
  });

  it("sends waiting-for-input push when collab pauses", async () => {
    await pushForCollaborationEvent(pushConfig, {
      kind: "paused-for-user-input",
      projectName: "proj",
      sessionName: "sess",
      workflowId: "collab-1",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "waiting-for-input",
      title: "Collab paused — Alex's input needed",
      message: "Collaboration paused on session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends workflow-completed push when collab converges", async () => {
    await pushForCollaborationEvent(pushConfig, {
      kind: "completed-converged",
      projectName: "proj",
      sessionName: "sess",
      workflowId: "collab-1",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-completed",
      title: "Collab converged — merged report ready",
      message: "Collaboration converged on session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends workflow-halted push when collab ends unresolved", async () => {
    await pushForCollaborationEvent(pushConfig, {
      kind: "completed-unresolved",
      projectName: "proj",
      sessionName: "sess",
      workflowId: "collab-1",
      reason: "max_iterations_exceeded",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-halted",
      title: "Collab ended unresolved — latest reports are linked",
      message: "Collaboration ended unresolved on session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("does not send push when config is undefined", async () => {
    await pushForCollaborationEvent(undefined, {
      kind: "paused-for-user-input",
      projectName: "proj",
      sessionName: "sess",
      workflowId: "collab-1",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});
