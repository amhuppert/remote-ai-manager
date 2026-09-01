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

  it("acquires multiple project paths in lexicographic order", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseZDeletion = deferred();
    const releaseOperation = deferred();
    const order: string[] = [];
    let deletionPrecededOperation = false;

    const operation = gate.runMultiProjectTicketOperation(
      ["/projects/z", "/projects/a"],
      async (context) => {
        deletionPrecededOperation = context.projectDeletionPrecededOperation;
        order.push("operation:start");
        await releaseOperation.promise;
        order.push("operation:end");
      },
    );
    const aDeletion = gate.runProjectDeletion("/projects/a", async () => {
      order.push("a:delete");
    });
    const zDeletion = gate.runProjectDeletion("/projects/z", async () => {
      order.push("z:delete:start");
      await releaseZDeletion.promise;
      order.push("z:delete:end");
    });

    await vi.waitFor(() => {
      expect(order).toEqual(["z:delete:start"]);
    });

    releaseZDeletion.resolve();
    await vi.waitFor(() => {
      expect(order).toEqual([
        "z:delete:start",
        "z:delete:end",
        "operation:start",
      ]);
    });
    expect(deletionPrecededOperation).toBe(true);

    releaseOperation.resolve();
    await Promise.all([operation, aDeletion, zDeletion]);
    expect(order).toEqual([
      "z:delete:start",
      "z:delete:end",
      "operation:start",
      "operation:end",
      "a:delete",
    ]);
  });

  it("releases multiple project paths in reverse acquisition order", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseOperation = deferred();
    const order: string[] = [];

    const operation = gate.runMultiProjectTicketOperation(
      ["/projects/z", "/projects/a"],
      async () => {
        order.push("operation:start");
        await releaseOperation.promise;
        order.push("operation:end");
      },
    );
    await vi.waitFor(() => {
      expect(order).toEqual(["operation:start"]);
    });

    const aDeletion = gate.runProjectDeletion("/projects/a", async () => {
      order.push("a:delete");
    });
    const zDeletion = gate.runProjectDeletion("/projects/z", async () => {
      order.push("z:delete");
    });
    expect(order).toEqual(["operation:start"]);

    releaseOperation.resolve();
    await Promise.all([operation, aDeletion, zDeletion]);
    expect(order).toEqual([
      "operation:start",
      "operation:end",
      "z:delete",
      "a:delete",
    ]);
  });

  it("collapses duplicate project paths before acquiring gates", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseOperation = deferred();
    let operationStarted = false;
    let deletionStarted = false;

    const operation = gate.runMultiProjectTicketOperation(
      ["/projects/a", "/projects/a"],
      async () => {
        operationStarted = true;
        await releaseOperation.promise;
      },
    );
    const deletion = gate.runProjectDeletion("/projects/a", async () => {
      deletionStarted = true;
    });

    await vi.waitFor(() => {
      expect(operationStarted).toBe(true);
    });
    expect(deletionStarted).toBe(false);

    releaseOperation.resolve();
    await Promise.all([operation, deletion]);
    expect(deletionStarted).toBe(true);
  });

  it("lets opposite-direction multi-project operations overlap without deadlock", async () => {
    const gate = createTicketProjectOperationGate();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const order: string[] = [];

    const first = gate.runMultiProjectTicketOperation(
      ["/projects/a", "/projects/z"],
      async (context) => {
        expect(context.projectDeletionPrecededOperation).toBe(false);
        order.push("first:start");
        await releaseFirst.promise;
        order.push("first:end");
      },
    );
    const second = gate.runMultiProjectTicketOperation(
      ["/projects/z", "/projects/a"],
      async (context) => {
        expect(context.projectDeletionPrecededOperation).toBe(false);
        order.push("second:start");
        await releaseSecond.promise;
        order.push("second:end");
      },
    );

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start", "second:start"]);
    });

    const aDeletion = gate.runProjectDeletion("/projects/a", async () => {
      order.push("a:delete");
    });
    const zDeletion = gate.runProjectDeletion("/projects/z", async () => {
      order.push("z:delete");
    });
    expect(order).toEqual(["first:start", "second:start"]);

    releaseFirst.resolve();
    await first;
    expect(order).toEqual(["first:start", "second:start", "first:end"]);

    releaseSecond.resolve();
    await Promise.all([second, aDeletion, zDeletion]);
    expect(order).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
      "z:delete",
      "a:delete",
    ]);
  });

  it("reports when any acquired project waited behind deletion", async () => {
    const gate = createTicketProjectOperationGate();
    const deletionStarted = deferred();
    const releaseDeletion = deferred();
    let operationStarted = false;
    let deletionPrecededOperation = false;

    const deletion = gate.runProjectDeletion("/projects/z", async () => {
      deletionStarted.resolve();
      await releaseDeletion.promise;
    });
    await deletionStarted.promise;

    const operation = gate.runMultiProjectTicketOperation(
      ["/projects/z", "/projects/a"],
      async (context) => {
        operationStarted = true;
        deletionPrecededOperation = context.projectDeletionPrecededOperation;
      },
    );
    await Promise.resolve();
    expect(operationStarted).toBe(false);

    releaseDeletion.resolve();
    await Promise.all([deletion, operation]);
    expect(operationStarted).toBe(true);
    expect(deletionPrecededOperation).toBe(true);
  });
});
