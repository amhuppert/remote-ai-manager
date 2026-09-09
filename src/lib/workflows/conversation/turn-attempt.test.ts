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
