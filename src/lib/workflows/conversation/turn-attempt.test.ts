import { expect, it, vi } from "vitest";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { TurnAttempt } from "./turn-attempt";

function createAttempt() {
  return new TurnAttempt({
    conversationId: "attempt-test",
    isCurrent: () => true,
    onCancel: () => {},
    closeRuntime: async () => {},
  });
}

it("retains a typed backend admission refusal before dispatch", async () => {
  const attempt = createAttempt();
  const refusal = new BackendAdmissionError({
    backend: "claude",
    operation: "task-run",
    code: "backend-catalog-unavailable",
    message: "Catalog unavailable",
  });
  await expect(
    attempt.track(async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  await attempt.settle();
  attempt.complete({
    status: "awaiting",
    pendingQuestion: null,
    lastError: refusal.message,
  });
  expect((await attempt.completed).outcome).toMatchObject({
    kind: "not_started",
    reason: "backend_admission",
    admission: refusal.refusal,
  });
});

/**
 * A conversation actor restored at startup prepares its turn with startup
 * code, so the errors it reports into a route-made attempt are instances of
 * that bundle's copies of their classes. Copies with the same name stand in.
 */
it.each([
  {
    name: "QuerySlotAdmissionTimeoutError",
    fields: { code: "QUERY_SLOT_ADMISSION_TIMEOUT" },
    expected: { reason: "query_slot_timeout" },
  },
  {
    name: "BackendAdmissionError",
    fields: {
      code: "backend-catalog-unavailable",
      refusal: {
        backend: "claude",
        operation: "task-run",
        code: "backend-catalog-unavailable",
        message: "Catalog unavailable",
      },
    },
    expected: {
      reason: "backend_admission",
      admission: { code: "backend-catalog-unavailable" },
    },
  },
])(
  "records a $name thrown by startup code's copy of its class as what it is",
  async ({ name, fields, expected }) => {
    const attempt = createAttempt();
    const thrown = Object.assign(new Error(`${name} raised`), fields, {
      name,
    });
    await expect(
      attempt.track(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await attempt.settle();
    attempt.complete({
      status: "awaiting",
      pendingQuestion: null,
      lastError: thrown.message,
    });
    expect((await attempt.completed).outcome).toMatchObject({
      kind: "not_started",
      ...expected,
    });
  },
);

it("retains required receipt failure and still finishes every cleanup", async () => {
  const attempt = createAttempt();
  const release = vi.fn();
  const laterReceipt = vi.fn(async () => {});
  attempt.ownReceipt(async () => {
    throw new Error("Receipt unavailable");
  });
  attempt.ownReceipt(laterReceipt);
  attempt.ownRelease(release);
  await attempt.settle();
  attempt.complete({
    status: "awaiting",
    pendingQuestion: null,
    lastError: null,
  });
  expect((await attempt.completed).outcome).toMatchObject({
    kind: "settlement_failed",
    code: "delivery_receipt",
    message: "Receipt unavailable",
  });
  expect(release).toHaveBeenCalledOnce();
  expect(laterReceipt).toHaveBeenCalledOnce();
});

it("refuses live receipt enrollment once settlement has started", async () => {
  const attempt = createAttempt();
  const receipt = vi.fn(async () => {});
  expect(attempt.tryOwnLiveReceipt(receipt)).toBe(true);
  const settled = attempt.settle();
  expect(attempt.tryOwnLiveReceipt(receipt)).toBe(false);
  await settled;
  expect(receipt).toHaveBeenCalledOnce();
});

it("retains a close a receipt requested as owned close work and retries it on reconcile", async () => {
  let closeFails = true;
  const closeRuntime = vi.fn(async () => {
    if (closeFails) throw new Error("provider teardown hung");
  });
  const attempt = new TurnAttempt({
    conversationId: "attempt-test",
    isCurrent: () => true,
    onCancel: () => {},
    closeRuntime,
  });
  // A checkpoint delivery that never sent settles its runtime from inside
  // its receipt, before it can release the seed.
  const receipt = vi.fn(async () => {
    await attempt.closeBackend();
  });
  attempt.ownReceipt(receipt);
  await attempt.settle();
  expect(attempt.hasUnreconciledWork).toBe(true);
  expect(attempt.requiresCloseRetry).toBe(true);
  attempt.complete({
    status: "awaiting",
    pendingQuestion: null,
    lastError: null,
  });
  expect((await attempt.completed).outcome).toMatchObject({
    kind: "settlement_failed",
    code: "runtime_close",
  });

  closeFails = false;
  await attempt.reconcile();
  expect(attempt.hasUnreconciledWork).toBe(false);
  expect(attempt.requiresCloseRetry).toBe(false);
  expect(receipt).toHaveBeenCalledTimes(2);
});
