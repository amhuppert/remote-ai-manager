import { describe, expect, it, vi } from "vitest";
import type { PushNotificationConfig } from "@/lib/notifications/schemas";
import {
  dispatchAgentNotification,
  type AgentNotificationDispatchDeps,
} from "./dispatcher";

const enabledConfig: PushNotificationConfig = {
  enabled: true,
  provider: "ntfy",
  serverUrl: "https://ntfy.sh",
  topic: "cc-topic",
  triggers: {
    jobCompleted: true,
    waitingForInput: true,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: true,
    specApprovalRequested: true,
    specApprovalGranted: true,
    specPolicyAdmitted: true,
  },
};

function makeDeps(overrides: Partial<AgentNotificationDispatchDeps> = {}): {
  deps: AgentNotificationDispatchDeps;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {});
  const deps: AgentNotificationDispatchDeps = {
    async readPushConfig() {
      return enabledConfig;
    },
    sendAgentNotification: send,
    ...overrides,
  };
  return { deps, send };
}

describe("dispatchAgentNotification", () => {
  it("delivers through the agent push sender when push is enabled", async () => {
    const { deps, send } = makeDeps();

    const outcome = await dispatchAgentNotification(
      {
        projectName: "cc",
        sessionName: "sess",
        title: "Build done",
        message: "The build finished",
      },
      deps,
    );

    expect(outcome).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      enabledConfig,
      "Build done",
      "The build finished",
      "robot",
      "cc",
      "sess",
    );
  });

  it("maps urgency=attention to the warning tag", async () => {
    const { deps, send } = makeDeps();

    await dispatchAgentNotification(
      {
        projectName: "cc",
        sessionName: "sess",
        title: "Heads up",
        message: "Needs attention",
        urgency: "attention",
      },
      deps,
    );

    expect(send).toHaveBeenCalledWith(
      enabledConfig,
      "Heads up",
      "Needs attention",
      "warning",
      "cc",
      "sess",
    );
  });

  it("reports not-delivered without sending when push config is absent", async () => {
    const { deps, send } = makeDeps({
      async readPushConfig() {
        return undefined;
      },
    });

    const outcome = await dispatchAgentNotification(
      { projectName: "cc", sessionName: "sess", title: "t", message: "m" },
      deps,
    );

    expect(outcome).toEqual({
      delivered: false,
      reason: "Push notifications are not configured",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports not-delivered when push is disabled", async () => {
    const { deps, send } = makeDeps({
      async readPushConfig() {
        return { ...enabledConfig, enabled: false };
      },
    });

    const outcome = await dispatchAgentNotification(
      { projectName: "cc", sessionName: "sess", title: "t", message: "m" },
      deps,
    );

    expect(outcome.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports not-delivered when enabled but no topic is set", async () => {
    const { deps, send } = makeDeps({
      async readPushConfig() {
        return { ...enabledConfig, topic: "   " };
      },
    });

    const outcome = await dispatchAgentNotification(
      { projectName: "cc", sessionName: "sess", title: "t", message: "m" },
      deps,
    );

    expect(outcome.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
