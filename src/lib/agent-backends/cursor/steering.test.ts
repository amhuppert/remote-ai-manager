import { describe, expect, it } from "vitest";
import { InputDeliveryUncertainError } from "../errors";
import { CursorSteering, type CursorSteerDelivery } from "./steering";

function steer(
  steering: CursorSteering,
  overrides: Partial<CursorSteerDelivery> = {},
): {
  requestId(): string;
  archived(): number;
  outcome: Promise<"delivered" | "uncertain" | "refused">;
} {
  let requestId = "";
  let archived = 0;
  const outcome = steering
    .deliver({
      runId: "run-1",
      text: "Use blue",
      send: (id) => {
        requestId = id;
      },
      onDelivered: async () => {
        archived += 1;
      },
      ...overrides,
    })
    .then(
      () => "delivered" as const,
      (error: unknown) =>
        error instanceof InputDeliveryUncertainError
          ? ("uncertain" as const)
          : ("refused" as const),
    );
  return { requestId: () => requestId, archived: () => archived, outcome };
}

/** Whether the outcome is still open once every queued microtask has run. */
async function isPending(outcome: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const later = new Promise<symbol>((resolve) =>
    setTimeout(() => resolve(marker), 0),
  );
  return (await Promise.race([outcome, later])) === marker;
}

describe("Cursor steering acknowledgements", () => {
  it("ignores stale runs and duplicate replies", async () => {
    const steering = new CursorSteering();
    const delivery = steer(steering);
    const reply = {
      type: "steerResult",
      requestId: delivery.requestId(),
      runId: "old-run",
      outcome: "complete_delivered",
    } as const;
    steering.accept(reply);
    expect(await isPending(delivery.outcome)).toBe(true);
    steering.accept({ ...reply, runId: "run-1" });
    steering.accept({
      ...reply,
      runId: "run-1",
      outcome: "revert_to_followup",
    });
    expect(await delivery.outcome).toBe("delivered");
    expect(delivery.archived()).toBe(1);
  });

  it("runs the delivery work at the acknowledgement and settles with it", async () => {
    const steering = new CursorSteering();
    const order: string[] = [];
    const archive = Promise.withResolvers<void>();
    let settled = false;
    const delivery = steering
      .deliver({
        runId: "run-1",
        text: "Use blue",
        send: (requestId) => {
          order.push("dispatched");
          steering.accept({
            type: "steerResult",
            requestId,
            runId: "run-1",
            outcome: "complete_delivered",
          });
          order.push("after acknowledgement");
        },
        onDelivered: () => {
          order.push("delivered");
          return archive.promise;
        },
      })
      .then(() => {
        settled = true;
      });
    expect(order).toEqual(["dispatched", "delivered", "after acknowledgement"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    archive.resolve();
    await delivery;
    expect(settled).toBe(true);
  });

  it.each([
    ["revert_to_followup", "refused"],
    ["uncertain", "uncertain"],
  ] as const)(
    "holds the provider's %s answer until the run ends",
    async (answer, settled) => {
      const steering = new CursorSteering();
      const delivery = steer(steering);
      steering.accept({
        type: "steerResult",
        requestId: delivery.requestId(),
        runId: "run-1",
        outcome: answer,
      });
      expect(await isPending(delivery.outcome)).toBe(true);
      steering.endRun("run-1", true);
      expect(await delivery.outcome).toBe(settled);
      expect(delivery.archived()).toBe(0);
    },
  );

  it("settles the worker's own refusal as not sent at once", async () => {
    const steering = new CursorSteering();
    const delivery = steer(steering);
    steering.accept({
      type: "steerResult",
      requestId: delivery.requestId(),
      runId: "run-1",
      outcome: "not_sent",
    });
    expect(await isPending(delivery.outcome)).toBe(false);
    expect(await delivery.outcome).toBe("refused");
  });

  it("leaves a held answer uncertain when the run ends without a complete observation", async () => {
    const steering = new CursorSteering();
    const delivery = steer(steering);
    steering.accept({
      type: "steerResult",
      requestId: delivery.requestId(),
      runId: "run-1",
      outcome: "revert_to_followup",
    });
    steering.endRun("run-1", false);
    expect(await delivery.outcome).toBe("uncertain");
    expect(delivery.archived()).toBe(0);
  });

  it("leaves a held SDK revert uncertain when the worker closes", async () => {
    const steering = new CursorSteering();
    const delivery = steer(steering);
    steering.accept({
      type: "steerResult",
      requestId: delivery.requestId(),
      runId: "run-1",
      outcome: "revert_to_followup",
    });
    steering.close();
    expect(await delivery.outcome).toBe("uncertain");
  });

  it.each([null, "revert_to_followup", "uncertain"] as const)(
    "takes the run's echo as delivery after a %s answer",
    async (answer) => {
      const steering = new CursorSteering();
      const delivery = steer(steering, { text: "Use blue\n" });
      if (answer !== null)
        steering.accept({
          type: "steerResult",
          requestId: delivery.requestId(),
          runId: "run-1",
          outcome: answer,
        });
      steering.echoed("other-run", "Use blue");
      steering.echoed("run-1", "Use green");
      expect(await isPending(delivery.outcome)).toBe(true);
      steering.echoed("run-1", "Use blue");
      expect(await delivery.outcome).toBe("delivered");
      expect(delivery.archived()).toBe(1);
    },
  );

  it("lets a delivered steer's echo settle no other steer of the same text", async () => {
    const steering = new CursorSteering();
    const first = steer(steering);
    const second = steer(steering);
    steering.accept({
      type: "steerResult",
      requestId: first.requestId(),
      runId: "run-1",
      outcome: "complete_delivered",
    });
    steering.echoed("run-1", "Use blue");
    expect(await first.outcome).toBe("delivered");
    expect(await isPending(second.outcome)).toBe(true);
    steering.echoed("run-1", "Use blue");
    expect(await second.outcome).toBe("delivered");
  });

  it.each(["run end", "close", "abort"] as const)(
    "marks unanswered input uncertain on %s",
    async (reason) => {
      const steering = new CursorSteering();
      const controller = new AbortController();
      const delivery = steer(steering, { signal: controller.signal });
      if (reason === "close") steering.close();
      if (reason === "abort") controller.abort();
      if (reason === "run end") steering.endRun("run-1", true);
      expect(await delivery.outcome).toBe("uncertain");
      expect(delivery.archived()).toBe(0);
    },
  );

  it("leaves another run's steer waiting when a run ends", async () => {
    const steering = new CursorSteering();
    const delivery = steer(steering, { runId: "run-2" });
    steering.endRun("run-1", true);
    expect(await isPending(delivery.outcome)).toBe(true);
    steering.accept({
      type: "steerResult",
      requestId: delivery.requestId(),
      runId: "run-2",
      outcome: "complete_delivered",
    });
    expect(await delivery.outcome).toBe("delivered");
  });

  it("never dispatches an already cancelled input", async () => {
    const steering = new CursorSteering();
    let dispatched = false;
    const delivery = steer(steering, {
      send: () => {
        dispatched = true;
      },
      signal: AbortSignal.abort(),
    });
    expect(await delivery.outcome).toBe("refused");
    expect(dispatched).toBe(false);
  });
});
