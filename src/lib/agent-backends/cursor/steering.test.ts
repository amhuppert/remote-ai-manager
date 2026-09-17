import { afterEach, describe, expect, it, vi } from "vitest";
import { InputDeliveryUncertainError } from "../errors";
import { CursorSteering } from "./steering";

afterEach(() => vi.useRealTimers());

describe("Cursor steering acknowledgements", () => {
  it("ignores stale runs and duplicate replies", async () => {
    const steering = new CursorSteering();
    let id = "";
    let accepted = false;
    const delivery = steering
      .deliver("run-1", (requestId) => {
        id = requestId;
      })
      .then(() => {
        accepted = true;
      });
    const reply = {
      type: "steerResult",
      requestId: id,
      runId: "old-run",
      outcome: "complete_delivered",
    } as const;
    steering.accept(reply);
    await Promise.resolve();
    expect(accepted).toBe(false);
    steering.accept({ ...reply, runId: "run-1" });
    steering.accept({
      ...reply,
      runId: "run-1",
      outcome: "revert_to_followup",
    });
    await delivery;
    expect(accepted).toBe(true);
  });

  it.each(["revert_to_followup", "uncertain"] as const)(
    "preserves the provider's %s outcome",
    async (outcome) => {
      const steering = new CursorSteering();
      const delivery = steering.deliver("run-1", (requestId) =>
        steering.accept({
          type: "steerResult",
          requestId,
          runId: "run-1",
          outcome,
        }),
      );
      if (outcome === "uncertain")
        await expect(delivery).rejects.toBeInstanceOf(
          InputDeliveryUncertainError,
        );
      else
        await expect(delivery).rejects.not.toBeInstanceOf(
          InputDeliveryUncertainError,
        );
    },
  );

  it.each(["timeout", "close", "abort"] as const)(
    "marks dispatched input uncertain on %s",
    async (reason) => {
      vi.useFakeTimers();
      const steering = new CursorSteering(100);
      const controller = new AbortController();
      const delivery = steering.deliver("run-1", () => {}, controller.signal);
      const assertion = expect(delivery).rejects.toBeInstanceOf(
        InputDeliveryUncertainError,
      );
      if (reason === "close") steering.close();
      if (reason === "abort") controller.abort();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never dispatches an already cancelled input", async () => {
    const steering = new CursorSteering();
    let dispatched = false;
    await expect(
      steering.deliver(
        "run-1",
        () => {
          dispatched = true;
        },
        AbortSignal.abort(),
      ),
    ).rejects.not.toBeInstanceOf(InputDeliveryUncertainError);
    expect(dispatched).toBe(false);
  });
});
