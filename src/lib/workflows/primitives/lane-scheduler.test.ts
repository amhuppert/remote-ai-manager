import { describe, expect, it } from "vitest";
import { createLaneScheduler } from "./lane-scheduler";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLaneScheduler — write-capable serialization", () => {
  it("runs write-capable executions on the same session sequentially", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];
    const aGate = deferred<string>();
    const bGate = deferred<string>();

    const aRun = scheduler.schedule(
      { sessionKey: "proj/session-x", writeCapability: "write_capable" },
      async () => {
        order.push("a:start");
        const value = await aGate.promise;
        order.push("a:end");
        return value;
      },
    );

    const bRun = scheduler.schedule(
      { sessionKey: "proj/session-x", writeCapability: "write_capable" },
      async () => {
        order.push("b:start");
        const value = await bGate.promise;
        order.push("b:end");
        return value;
      },
    );

    // Let microtasks drain — only "a:start" should be observed.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    aGate.resolve("a-result");
    bGate.resolve("b-result");
    expect(await aRun).toBe("a-result");
    expect(await bRun).toBe("b-result");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("does not block write-capable executions across different session keys", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];
    const xGate = deferred<string>();
    const yGate = deferred<string>();

    const xRun = scheduler.schedule(
      { sessionKey: "proj/session-x", writeCapability: "write_capable" },
      async () => {
        order.push("x:start");
        const v = await xGate.promise;
        order.push("x:end");
        return v;
      },
    );

    const yRun = scheduler.schedule(
      { sessionKey: "proj/session-y", writeCapability: "write_capable" },
      async () => {
        order.push("y:start");
        const v = await yGate.promise;
        order.push("y:end");
        return v;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order.sort()).toEqual(["x:start", "y:start"]);

    xGate.resolve("x");
    yGate.resolve("y");
    expect(await xRun).toBe("x");
    expect(await yRun).toBe("y");
  });

  it("continues the chain even when an earlier write rejects", async () => {
    const scheduler = createLaneScheduler();
    const failing = scheduler.schedule(
      { sessionKey: "s", writeCapability: "write_capable" },
      async () => {
        throw new Error("first failed");
      },
    );

    const followUp = scheduler.schedule(
      { sessionKey: "s", writeCapability: "write_capable" },
      async () => "second-ok",
    );

    await expect(failing).rejects.toThrow("first failed");
    expect(await followUp).toBe("second-ok");
  });
});

describe("createLaneScheduler — read-only concurrency", () => {
  it("runs read-only executions in parallel with each other", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];
    const aGate = deferred<string>();
    const bGate = deferred<string>();

    const aRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "read_only" },
      async () => {
        order.push("a:start");
        return aGate.promise;
      },
    );

    const bRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "read_only" },
      async () => {
        order.push("b:start");
        return bGate.promise;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order.sort()).toEqual(["a:start", "b:start"]);

    bGate.resolve("b");
    aGate.resolve("a");
    expect(await aRun).toBe("a");
    expect(await bRun).toBe("b");
  });

  it("does not delay a read-only execution behind a queued write", async () => {
    const scheduler = createLaneScheduler();
    const writeGate = deferred<string>();
    let readSeenWriteRunning = false;

    const writeRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "write_capable" },
      async () => {
        const v = await writeGate.promise;
        return v;
      },
    );

    const readRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "read_only" },
      async () => {
        readSeenWriteRunning = true;
        return "read-result";
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(readSeenWriteRunning).toBe(true);

    writeGate.resolve("write-result");
    expect(await writeRun).toBe("write-result");
    expect(await readRun).toBe("read-result");
  });
});

describe("createLaneScheduler — artifact-only concurrency", () => {
  it("runs artifact-only executions on the same session in parallel with each other", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];
    const aGate = deferred<string>();
    const bGate = deferred<string>();

    const aRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "artifact_only" },
      async () => {
        order.push("a:start");
        return aGate.promise;
      },
    );

    const bRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "artifact_only" },
      async () => {
        order.push("b:start");
        return bGate.promise;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order.sort()).toEqual(["a:start", "b:start"]);

    bGate.resolve("b");
    aGate.resolve("a");
    expect(await aRun).toBe("a");
    expect(await bRun).toBe("b");
  });

  it("does not delay an artifact-only execution behind a queued write", async () => {
    const scheduler = createLaneScheduler();
    const writeGate = deferred<string>();
    let artifactRan = false;

    const writeRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "write_capable" },
      async () => writeGate.promise,
    );

    const artifactRun = scheduler.schedule(
      { sessionKey: "s", writeCapability: "artifact_only" },
      async () => {
        artifactRan = true;
        return "artifact-result";
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(artifactRan).toBe(true);

    writeGate.resolve("write-result");
    expect(await writeRun).toBe("write-result");
    expect(await artifactRun).toBe("artifact-result");
  });
});

describe("createLaneScheduler — default safety", () => {
  it("treats unspecified write intent as write-capable so executions on the same session serialize", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];
    const firstGate = deferred<string>();

    const firstRun = scheduler.schedule({ sessionKey: "s" }, async () => {
      order.push("first:start");
      const v = await firstGate.promise;
      order.push("first:end");
      return v;
    });

    const secondRun = scheduler.schedule({ sessionKey: "s" }, async () => {
      order.push("second:start");
      return "second";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    firstGate.resolve("first");
    expect(await firstRun).toBe("first");
    expect(await secondRun).toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("treats unspecified write intent as write-capable even after read-only calls have run", async () => {
    const scheduler = createLaneScheduler();
    const order: string[] = [];

    await scheduler.schedule(
      { sessionKey: "s", writeCapability: "read_only" },
      async () => {
        order.push("read");
      },
    );

    const writeAGate = deferred<void>();
    const writeA = scheduler.schedule({ sessionKey: "s" }, async () => {
      order.push("writeA:start");
      await writeAGate.promise;
      order.push("writeA:end");
    });

    const writeB = scheduler.schedule({ sessionKey: "s" }, async () => {
      order.push("writeB:start");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["read", "writeA:start"]);

    writeAGate.resolve();
    await writeA;
    await writeB;
    expect(order).toEqual([
      "read",
      "writeA:start",
      "writeA:end",
      "writeB:start",
    ]);
  });
});
