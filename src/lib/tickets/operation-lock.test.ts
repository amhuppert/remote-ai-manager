import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createTicketOperationLock,
  ticketOperationKey,
} from "./operation-lock";

const KEY = ticketOperationKey("/repos/demo", 7);
const TICKET_ID = "ticket-uuid-1";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ticketOperationKey", () => {
  it("is stable per project path and number", () => {
    expect(ticketOperationKey("/repos/demo", 7)).toBe(
      ticketOperationKey("/repos/demo", 7),
    );
    expect(ticketOperationKey("/repos/demo", 7)).not.toBe(
      ticketOperationKey("/repos/demo", 8),
    );
    expect(ticketOperationKey("/repos/demo", 7)).not.toBe(
      ticketOperationKey("/repos/other", 7),
    );
  });
});

describe("createTicketOperationLock", () => {
  it("grants a start hold when the key is free and refuses a concurrent start", () => {
    const lock = createTicketOperationLock();

    const hold = lock.tryAcquireStart(KEY);
    expect(hold).not.toBeNull();
    expect(lock.tryAcquireStart(KEY)).toBeNull();

    hold?.release();
    expect(lock.tryAcquireStart(KEY)).not.toBeNull();
  });

  it("release is idempotent", () => {
    const lock = createTicketOperationLock();
    const hold = lock.tryAcquireStart(KEY);
    hold?.release();
    hold?.release();
    const again = lock.tryAcquireStart(KEY);
    expect(again).not.toBeNull();
    again?.release();
  });

  it("tracks the bound ticket id while the start holds the lock", async () => {
    const lock = createTicketOperationLock();
    expect(lock.isTicketStartActive(TICKET_ID)).toBe(false);
    await expect(
      lock.onTicketStartReleased(TICKET_ID),
    ).resolves.toBeUndefined();

    const hold = lock.tryAcquireStart(KEY);
    hold?.bindTicketId(TICKET_ID);
    expect(lock.isTicketStartActive(TICKET_ID)).toBe(true);

    let released = false;
    const waiter = lock.onTicketStartReleased(TICKET_ID).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    hold?.release();
    await waiter;
    expect(released).toBe(true);
    expect(lock.isTicketStartActive(TICKET_ID)).toBe(false);
  });

  it("runExclusive waits for a held start before running", async () => {
    const lock = createTicketOperationLock();
    const hold = lock.tryAcquireStart(KEY);
    const order: string[] = [];

    const exclusive = lock.runExclusive(KEY, async () => {
      order.push("exclusive");
      return "done";
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    order.push("release");
    hold?.release();
    await expect(exclusive).resolves.toBe("done");
    expect(order).toEqual(["release", "exclusive"]);
  });

  it("a start attempted while an exclusive operation runs is refused", async () => {
    const lock = createTicketOperationLock();
    const gate = deferred();
    const exclusive = lock.runExclusive(KEY, async () => {
      await gate.promise;
    });

    expect(lock.tryAcquireStart(KEY)).toBeNull();
    gate.resolve();
    await exclusive;
    expect(lock.tryAcquireStart(KEY)).not.toBeNull();
  });

  it("queued exclusive operations run one at a time in order", async () => {
    const lock = createTicketOperationLock();
    const first = deferred();
    const order: string[] = [];

    const a = lock.runExclusive(KEY, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = lock.runExclusive(KEY, async () => {
      order.push("b");
    });

    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("releases the key when the exclusive operation throws", async () => {
    const lock = createTicketOperationLock();
    await expect(
      lock.runExclusive(KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.tryAcquireStart(KEY)).not.toBeNull();
  });

  it("keys are independent", () => {
    const lock = createTicketOperationLock();
    const hold = lock.tryAcquireStart(KEY);
    expect(hold).not.toBeNull();
    expect(
      lock.tryAcquireStart(ticketOperationKey("/repos/demo", 8)),
    ).not.toBeNull();
  });
});
