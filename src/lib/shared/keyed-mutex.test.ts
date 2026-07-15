import { describe, expect, it } from "vitest";
import { createKeyedMutex } from "./keyed-mutex";

/** A promise plus its resolve/reject, for driving ordering deterministically. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedMutex", () => {
  it("serializes operations on the same key in submission order", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const first = deferred<void>();

    const a = mutex.run("k", async () => {
      order.push("a-start");
      await first.promise;
      order.push("a-end");
    });
    const b = mutex.run("k", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    // b must not start until a finishes.
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs operations under different keys concurrently", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];
    const gate = deferred<void>();

    const a = mutex.run("k1", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const b = mutex.run("k2", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    // Both started before the first key's operation released.
    await b;
    expect(order).toContain("a-start");
    expect(order).toContain("b-end");
    expect(order.indexOf("a-end")).toBe(-1);

    gate.resolve();
    await a;
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("returns the operation's own result to its caller", async () => {
    const mutex = createKeyedMutex();
    await expect(mutex.run("k", async () => 42)).resolves.toBe(42);
  });

  it("surfaces the operation's own rejection to its caller", async () => {
    const mutex = createKeyedMutex();
    await expect(
      mutex.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not let a failed operation strand the key or reject the next", async () => {
    const mutex = createKeyedMutex();
    const ran: string[] = [];

    const failing = mutex.run("k", async () => {
      ran.push("failing");
      throw new Error("first failed");
    });
    const next = mutex.run("k", async () => {
      ran.push("next");
      return "ok";
    });

    await expect(failing).rejects.toThrow("first failed");
    // The successor still runs and its caller sees success, not the predecessor's error.
    await expect(next).resolves.toBe("ok");
    expect(ran).toEqual(["failing", "next"]);
  });

  it("reports busy state and clears an idle key", async () => {
    const mutex = createKeyedMutex();
    const gate = deferred<void>();

    expect(mutex.isBusy("k")).toBe(false);
    expect(mutex.activeKeyCount()).toBe(0);

    const op = mutex.run("k", async () => {
      await gate.promise;
    });
    expect(mutex.isBusy("k")).toBe(true);
    expect(mutex.activeKeyCount()).toBe(1);

    gate.resolve();
    await op;
    // Settle the deletion microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(mutex.isBusy("k")).toBe(false);
    expect(mutex.activeKeyCount()).toBe(0);
  });

  it("keeps a later submission for the same key alive past an earlier settle", async () => {
    const mutex = createKeyedMutex();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();

    const first = mutex.run("k", async () => {
      await firstGate.promise;
    });
    const second = mutex.run("k", async () => {
      await secondGate.promise;
    });

    firstGate.resolve();
    await first;
    // Second is still queued/running, so the key stays busy.
    expect(mutex.isBusy("k")).toBe(true);

    secondGate.resolve();
    await second;
    await Promise.resolve();
    await Promise.resolve();
    expect(mutex.isBusy("k")).toBe(false);
  });
});
