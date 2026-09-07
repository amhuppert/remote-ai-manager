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
