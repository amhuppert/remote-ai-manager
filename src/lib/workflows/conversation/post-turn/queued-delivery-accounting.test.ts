import { describe, it, expect, vi } from "vitest";
import { createQueuedDeliveryAccounting } from "./queued-delivery-accounting";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const identity = {
  projectPath: "/p",
  sessionName: "s",
  conversationId: "conv-1",
};

const queuedDelivery = {
  messageIds: ["m1", "m2"],
  deliveryAttemptId: "attempt-1",
};

function makeDeps() {
  return {
    markQueuedDelivered: vi.fn(async () => {}),
    markQueuedPending: vi.fn(async () => {}),
  };
}

describe("createQueuedDeliveryAccounting — normal turns", () => {
  it("appends the user entry at dispatch and never touches queue marks", async () => {
    const deps = makeDeps();
    const appendUserEntry = vi.fn(async () => {});
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery: undefined,
      appendUserEntry,
    });

    await accounting.appendUserEntryAtDispatch();
    await accounting.handleInputAccepted();
    await accounting.settleAfterTurn();

    expect(appendUserEntry).toHaveBeenCalledTimes(1);
    expect(deps.markQueuedDelivered).not.toHaveBeenCalled();
    expect(deps.markQueuedPending).not.toHaveBeenCalled();
  });
});

describe("createQueuedDeliveryAccounting — queued turns", () => {
  it("defers the append to acceptance, then marks the batch delivered", async () => {
    const deps = makeDeps();
    const order: string[] = [];
    const appendUserEntry = vi.fn(async () => {
      order.push("append");
    });
    deps.markQueuedDelivered.mockImplementation(async () => {
      order.push("delivered");
    });
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry,
    });

    await accounting.appendUserEntryAtDispatch();
    expect(appendUserEntry).not.toHaveBeenCalled();

    await accounting.handleInputAccepted();

    expect(order).toEqual(["append", "delivered"]);
    expect(deps.markQueuedDelivered).toHaveBeenCalledWith({
      ...identity,
      ids: ["m1", "m2"],
      deliveryAttemptId: "attempt-1",
    });
  });

  it("appends exactly once when input_accepted fires repeatedly", async () => {
    const deps = makeDeps();
    const appendUserEntry = vi.fn(async () => {});
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry,
    });

    await accounting.handleInputAccepted();
    await accounting.handleInputAccepted();

    expect(appendUserEntry).toHaveBeenCalledTimes(1);
    expect(deps.markQueuedDelivered).toHaveBeenCalledTimes(1);
  });

  it("does not re-append when marking delivered fails after the append", async () => {
    const deps = makeDeps();
    const appendUserEntry = vi.fn(async () => {});
    deps.markQueuedDelivered.mockRejectedValueOnce(new Error("db down"));
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry,
    });

    await expect(accounting.handleInputAccepted()).rejects.toThrow("db down");
    await accounting.settleAfterTurn();

    expect(appendUserEntry).toHaveBeenCalledTimes(1);
    // The entry WAS appended, so the batch is never returned to pending.
    expect(deps.markQueuedPending).not.toHaveBeenCalled();
  });

  it("returns the batch to pending when the turn ends without acceptance", async () => {
    const deps = makeDeps();
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry: vi.fn(async () => {}),
    });

    await accounting.settleAfterTurn();

    expect(deps.markQueuedPending).toHaveBeenCalledWith({
      ...identity,
      ids: ["m1", "m2"],
      deliveryAttemptId: "attempt-1",
      error: "queued delivery did not reach backend acceptance",
    });
  });

  it("does not return a successfully delivered batch to pending", async () => {
    const deps = makeDeps();
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry: vi.fn(async () => {}),
    });

    await accounting.handleInputAccepted();
    await accounting.settleAfterTurn();

    expect(deps.markQueuedPending).not.toHaveBeenCalled();
  });

  it("swallows a return-to-pending failure (turn result must not change)", async () => {
    const deps = makeDeps();
    deps.markQueuedPending.mockRejectedValueOnce(new Error("db down"));
    const accounting = createQueuedDeliveryAccounting(deps, {
      ...identity,
      queuedDelivery,
      appendUserEntry: vi.fn(async () => {}),
    });

    await expect(accounting.settleAfterTurn()).resolves.toBeUndefined();
  });
});
