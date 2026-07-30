import { describe, expect, it, vi } from "vitest";
import type { PushNotificationConfig } from "@/lib/notifications/schemas";
import {
  dispatchAgentNotification,
  type AgentNotificationDispatchDeps,
} from "./dispatcher";
import { projectConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentNotificationTarget } from "@/lib/notifications/push";

const sessionTarget: AgentNotificationTarget = {
  scope: "session",
  projectName: "cc",
  sessionName: "sess",
};

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
    planRepair: true,
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
        target: sessionTarget,
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
      sessionTarget,
    );
  });

  it("maps urgency=attention to the warning tag", async () => {
    const { deps, send } = makeDeps();

    await dispatchAgentNotification(
      {
        target: sessionTarget,
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
      sessionTarget,
    );
  });

  it("delivers a project-conversation notification through the same sender", async () => {
    const { deps, send } = makeDeps();
    const target = projectConversationTarget("cc", "conv-1");

    const outcome = await dispatchAgentNotification(
      { target, title: "PLC done", message: "Repo chat finished" },
      deps,
    );

    expect(outcome).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledWith(
      enabledConfig,
      "PLC done",
      "Repo chat finished",
      "robot",
      target,
    );
    // The project target has no sessionName key at all — nothing downstream can
    // report the internal sentinel as a session identity.
    expect(JSON.stringify(send.mock.calls[0])).not.toContain("sessionName");
  });

  it("reports not-delivered without sending when push config is absent", async () => {
    const { deps, send } = makeDeps({
      async readPushConfig() {
        return undefined;
      },
    });

    const outcome = await dispatchAgentNotification(
      { target: sessionTarget, title: "t", message: "m" },
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
      { target: sessionTarget, title: "t", message: "m" },
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
      { target: sessionTarget, title: "t", message: "m" },
      deps,
    );

    expect(outcome.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
