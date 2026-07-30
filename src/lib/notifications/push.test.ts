import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendPushNotification,
  shouldSendPush,
  formatPushMessage,
  sendAgentNotification,
  type PushEvent,
} from "./push";
import type { PushNotificationConfig } from "@/lib/notifications/schemas";
// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(
  overrides: Partial<PushNotificationConfig> = {},
): PushNotificationConfig {
  return {
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
      specApprovalRequested: true,
      specApprovalGranted: true,
      specPolicyAdmitted: true,
      planRepair: true,
    },
    ...overrides,
  };
}

describe("shouldSendPush", () => {
  it("returns false when disabled", () => {
    const config = makeConfig({ enabled: false });
    expect(shouldSendPush(config, "job-completed")).toBe(false);
  });

  it("returns false when topic is empty", () => {
    const config = makeConfig({ topic: "" });
    expect(shouldSendPush(config, "job-completed")).toBe(false);
  });

  it("returns true for enabled trigger", () => {
    const config = makeConfig();
    expect(shouldSendPush(config, "job-completed")).toBe(true);
    expect(shouldSendPush(config, "waiting-for-input")).toBe(true);
    expect(shouldSendPush(config, "workflow-completed")).toBe(true);
    expect(shouldSendPush(config, "workflow-halted")).toBe(true);
    expect(shouldSendPush(config, "conversation-idle")).toBe(true);
  });

  it("returns false when conversationIdle trigger is disabled", () => {
    const config = makeConfig({
      triggers: {
        jobCompleted: true,
        waitingForInput: true,
        workflowCompleted: true,
        workflowHalted: true,
        conversationIdle: false,
        specApprovalRequested: true,
        specApprovalGranted: true,
        specPolicyAdmitted: true,
        planRepair: true,
      },
    });
    expect(shouldSendPush(config, "conversation-idle")).toBe(false);
  });

  it("returns false for disabled trigger", () => {
    const config = makeConfig({
      triggers: {
        jobCompleted: false,
        waitingForInput: true,
        workflowCompleted: true,
        workflowHalted: true,
        conversationIdle: true,
        specApprovalRequested: true,
        specApprovalGranted: true,
        specPolicyAdmitted: true,
        planRepair: true,
      },
    });
    expect(shouldSendPush(config, "job-completed")).toBe(false);
    expect(shouldSendPush(config, "waiting-for-input")).toBe(true);
  });

  it("returns false when config is undefined", () => {
    expect(shouldSendPush(undefined, "job-completed")).toBe(false);
  });
});

describe("formatPushMessage", () => {
  it("formats a job-completed event", () => {
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Merge completed",
      message: "Branch csm/feature merged into main",
      projectName: "my-project",
      sessionName: "feature-session",
    };
    const result = formatPushMessage(event);
    expect(result.title).toBe("[my-project] Merge completed");
    expect(result.body).toBe("Branch csm/feature merged into main");
    expect(result.tags).toContain("white_check_mark");
  });

  it("formats a waiting-for-input event", () => {
    const event: PushEvent = {
      trigger: "waiting-for-input",
      title: "Waiting for input",
      message: "Agent needs your input",
      projectName: "my-project",
      sessionName: "feature-session",
    };
    const result = formatPushMessage(event);
    expect(result.title).toBe("[my-project] Waiting for input");
    expect(result.tags).toContain("bell");
  });

  it("formats a workflow-halted event", () => {
    const event: PushEvent = {
      trigger: "workflow-halted",
      title: "Workflow halted",
      message: "Circuit breaker triggered",
      projectName: "my-project",
      sessionName: "feature-session",
    };
    const result = formatPushMessage(event);
    expect(result.tags).toContain("warning");
  });

  it("formats a workflow-completed event", () => {
    const event: PushEvent = {
      trigger: "workflow-completed",
      title: "Workflow completed",
      message: "All tasks done",
      projectName: "my-project",
      sessionName: "feature-session",
    };
    const result = formatPushMessage(event);
    expect(result.tags).toContain("tada");
  });

  it("formats a conversation-idle event", () => {
    const event: PushEvent = {
      trigger: "conversation-idle",
      title: "Agent finished",
      message: "Session my-session is now idle",
      projectName: "my-project",
      sessionName: "my-session",
    };
    const result = formatPushMessage(event);
    expect(result.title).toBe("[my-project] Agent finished");
    expect(result.body).toBe("Session my-session is now idle");
    expect(result.tags).toBe("zzz");
  });
});

describe("sendPushNotification", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends a POST to ntfy root URL with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Merge completed",
      message: "Branch merged",
      projectName: "proj",
      sessionName: "sess",
    };

    await sendPushNotification(config, event);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      topic: "test-topic",
      title: "[proj] Merge completed",
      message: "Branch merged",
      tags: ["white_check_mark"],
    });
  });

  it("sends non-ASCII titles without throwing (em-dash regression)", async () => {
    mockFetch.mockImplementationOnce(async (input, init) => {
      // Force native validation: this is what real fetch does internally.
      new Request(input as string, init as RequestInit);
      return { ok: true, status: 200 };
    });
    const config = makeConfig();
    const event: PushEvent = {
      trigger: "workflow-completed",
      title: "Collab converged — merged report ready",
      message: "Collaboration converged on session sess",
      projectName: "remote-ai-manager",
      sessionName: "sess",
    };

    await expect(sendPushNotification(config, event)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("does not send when shouldSendPush returns false", async () => {
    const config = makeConfig({ enabled: false });
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Test",
      message: "Test",
      projectName: "proj",
      sessionName: "sess",
    };

    await sendPushNotification(config, event);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not throw on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const config = makeConfig();
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Test",
      message: "Test",
      projectName: "proj",
      sessionName: "sess",
    };

    // Should not throw
    await expect(sendPushNotification(config, event)).resolves.toBeUndefined();
  });

  it("does not throw on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const config = makeConfig();
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Test",
      message: "Test",
      projectName: "proj",
      sessionName: "sess",
    };

    await expect(sendPushNotification(config, event)).resolves.toBeUndefined();
  });

  it("uses custom server URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig({ serverUrl: "https://my-ntfy.example.com" });
    const event: PushEvent = {
      trigger: "waiting-for-input",
      title: "Input needed",
      message: "Claude waiting",
      projectName: "proj",
      sessionName: "sess",
    };

    await sendPushNotification(config, event);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-ntfy.example.com/");
  });

  it("strips trailing slash from server URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig({ serverUrl: "https://ntfy.sh/" });
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Test",
      message: "Test",
      projectName: "proj",
      sessionName: "sess",
    };

    await sendPushNotification(config, event);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/");
  });

  it("falls back to the default ntfy server when serverUrl is absent", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();
    delete (config as Partial<PushNotificationConfig>).serverUrl;
    const event: PushEvent = {
      trigger: "job-completed",
      title: "Test",
      message: "Test",
      projectName: "proj",
      sessionName: "sess",
    };

    await expect(sendPushNotification(config, event)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/");
  });
});

const sessionTarget = {
  scope: "session" as const,
  projectName: "proj",
  sessionName: "sess",
};

describe("sendAgentNotification", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends POST to ntfy root URL with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();

    await sendAgentNotification(
      config,
      "Build Done",
      "All tests passed",
      "white_check_mark",
      {
        scope: "session",
        projectName: "my-project",
        sessionName: "my-session",
      },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      topic: "test-topic",
      title: "[my-project] Build Done",
      message: "All tests passed",
      tags: ["white_check_mark"],
    });
  });

  it("formats title with project name prefix", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();

    await sendAgentNotification(config, "Task Complete", "Done", "robot", {
      scope: "session",
      projectName: "cool-project",
      sessionName: "sess",
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.title).toBe("[cool-project] Task Complete");
  });

  it("logs warning on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const config = makeConfig();

    // Should not throw
    await expect(
      sendAgentNotification(config, "Test", "Body", "robot", sessionTarget),
    ).resolves.toBeUndefined();
  });

  it("logs warning on network error (fetch throws)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
    const config = makeConfig();

    // Should not throw
    await expect(
      sendAgentNotification(config, "Test", "Body", "robot", sessionTarget),
    ).resolves.toBeUndefined();
  });

  it("falls back to the default ntfy server when serverUrl is absent", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    // The config loader strips schema defaults not written to disk, so a
    // persisted push config can reach the sender without serverUrl despite the
    // non-optional type. It must publish to the ntfy.sh default, not crash.
    const config = makeConfig();
    delete (config as Partial<PushNotificationConfig>).serverUrl;

    await expect(
      sendAgentNotification(config, "Build Done", "ok", "robot", sessionTarget),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/");
  });
});
