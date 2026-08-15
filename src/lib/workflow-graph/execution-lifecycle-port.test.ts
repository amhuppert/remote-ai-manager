import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  registerGraphExecutionLifecycleCallbacks,
  resetGraphExecutionLifecycleCallbacksForTesting,
} from "./execution-lifecycle-port";
import type { GraphWorkflowExecutionOrigin } from "@/lib/workflow-graph/schemas";

const TEMPLATE_ORIGIN: GraphWorkflowExecutionOrigin = {
  kind: "template",
  definitionId: "definition-1",
  definitionRevision: 7,
  tier: "project",
};

describe("graph execution lifecycle port", () => {
  afterEach(() => {
    resetGraphExecutionLifecycleCallbacksForTesting();
  });

  it("forwards running and delivered transitions to the registered callbacks", async () => {
    const markRunning = vi.fn(async () => {});
    const markDelivered = vi.fn(async () => {});
    registerGraphExecutionLifecycleCallbacks({ markRunning, markDelivered });

    const callbacks = createRegisteredGraphExecutionLifecycleCallbacks();
    await callbacks.markRunning(
      { projectPath: "/repo", sessionName: "session-1" },
      "workflow-execution-1",
      TEMPLATE_ORIGIN,
    );
    await callbacks.markDelivered("workflow-execution-1", "merge-sha");

    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "workflow-execution-1",
      TEMPLATE_ORIGIN,
    );
    expect(markDelivered).toHaveBeenCalledWith(
      "workflow-execution-1",
      "merge-sha",
    );
  });

  it("fails closed when a linked lifecycle transition has no composition", async () => {
    const callbacks = createRegisteredGraphExecutionLifecycleCallbacks();

    await expect(
      callbacks.markRunning(
        { projectPath: "/repo", sessionName: "session-1" },
        "workflow-execution-1",
      ),
    ).rejects.toThrow("Graph execution lifecycle callbacks are not registered");
  });
});
