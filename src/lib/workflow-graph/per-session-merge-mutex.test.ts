import { describe, it, expect } from "vitest";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPerSessionMergeMutex", () => {
  const key = { projectPath: "/proj", sessionName: "session-a" };

  it("runs three concurrent calls for the same key in FIFO submission order", async () => {
    const mutex = createPerSessionMergeMutex();
    const order: string[] = [];

    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const p1 = mutex.withMergeMutex(key, async () => {
      order.push("start-1");
      await gates[0]!.promise;
      order.push("end-1");
      return 1;
    });

    const p2 = mutex.withMergeMutex(key, async () => {
      order.push("start-2");
      await gates[1]!.promise;
      order.push("end-2");
      return 2;
    });

    const p3 = mutex.withMergeMutex(key, async () => {
      order.push("start-3");
      await gates[2]!.promise;
      order.push("end-3");
      return 3;
    });

    // Allow microtasks to run; only the first should have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    gates[0]!.resolve();
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1", "end-1", "start-2"]);

    gates[1]!.resolve();
    await p2;
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3"]);

    gates[2]!.resolve();
    await expect(p3).resolves.toBe(3);
    expect(order).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });

  it("a thrown error in one fn does not block subsequent submissions on the same key", async () => {
    const mutex = createPerSessionMergeMutex();
    const order: string[] = [];

    const p1 = mutex.withMergeMutex(key, async () => {
      order.push("start-1");
      throw new Error("boom");
    });

    const p2 = mutex.withMergeMutex(key, async () => {
      order.push("start-2");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(order).toEqual(["start-1", "start-2"]);
  });

  it("distinct keys do not block each other", async () => {
    const mutex = createPerSessionMergeMutex();
    const order: string[] = [];

    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const pA = mutex.withMergeMutex(
      { projectPath: "/proj", sessionName: "session-a" },
      async () => {
        order.push("start-a");
        await gateA.promise;
        order.push("end-a");
      },
    );

    const pB = mutex.withMergeMutex(
      { projectPath: "/proj", sessionName: "session-b" },
      async () => {
        order.push("start-b");
        await gateB.promise;
        order.push("end-b");
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-a", "start-b"]);

    gateB.resolve();
    await pB;
    expect(order).toContain("end-b");
    expect(order).not.toContain("end-a");

    gateA.resolve();
    await pA;
    expect(order).toContain("end-a");
  });

  it("releases the lock on rejection so the same key is reusable", async () => {
    const mutex = createPerSessionMergeMutex();

    await expect(
      mutex.withMergeMutex(key, async () => {
        throw new Error("first");
      }),
    ).rejects.toThrow("first");

    await expect(mutex.withMergeMutex(key, async () => "second")).resolves.toBe(
      "second",
    );
  });
});
