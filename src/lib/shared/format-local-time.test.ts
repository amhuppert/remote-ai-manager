import { describe, expect, it } from "vitest";

import { formatLocalTime } from "./format-local-time";

// Pinned locale + zone keep assertions independent of the runner's environment.
const display = { locale: "en-US", timeZone: "America/New_York" } as const;
const now = Date.parse("2026-06-14T18:00:00.000Z"); // 2:00 PM in New York

describe("formatLocalTime", () => {
  it("renders a same-day timestamp as a bare local clock time", () => {
    expect(
      formatLocalTime("2026-06-14T19:42:00.000Z", { ...display, now }),
    ).toBe("3:42 PM");
  });

  it("converts into the viewer's zone rather than echoing UTC", () => {
    // Same instant as the case above (19:42 UTC), read from a different zone.
    expect(
      formatLocalTime("2026-06-14T19:42:00.000Z", {
        ...display,
        timeZone: "Europe/Berlin",
        now,
      }),
    ).toBe("9:42 PM");
  });

  it("prefixes a compact date once the timestamp is not today", () => {
    expect(
      formatLocalTime("2026-06-11T19:42:00.000Z", { ...display, now }),
    ).toBe("Jun 11, 3:42 PM");
  });

  it("compares calendar days in the display zone, not UTC", () => {
    // 01:30Z on the 15th is still 9:30 PM on the 14th in New York, so a viewer
    // there should see no date prefix.
    expect(
      formatLocalTime("2026-06-15T01:30:00.000Z", { ...display, now }),
    ).toBe("9:30 PM");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatLocalTime("not-a-date", { ...display, now })).toBe("");
  });
});
