import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendPushNotification,
  shouldSendPush,
  formatPushMessage,
  sendAgentNotification,
  type PushEvent,
} from "./push-notification";
import type { PushNotificationConfig } from "@/types";

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
      message: "Claude needs your input",
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

  it("sends a POST to ntfy with correct headers", async () => {
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
    expect(url).toBe("https://ntfy.sh/test-topic");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(
      expect.objectContaining({
        Title: "[proj] Merge completed",
        Tags: "white_check_mark",
      }),
    );
    expect(options.body).toBe("Branch merged");
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
    expect(url).toBe("https://my-ntfy.example.com/test-topic");
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
    expect(url).toBe("https://ntfy.sh/test-topic");
  });
});

describe("sendAgentNotification", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends POST to correct ntfy URL with correct headers and body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();

    await sendAgentNotification(
      config,
      "Build Done",
      "All tests passed",
      "white_check_mark",
      "my-project",
      "my-session",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/test-topic");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(
      expect.objectContaining({
        Title: "[my-project] Build Done",
        Tags: "white_check_mark",
      }),
    );
    expect(options.body).toBe("All tests passed");
  });

  it("formats title with project name prefix", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const config = makeConfig();

    await sendAgentNotification(
      config,
      "Task Complete",
      "Done",
      "robot",
      "cool-project",
      "sess",
    );

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Title).toBe("[cool-project] Task Complete");
  });

  it("logs warning on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const config = makeConfig();

    // Should not throw
    await expect(
      sendAgentNotification(config, "Test", "Body", "robot", "proj", "sess"),
    ).resolves.toBeUndefined();
  });

  it("logs warning on network error (fetch throws)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
    const config = makeConfig();

    // Should not throw
    await expect(
      sendAgentNotification(config, "Test", "Body", "robot", "proj", "sess"),
    ).resolves.toBeUndefined();
  });
});
