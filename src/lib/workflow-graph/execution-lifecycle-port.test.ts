import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  registerGraphExecutionLifecycleCallbacks,
  resetGraphExecutionLifecycleCallbacksForTesting,
} from "./execution-lifecycle-port";

describe("graph execution lifecycle port", () => {
  afterEach(() => {
    resetGraphExecutionLifecycleCallbacksForTesting();
  });

  it("forwards running and delivered transitions to the registered callbacks", async () => {
    const markRunning = vi.fn(async () => {});
    const markDelivered = vi.fn(async () => {});
    registerGraphExecutionLifecycleCallbacks({ markRunning, markDelivered });

    const callbacks = createRegisteredGraphExecutionLifecycleCallbacks();
    await callbacks.markRunning("workflow-execution-1", "definition-1");
    await callbacks.markDelivered("workflow-execution-1", "merge-sha");

    // The started definition id is forwarded so the consumer can correlate
    // the run with work prepared under that definition.
    expect(markRunning).toHaveBeenCalledWith(
      "workflow-execution-1",
      "definition-1",
    );
    expect(markDelivered).toHaveBeenCalledWith(
      "workflow-execution-1",
      "merge-sha",
    );
  });

  it("fails closed when a linked lifecycle transition has no composition", async () => {
    const callbacks = createRegisteredGraphExecutionLifecycleCallbacks();

    await expect(callbacks.markRunning("workflow-execution-1")).rejects.toThrow(
      "Graph execution lifecycle callbacks are not registered",
    );
  });
});
