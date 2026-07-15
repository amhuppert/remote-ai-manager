import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./format-relative-time";

const base = Date.parse("2026-06-14T00:00:00.000Z");

describe("formatRelativeTime", () => {
  describe("long style (default)", () => {
    it("returns 'just now' under a minute", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", { now: base + 30_000 }),
      ).toBe("just now");
    });

    it("returns minutes ago", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          now: base + 5 * 60_000,
        }),
      ).toBe("5m ago");
    });

    it("returns hours ago", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          now: base + 3 * 3_600_000,
        }),
      ).toBe("3h ago");
    });

    it("returns days ago", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          now: base + 2 * 86_400_000,
        }),
      ).toBe("2d ago");
    });
  });

  describe("short style", () => {
    it("returns 'now' under a minute", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          style: "short",
          now: base + 30_000,
        }),
      ).toBe("now");
    });

    it("returns compact minutes", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          style: "short",
          now: base + 5 * 60_000,
        }),
      ).toBe("5m");
    });

    it("returns compact hours", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          style: "short",
          now: base + 3 * 3_600_000,
        }),
      ).toBe("3h");
    });

    it("returns compact days", () => {
      expect(
        formatRelativeTime("2026-06-14T00:00:00.000Z", {
          style: "short",
          now: base + 2 * 86_400_000,
        }),
      ).toBe("2d");
    });
  });

  it("defaults now to the current clock", () => {
    const iso = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("2m ago");
  });
});
