import { describe, expect, it, vi } from "vitest";

import { createTicketProjectOperationGate } from "./project-operation-gate";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ticket project operation gate", () => {
  it("lets ticket operations overlap but gives a queued deletion exclusive access", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const order: string[] = [];
    let deletionPrecededLateOperation = false;

    const first = gate.runTicketOperation("/projects/demo", async () => {
      order.push("first:start");
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = gate.runTicketOperation("/projects/demo", async () => {
      order.push("second:start");
      await releaseSecond.promise;
      order.push("second:end");
    });
    await vi.waitFor(() => {
      expect(order).toEqual(["first:start", "second:start"]);
    });

    const deletion = gate.runProjectDeletion("/projects/demo", async () => {
      order.push("delete:start");
      order.push("delete:end");
    });
    const lateOperation = gate.runTicketOperation(
      "/projects/demo",
      async (context) => {
        deletionPrecededLateOperation =
          context.projectDeletionPrecededOperation;
        order.push("late:start");
      },
    );

    releaseFirst.resolve();
    await first;
    expect(order).not.toContain("delete:start");
    releaseSecond.resolve();
    await Promise.all([second, deletion, lateOperation]);

    expect(order).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
      "delete:start",
      "delete:end",
      "late:start",
    ]);
    expect(deletionPrecededLateOperation).toBe(true);

    await gate.runTicketOperation("/projects/demo", async (context) => {
      expect(context.projectDeletionPrecededOperation).toBe(false);
    });
  });

  it("does not block operations for another project", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseDeletion = deferred();
    const deletion = gate.runProjectDeletion("/projects/a", async () => {
      await releaseDeletion.promise;
    });
    const other = vi.fn();

    await gate.runTicketOperation("/projects/b", async () => other());

    expect(other).toHaveBeenCalledOnce();
    releaseDeletion.resolve();
    await deletion;
  });
});
