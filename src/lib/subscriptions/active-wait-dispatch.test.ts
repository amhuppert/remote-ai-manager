import { describe, expect, it } from "vitest";
import { decideWakeDispatch } from "./active-wait-dispatch";

describe("active wait queue handoff", () => {
  it("distinguishes an unattempted reservation from a lost queue receipt", () => {
    const missing = {
      recipientEligible: true,
      accepted: false,
      queueStatus: null,
    };
    expect(decideWakeDispatch("planned", missing)).toBe("enqueue");
    expect(decideWakeDispatch("queued", missing)).toBe("uncertain");
    expect(decideWakeDispatch("failed", missing)).toBe("uncertain");
  });

  it("releases an uncertain wake of follow facts only that never reached the queue, and keeps a wait's for review", () => {
    const missing = { recipientEligible: true, accepted: false, queueStatus: null };
    expect(decideWakeDispatch("uncertain", missing, { followOnly: true })).toBe("release");
    expect(decideWakeDispatch("uncertain", missing, { followOnly: false })).toBe("uncertain");
    expect(decideWakeDispatch("uncertain", { ...missing, queueStatus: "uncertain" }, { followOnly: true })).toBe(
      "uncertain",
    );
    expect(decideWakeDispatch("queued", missing, { followOnly: true })).toBe("uncertain");
  });

  it("repairs acceptance after a crash without replaying input or equating source completion with action", () => {
    expect(
      decideWakeDispatch("queued", {
        recipientEligible: true,
        accepted: true,
        queueStatus: null,
      }),
    ).toBe("accepted");
    expect(
      decideWakeDispatch("uncertain", {
        recipientEligible: false,
        accepted: true,
        queueStatus: "uncertain",
      }),
    ).toBe("accepted");
  });

  it("leaves held recipients and in-flight input alone, while recognizing a reviewed retry", () => {
    expect(
      decideWakeDispatch("planned", {
        recipientEligible: false,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("queued", {
        recipientEligible: true,
        accepted: false,
        queueStatus: "delivering",
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("uncertain", {
        recipientEligible: true,
        accepted: false,
        queueStatus: "pending",
      }),
    ).toBe("drain");
  });

  it("retains failed and uncertain input for explicit review and honors discards", () => {
    for (const queueStatus of ["failed", "uncertain", "cancelled"] as const)
      expect(
        decideWakeDispatch("queued", {
          recipientEligible: true,
          accepted: false,
          queueStatus,
        }),
      ).toBe(queueStatus);
    expect(
      decideWakeDispatch("accepted", {
        recipientEligible: true,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("cancelled", {
        recipientEligible: true,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
  });
});
