import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pushForNotification,
  pushForConversationStatus,
  pushForWorkflowStatus,
} from "./push-dispatcher";
import type { PushNotificationConfig, Notification } from "@/types";
import * as pushMod from "./push-notification";

vi.mock("./push-notification", () => ({
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
  },
};

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "test-id",
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

  it("does not send push for awaiting status", async () => {
    await pushForConversationStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});

describe("pushForWorkflowStatus", () => {
  beforeEach(() => {
    sendPushNotification.mockReset();
  });

  it("sends push for completed workflow", async () => {
    await pushForWorkflowStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      workflowStatus: "completed",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-completed",
      title: "Workflow completed",
      message: "Ralph Loop workflow completed for session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("sends push for halted workflow", async () => {
    await pushForWorkflowStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      workflowStatus: "halted",
    });

    expect(sendPushNotification).toHaveBeenCalledOnce();
    expect(sendPushNotification).toHaveBeenCalledWith(pushConfig, {
      trigger: "workflow-halted",
      title: "Workflow halted",
      message: "Ralph Loop workflow halted for session sess",
      projectName: "proj",
      sessionName: "sess",
    });
  });

  it("does not send push for running workflow", async () => {
    await pushForWorkflowStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      workflowStatus: "running",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("does not send push for stopped workflow", async () => {
    await pushForWorkflowStatus(pushConfig, {
      projectName: "proj",
      sessionName: "sess",
      workflowStatus: "stopped",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});
