import { abortHandle } from "@/lib/shared/abort-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerAbortController,
  unregisterAbortController,
} from "./abort-registry";
import {
  registerRuntime,
  _resetForTesting as resetRuntimeRegistry,
} from "@/lib/agent-backends/runtime-registry";

describe("abort-registry", () => {
  afterEach(() => {
    resetRuntimeRegistry();
  });

  it("unregister removes the controller it registered", async () => {
    const controller = new AbortController();
    registerAbortController("conv-basic", controller);

    unregisterAbortController("conv-basic", controller);

    expect(abortHandle("conversation:conv-basic")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("a stale unregister does not delete a replacement turn's controller", async () => {
    // Interleaving: resume aborts old turn A, the replacement turn B
    // registers under the same conversation id, then A's async teardown
    // finally runs. An id-only delete would remove B, making the replacement
    // turn uncancellable for its whole run.
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    registerAbortController("conv-race", controllerA);
    registerAbortController("conv-race", controllerB);

    unregisterAbortController("conv-race", controllerA);

    expect(abortHandle("conversation:conv-race")).toBe(true);
    expect(controllerB.signal.aborted).toBe(true);
    expect(controllerA.signal.aborted).toBe(false);
  });

  it("the domain index is visible to the shared signal registry", async () => {
    const controller = new AbortController();
    registerAbortController("conv-abort", controller);

    expect(abortHandle("conversation:conv-abort")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // Already removed: a second abort finds nothing.
    expect(abortHandle("conversation:conv-abort")).toBe(false);
  });

  it("signals the indexed controller while leaving runtime closure to its owner", async () => {
    const controller = new AbortController();
    registerAbortController("conv-close-rejects", controller);
    const close = vi.fn(async () => {
      throw new Error("teardown failed");
    });
    registerRuntime("conv-close-rejects", {
      backend: "claude",
      status: "alive",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },

      sendTurn: async () => {
        throw new Error("sendTurn is not exercised by abort");
      },
      close,
    });

    expect(abortHandle("conversation:conv-close-rejects")).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    expect(close).not.toHaveBeenCalled();
  });
});
