import { describe, expect, it } from "vitest";

import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { createPendingEntry } from "@/lib/conversations/message-queue-service";

import { repairableQueuedAcceptance } from "./queued-acceptance";

const FINGERPRINT = "sha256:bound-input";
/** What the provider was actually sent: the seed plus the input. */
const ASSEMBLED = "sha256:seed-and-input";

function row(
  id: string,
  overrides: Partial<PendingQueuedMessage> = {},
): PendingQueuedMessage {
  return {
    ...createPendingEntry({
      id,
      content: [{ type: "text", text: `message ${id}` }],
      now: "2026-09-08T00:00:00.000Z",
    }),
    status: "uncertain",
    deliveryAttemptId: "queue-attempt-1",
    ...overrides,
  };
}

const ACCEPTED = {
  id: "op-1",
  delivery: {
    attemptId: "attempt-a",
    inputFingerprint: ASSEMBLED,
    submittedInputFingerprint: FINGERPRINT,
    queuedAttemptId: "queue-attempt-1",
    queuedMessageId: "m1",
  },
  acceptance: {
    attemptId: "attempt-a",
    seedHash: "sha256:seed",
    acceptedAt: "2026-09-08T00:00:01.000Z",
  },
};

const fingerprintRows = (rows: readonly PendingQueuedMessage[]) =>
  rows.map((entry) => entry.id).join(",") === "m1,m2" ||
  rows.map((entry) => entry.id).join(",") === "m1"
    ? FINGERPRINT
    : "sha256:other";

describe("repairableQueuedAcceptance", () => {
  it("confirms the rows claimed under the bound queued attempt when every durable fact agrees", () => {
    const repair = repairableQueuedAcceptance({
      operation: ACCEPTED,
      queue: [
        row("m1"),
        row("m2", { status: "delivering" }),
        row("m3", { deliveryAttemptId: "queue-attempt-2" }),
      ],
      fingerprintRows,
    });
    expect(repair).toMatchObject({
      messageIds: ["m1", "m2"],
      deliveryAttemptId: "queue-attempt-1",
    });
  });

  it.each([
    ["no acceptance was recorded", { ...ACCEPTED, acceptance: null }],
    [
      "the acceptance names another attempt than the binding",
      {
        ...ACCEPTED,
        acceptance: { ...ACCEPTED.acceptance, attemptId: "attempt-b" },
      },
    ],
    [
      "the delivery was not a queued one",
      {
        ...ACCEPTED,
        delivery: {
          ...ACCEPTED.delivery,
          queuedAttemptId: null,
          queuedMessageId: null,
        },
      },
    ],
  ])("repairs nothing when %s", (_label, operation) => {
    expect(
      repairableQueuedAcceptance({
        operation,
        queue: [row("m1")],
        fingerprintRows,
      }),
    ).toBeNull();
  });

  it("repairs nothing when the rows were claimed under a different queued attempt, or the bound row is absent", () => {
    expect(
      repairableQueuedAcceptance({
        operation: ACCEPTED,
        queue: [row("m1", { deliveryAttemptId: "queue-attempt-2" })],
        fingerprintRows,
      }),
    ).toBeNull();
    expect(
      repairableQueuedAcceptance({
        operation: ACCEPTED,
        queue: [row("m2")],
        fingerprintRows,
      }),
    ).toBeNull();
  });

  it("repairs nothing when the rows no longer fingerprint as the bound input", () => {
    expect(
      repairableQueuedAcceptance({
        operation: ACCEPTED,
        queue: [row("m1"), row("m2"), row("m9")],
        fingerprintRows,
      }),
    ).toBeNull();
  });

  it("ignores rows that already left the queue's ownership", () => {
    expect(
      repairableQueuedAcceptance({
        operation: ACCEPTED,
        queue: [row("m1", { status: "pending", deliveryAttemptId: null })],
        fingerprintRows,
      }),
    ).toBeNull();
  });

  it("matches the submitted-input fingerprint the rows reassemble to, never the assembled prompt the provider saw", () => {
    expect(
      repairableQueuedAcceptance({
        operation: ACCEPTED,
        queue: [row("m1")],
        fingerprintRows: () => ASSEMBLED,
      }),
    ).toBeNull();
  });
});
