import { afterEach, describe, expect, it } from "vitest";
import {
  abortConversation,
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

    expect(abortConversation("conv-basic")).toBe(false);
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

    expect(abortConversation("conv-race")).toBe(true);
    expect(controllerB.signal.aborted).toBe(true);
    expect(controllerA.signal.aborted).toBe(false);
  });

  it("abortConversation aborts and removes the registered controller", async () => {
    const controller = new AbortController();
    registerAbortController("conv-abort", controller);

    expect(abortConversation("conv-abort")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // Already removed: a second abort finds nothing.
    expect(abortConversation("conv-abort")).toBe(false);
  });

  it("still signals the abort when the runtime teardown rejects", async () => {
    // Abort is synchronous and reports whether a turn was signalled; runtime
    // teardown resolves later. A rejected teardown must not surface as an
    // unhandled rejection (which fails the run) or change the abort verdict.
    const controller = new AbortController();
    registerAbortController("conv-close-rejects", controller);
    registerRuntime("conv-close-rejects", {
      backend: "claude",
      status: "alive",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      outputFormat: undefined,
      alignmentVersion: null,
      sendTurn: async () => {
        throw new Error("sendTurn is not exercised by abort");
      },
      close: () => Promise.reject(new Error("teardown failed")),
    });

    expect(abortConversation("conv-close-rejects")).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    // Let the rejected teardown settle so an unhandled rejection would surface.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
