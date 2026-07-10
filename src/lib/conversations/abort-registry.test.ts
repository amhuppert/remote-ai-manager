import { describe, expect, it } from "vitest";
import {
  abortConversation,
  registerAbortController,
  unregisterAbortController,
} from "./abort-registry";

describe("abort-registry", () => {
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
});
