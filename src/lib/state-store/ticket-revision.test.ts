import { describe, expect, it } from "vitest";
import {
  nextSharedTicketRevision,
  nextTicketRevision,
} from "./ticket-revision";

describe("ticket revisions", () => {
  it("uses a requested timestamp that is strictly newer", () => {
    expect(
      nextTicketRevision(
        "2026-08-31T12:00:00.000Z",
        "2026-08-31T12:00:01.000Z",
      ),
    ).toBe("2026-08-31T12:00:01.000Z");
  });

  it.each(["2026-08-31T12:00:00.000Z", "2026-08-31T11:59:59.000Z"])(
    "advances one millisecond for equal or regressed request %s",
    (request) => {
      expect(nextTicketRevision("2026-08-31T12:00:00.000Z", request)).toBe(
        "2026-08-31T12:00:00.001Z",
      );
    },
  );

  it("computes one revision that is newer than every affected endpoint", () => {
    expect(
      nextSharedTicketRevision(
        [
          "2026-08-31T12:00:00.000Z",
          "2026-08-31T12:00:03.000Z",
          "2026-08-31T12:00:02.000Z",
        ],
        "2026-08-31T12:00:01.000Z",
      ),
    ).toBe("2026-08-31T12:00:03.001Z");
  });

  it("rejects missing current revisions and malformed timestamps", () => {
    expect(() =>
      nextSharedTicketRevision([], "2026-08-31T12:00:00.000Z"),
    ).toThrow();
    expect(() => nextTicketRevision("not-a-date", "also-not-a-date")).toThrow();
  });
});
