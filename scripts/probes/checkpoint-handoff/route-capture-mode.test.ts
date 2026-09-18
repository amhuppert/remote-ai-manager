import { describe, expect, it } from "vitest";
import { routeCaptureMode } from "./route-capture-mode";

describe("route capture admission disclosure", () => {
  it.each(["tool-disabled", "instruction-only"] as const)(
    "binds the disclosed %s mode without downgrading it",
    (mode) => {
      expect(
        routeCaptureMode({
          eligible: true,
          handoff: { available: true, mode },
        }),
      ).toBe(mode);
    },
  );
  it.each([
    { eligible: false, handoff: { available: true, mode: "instruction-only" } },
    { eligible: true, handoff: { available: false, mode: "instruction-only" } },
    { eligible: true, handoff: { available: true, mode: null } },
    { eligible: true },
  ])("refuses unavailable or invalid capture disclosure", (eligibility) => {
    expect(() => routeCaptureMode(eligibility)).toThrow(/not eligible/);
  });
});
